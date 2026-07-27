/* ==========================================================================
   わり算れんしゅう  (Division sub-skill spaced-repetition trainer)
   -------------------------------------------------------------------------- */

'use strict';

// ---------- Deck definition ----------
// A card asks: "given divisor d and dividend segment r,
//               what is the largest q such that d*q <= r ?"
// Progressive tiers: unlocked when mastery of current tier is strong.
// Divisors stop at 9: this is the 4年生 ÷1桁 筆算 sub-skill. ÷10 is a no-op
// (just read the tens digit) and ÷11–12 are an arbitrary slice of the 2-digit
// divisors — those need 仮商 (estimate, test, adjust), a different skill that
// drilling 九九 recall doesn't build. Mastering ÷2〜÷9 is therefore 1000.
const TIERS = [
  { level: 1, divisors: [2, 3, 4, 5],             label: '÷2〜÷5' },
  { level: 2, divisors: [2, 3, 4, 5, 6, 7, 8, 9], label: '÷2〜÷9' },
];
// For each divisor d, r ranges over [d, 10d-1].
// Reason: in real hand-division the "current dividend segment" is
// prev_remainder * 10 + next_digit, and prev_remainder < d always.
// So r ≤ (d-1)*10 + 9 = 10d - 1. This guarantees q ∈ [1, 9].
// (First-step leading-digit cases r ∈ [d, 9] are subsumed by this range.)
function makeCardsFor(divisors) {
  const cards = [];
  for (const d of divisors) {
    for (let r = d; r <= 10 * d - 1; r++) {
      const q = Math.floor(r / d);
      cards.push({ id: `${d}-${r}`, d, r, q, p: d * q, remainder: r - d * q });
    }
  }
  return cards;
}

const ALL_CARDS = makeCardsFor(TIERS[TIERS.length - 1].divisors);
const CARD_BY_ID = Object.fromEntries(ALL_CARDS.map(c => [c.id, c]));

// ---------- State ----------
const STORAGE_KEY = 'wari-v1';
const DEFAULT_STATE = {
  version: 1,
  tier: 1,                        // 1..2
  progress: {},                   // id -> { bucket:0-6, fastStreak:0-N, lastSeenTs:0, everCorrect:false }
  sessions: [],                   // { dateISO:'YYYY-MM-DD', slot:1|2, endedAt:ms, coverageAfter:number }
  recentAnswers: [],              // ring buffer of last 40 { correct:bool, dur:ms, cardId:str }
  settings: { subtract: false },
  streak: { current: 0, lastDay: null },
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    const loaded = { ...structuredClone(DEFAULT_STATE), ...parsed,
             settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
             streak: { ...DEFAULT_STATE.streak, ...(parsed.streak || {}) } };
    // A save from when the deck went up to ÷12 would name a tier that no
    // longer exists; land it on the last real one instead of an invalid state.
    loaded.tier = Math.min(Math.max(1, loaded.tier | 0 || 1), TIERS.length);
    return loaded;
  } catch (e) {
    console.warn('load failed', e);
    return structuredClone(DEFAULT_STATE);
  }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sessionsToday() { return state.sessions.filter(s => s.dateISO === todayISO()); }

// ---------- Card progress helpers ----------
function progressFor(id) {
  if (!state.progress[id]) state.progress[id] = { bucket: 0, fastStreak: 0, lastSeenTs: 0, everCorrect: false };
  return state.progress[id];
}

// Mastery of a single card 0..1
function cardMastery(id) {
  const p = state.progress[id];
  if (!p) return 0;
  const bucketPart = Math.min(p.bucket, 6) / 6;          // 0..1
  const streakPart = Math.min(p.fastStreak, 3) / 3;      // 0..1
  return Math.min(1, bucketPart * 0.7 + streakPart * 0.3);
}

// Coverage 0..1000 over the FULL deck (all divisors 2..9, 396 cards).
// The score's max never changes; unlocking a tier just adds room to grow.
// Finishing tier 1 therefore reads ~318, and finishing tier 2 reads 1000.
function currentDeck() {
  const divisors = TIERS[state.tier - 1].divisors;
  return ALL_CARDS.filter(c => divisors.includes(c.d));
}
function coverageScore() {
  if (ALL_CARDS.length === 0) return 0;
  const sum = ALL_CARDS.reduce((s, c) => s + cardMastery(c.id), 0);
  return Math.round((sum / ALL_CARDS.length) * 1000);
}

// Per-tier mastery 0..1 over just the current tier's deck — used for unlock only.
function currentTierMastery() {
  const deck = currentDeck();
  if (deck.length === 0) return 0;
  return deck.reduce((s, c) => s + cardMastery(c.id), 0) / deck.length;
}

// Should we unlock the next tier?
// Rule: current-tier mastery >= 0.85 AND every card in current tier has everCorrect
function checkTierUnlock() {
  if (state.tier >= TIERS.length) return false;
  if (currentTierMastery() < 0.85) return false;
  const deck = currentDeck();
  const allSeen = deck.every(c => state.progress[c.id]?.everCorrect);
  if (!allSeen) return false;
  state.tier += 1;
  saveState();
  return true;
}

// ---------- Scheduler (within-session Leitner box) ----------
// Each queued card entry: { cardId, dueIndex } — dueIndex counts questions asked.
// After answering question N, the next card is the queued card whose dueIndex <= N,
// chosen by lowest dueIndex, breaking ties by "less recently seen".
// Bucket → gap (in intervening questions):
//   0: 3-4     1: 6-8     2: 12-16     3+: exits current session
const BUCKET_GAP = [3, 7, 14];   // for buckets 0,1,2
function bucketGap(bucket) {
  const base = BUCKET_GAP[Math.min(bucket, BUCKET_GAP.length - 1)];
  return base + Math.floor(Math.random() * 3) - 1; // ±1 jitter
}

class Scheduler {
  constructor() {
    this.queue = [];     // active cards to be re-shown this session
    this.pool = [];      // cards eligible for first introduction this session
    this.qCount = 0;
    this.sessionSeen = new Set();  // card ids seen this session
    this.initPool();
  }

  initPool() {
    const deck = currentDeck();
    // Prioritize: due-carryover (bucket<3), then never-seen, then bucket 3+ (occasional review)
    const dueCarryover = [];
    const newCards = [];
    const highBucket = [];
    for (const c of deck) {
      const p = state.progress[c.id];
      if (!p) newCards.push(c);
      else if (p.bucket < 3) dueCarryover.push(c);
      else highBucket.push(c);
    }
    shuffle(dueCarryover);
    shuffle(newCards);
    shuffle(highBucket);

    // Cards still being learned, due ones first. These drive the session length.
    const primary = dueCarryover.concat(newCards);
    // Mastered cards return as occasional spot-checks — one every REVIEW_EVERY
    // primary cards, capped so they never crowd out actual practice.
    const REVIEW_EVERY = 6;
    const reviews = highBucket.slice(0, Math.ceil(primary.length / REVIEW_EVERY));

    this.pool = [];
    let r = 0;
    for (let i = 0; i < primary.length; i++) {
      this.pool.push(primary[i]);
      if ((i + 1) % REVIEW_EVERY === 0 && r < reviews.length) this.pool.push(reviews[r++]);
    }
    // Whole tier mastered → nothing "primary" left, so practise the mastered
    // cards rather than handing back an empty pool.
    if (this.pool.length === 0) this.pool = highBucket;
  }

  next() {
    this.qCount += 1;
    // Prefer any queued card whose dueIndex <= qCount
    const ready = this.queue.filter(e => e.dueIndex <= this.qCount);
    if (ready.length > 0) {
      // Take the one with smallest dueIndex; ties -> earliest inserted
      ready.sort((a, b) => a.dueIndex - b.dueIndex || a.insertOrder - b.insertOrder);
      const chosen = ready[0];
      this.queue = this.queue.filter(e => e !== chosen);
      return CARD_BY_ID[chosen.cardId];
    }
    // Otherwise pull from pool
    while (this.pool.length > 0) {
      const c = this.pool.shift();
      if (!this.sessionSeen.has(c.id) || Math.random() < 0.5) {
        this.sessionSeen.add(c.id);
        return c;
      }
    }
    // Pool empty, no queued ready → advance to whatever queued card is soonest
    if (this.queue.length > 0) {
      this.queue.sort((a, b) => a.dueIndex - b.dueIndex);
      const chosen = this.queue.shift();
      return CARD_BY_ID[chosen.cardId];
    }
    // Nothing left — refill from deck (edge case for tiny decks / long sessions).
    // Never recurse here: an empty pool would loop forever.
    this.sessionSeen.clear();
    this.initPool();
    if (this.pool.length === 0) return currentCard || ALL_CARDS[0];
    const c = this.pool.shift();
    this.sessionSeen.add(c.id);
    return c;
  }

  // Reschedule after answering
  reschedule(cardId, bucket) {
    if (bucket >= 3) return;  // exits session
    const gap = bucketGap(bucket);
    this.queue.push({ cardId, dueIndex: this.qCount + gap, insertOrder: this.qCount });
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- Answer scoring ----------
// What counts as an automatic answer. Deliberately set above the typical
// response time for this material: fastStreak only advances on a fast answer,
// so a threshold below the median turns the streak into a downward random walk
// and no card can reach full mastery however much it is practised.
const FAST_MS = 6000;

function scoreAnswer(cardId, correct, durMs) {
  const p = progressFor(cardId);
  const fast = correct && durMs < FAST_MS;
  if (!correct) {
    p.bucket = 0;
    p.fastStreak = 0;
  } else {
    if (fast) {
      p.bucket = Math.min(6, p.bucket + 2);
      p.fastStreak = Math.min(10, p.fastStreak + 1);
    } else {
      p.bucket = Math.min(6, p.bucket + 1);
      // fastStreak is deliberately left alone: a correct answer must never move
      // the score backwards. Speed still pays — it earns +2 bucket instead of
      // +1 and is the only thing that advances the streak — a slow correct
      // answer simply doesn't add to it.
    }
    p.everCorrect = true;
  }
  p.lastSeenTs = Date.now();

  state.recentAnswers.push({ correct, dur: durMs, cardId, ts: Date.now() });
  if (state.recentAnswers.length > 40) state.recentAnswers.shift();
  return p.bucket;
}

// ---------- UI ----------
const screens = {
  home: document.getElementById('screen-home'),
  practice: document.getElementById('screen-practice'),
  result: document.getElementById('screen-result'),
  settings: document.getElementById('screen-settings'),
};
function show(name) {
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

// ---------- Home ----------
function renderHome() {
  const score = coverageScore();
  document.getElementById('coverage-number').textContent = score;
  document.getElementById('coverage-fill').style.width = `${score / 10}%`;
  document.getElementById('tier-info').textContent =
    `レベル ${state.tier} ： ${TIERS[state.tier - 1].label}`;
  const today = sessionsToday();
  document.getElementById('dot-1').classList.toggle('done', today.some(s => s.slot === 1));
  document.getElementById('dot-2').classList.toggle('done', today.some(s => s.slot === 2));
  const s = state.streak.current;
  document.getElementById('streak-text').textContent =
    s >= 2 ? `🔥 ${s}日つづけて がんばってるね！` : '';
}

document.getElementById('btn-start').addEventListener('click', () => startSession());
document.getElementById('btn-settings').addEventListener('click', () => { renderSettings(); show('settings'); });

// ---------- Settings ----------
function renderSettings() {
  document.getElementById('opt-subtract').checked = !!state.settings.subtract;
  const deck = currentDeck();
  const covered = deck.filter(c => state.progress[c.id]?.everCorrect).length;
  const tierPct = Math.round(currentTierMastery() * 100);
  const nextTier = state.tier < TIERS.length ? TIERS[state.tier].label : null;
  const rows = [
    `<div class="ls-line ls-main">いま レベル ${state.tier} （${TIERS[state.tier - 1].label}）</div>`,
    `<div class="ls-line">このレベルの もんだい： <b>${covered} / ${deck.length}</b> こたえたことあり</div>`,
    `<div class="ls-line">このレベルの できぐあい： <b>${tierPct}%</b></div>`,
    nextTier
      ? `<div class="ls-line ls-next">85% までできたら つぎのレベル（${nextTier}）へ！</div>`
      : `<div class="ls-line ls-next">最終レベル達成！</div>`,
  ];
  document.getElementById('level-status').innerHTML = rows.join('');
  // Reset the reset-button's two-tap state whenever we re-enter settings
  resetPendingReset();
}
document.getElementById('opt-subtract').addEventListener('change', (e) => {
  state.settings.subtract = e.target.checked; saveState();
});
document.getElementById('btn-back').addEventListener('click', () => { renderHome(); show('home'); });
document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `wari-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (imported && typeof imported === 'object') {
      state = { ...structuredClone(DEFAULT_STATE), ...imported };
      saveState();
      alert('よみこみました！');
      renderSettings();
    }
  } catch (err) { alert('よみこみ失敗: ' + err.message); }
  e.target.value = '';
});
// Two-tap reset: first tap arms the button, second tap within 4s performs the reset.
let resetArmedTimeout = null;
function resetPendingReset() {
  const btn = document.getElementById('btn-reset');
  if (!btn) return;
  btn.textContent = 'ぜんぶ さいしょから';
  btn.classList.remove('armed');
  if (resetArmedTimeout) { clearTimeout(resetArmedTimeout); resetArmedTimeout = null; }
}
document.getElementById('btn-reset').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'もういちどタップで リセット';
    resetArmedTimeout = setTimeout(resetPendingReset, 4000);
    return;
  }
  // Armed → perform reset
  resetPendingReset();
  state = structuredClone(DEFAULT_STATE);
  saveState();
  renderSettings();
});

// ---------- Practice session ----------
// Session duration: 5 min normal, or override via ?dur=SECONDS for debugging.
const SESSION_MS = (() => {
  const p = new URLSearchParams(location.search);
  const s = parseInt(p.get('dur') || '', 10);
  return (s > 0 && s <= 600) ? s * 1000 : 5 * 60 * 1000;
})();
let scheduler, currentCard, sessionStart, timerHandle;
let stage = 'q';   // 'q' = multiplier, 'sub' = subtraction step
let inputBuf = '';
let questionShownAt = 0;
let coverageBefore = 0;
// True from the moment an answer is submitted until the next prompt is ready,
// so taps during the feedback pause can't register as another answer.
let answerLocked = false;
// Each session has a token; queued setTimeouts check it before running so
// stale ones from a previous session cannot mutate the current UI.
let sessionToken = 0;
function currentToken() { return sessionToken; }
function guarded(tok, fn) { return (...args) => { if (tok === sessionToken) fn(...args); }; }

function startSession() {
  sessionToken += 1;                        // invalidate any pending timeouts
  disableInput(false);                      // in case a previous hold left it locked
  scheduler = new Scheduler();
  sessionStart = Date.now();
  coverageBefore = coverageScore();
  // Snap the bar back to empty without animating backwards from the last
  // session's full bar.
  const fill = document.getElementById('practice-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth;                // force reflow so the reset sticks
  fill.style.transition = '';
  show('practice');
  nextQuestion();
  tick();
  timerHandle = setInterval(tick, 250);
}

function tick() {
  const remain = SESSION_MS - (Date.now() - sessionStart);
  if (remain <= 0) return endSession();
  const fill = document.getElementById('practice-progress-fill');
  fill.style.width = `${((SESSION_MS - remain) / SESSION_MS) * 100}%`;
}

function nextQuestion() {
  currentCard = scheduler.next();
  stage = 'q';
  inputBuf = '';
  questionShownAt = performance.now();
  document.getElementById('prompt-r').textContent = currentCard.r;
  document.getElementById('prompt-d').textContent = currentCard.d;
  document.getElementById('eq-d').textContent = currentCard.d;
  document.getElementById('eq-q').textContent = '?';
  document.getElementById('eq-p').textContent = '?';
  document.getElementById('eq-q').classList.remove('filled');
  document.getElementById('eq-p').classList.remove('filled');
  document.getElementById('eq-q').classList.add('active');
  document.getElementById('eq-p').classList.remove('active');
  document.getElementById('card-subtract').style.display = 'none';
  document.getElementById('feedback').textContent = '';
  document.getElementById('feedback').className = 'feedback';
  document.getElementById('card').classList.remove('correct', 'wrong');
  disableInput(false);                  // new prompt is ready — accept taps again
}

// How many digits the current answer can possibly have. With divisors capped
// at 9 this is always 1 (q is 1..9, the remainder is 0..d-1 ≤ 8); it is derived
// from the card rather than hardcoded so a wider deck stays correct.
function answerDigits() {
  if (stage === 'q') return 1;
  return String(currentCard.d - 1).length;
}

let pendingSubmit = null;
function queueSubmit(delay) {
  clearTimeout(pendingSubmit);
  pendingSubmit = setTimeout(() => submitAnswer(), delay);
}

// Keypad handling
document.getElementById('keypad').addEventListener('click', (e) => {
  if (answerLocked) return;             // an answer is already being processed
  const btn = e.target.closest('.key'); if (!btn) return;
  const key = btn.dataset.key;
  const maxDigits = answerDigits();
  if (key === 'del') {
    clearTimeout(pendingSubmit);
    inputBuf = inputBuf.slice(0, -1);
    updateInputDisplay();
    return;
  }
  // Ignore extra taps once the answer is as long as it can be. Without this, a
  // fast double-tap concatenates into a two-digit number and scores as wrong.
  if (inputBuf.length >= maxDigits) return;
  inputBuf += key;
  updateInputDisplay();

  if (inputBuf.length >= maxDigits) {
    queueSubmit(60);                    // complete — brief pause so the digit renders
  } else {
    // Unreachable with the current deck (every answer is one digit). Kept for a
    // two-digit answer, where a leading 1 might still become 10/11: allow a beat
    // for a second digit, but submit at once for a digit that can't be extended.
    queueSubmit(inputBuf === '1' ? 900 : 60);
  }
});

function updateInputDisplay() {
  if (stage === 'q') {
    const q = inputBuf === '' ? '?' : inputBuf;
    document.getElementById('eq-q').textContent = q;
    document.getElementById('eq-q').classList.toggle('filled', inputBuf !== '');
    if (inputBuf !== '') {
      const p = currentCard.d * parseInt(inputBuf, 10);
      document.getElementById('eq-p').textContent = p;
      document.getElementById('eq-p').classList.add('filled');
    } else {
      document.getElementById('eq-p').textContent = '?';
      document.getElementById('eq-p').classList.remove('filled');
    }
  } else if (stage === 'sub') {
    const a = inputBuf === '' ? '?' : inputBuf;
    document.getElementById('sub-ans').textContent = a;
    document.getElementById('sub-ans').classList.toggle('filled', inputBuf !== '');
  }
}

function submitAnswer() {
  // Guard against a second submission for the same question: two taps landing
  // inside the 60ms auto-submit delay, or a tap during the post-answer pause.
  if (answerLocked || inputBuf === '') return;
  answerLocked = true;
  clearTimeout(pendingSubmit);
  const dur = performance.now() - questionShownAt;
  if (stage === 'q') {
    const guess = parseInt(inputBuf, 10);
    const correct = guess === currentCard.q;
    handleResult(correct, dur, currentCard.q, () => {
      if (state.settings.subtract) startSubtractStage();
      else advance();
    });
  } else if (stage === 'sub') {
    const guess = parseInt(inputBuf, 10);
    const correct = guess === currentCard.remainder;
    // Subtraction correctness doesn't change bucket (main skill is the multiple guess),
    // but it does affect fastStreak positively when correct.
    if (correct) {
      const p = progressFor(currentCard.id);
      p.fastStreak = Math.min(10, p.fastStreak + 1);
      saveState();
    }
    handleResult(correct, dur, currentCard.remainder, () => advance(), /*forSub*/ true);
  }
}

const WRONG_HOLD_MS = 5000;   // full duration to sit with the correct answer

function handleResult(correct, dur, expected, thenCb, forSub = false) {
  const card = document.getElementById('card');
  const fb = document.getElementById('feedback');
  disableInput(true);                   // stays locked until the next prompt is ready
  if (correct) {
    card.classList.add('correct');
    fb.textContent = pickPraise();
    fb.className = 'feedback good';
    if (!forSub) {
      const newBucket = scoreAnswer(currentCard.id, true, dur);
      scheduler.reschedule(currentCard.id, newBucket);
      saveState();
    }
    setTimeout(guarded(currentToken(), thenCb), 1000);
  } else {
    card.classList.add('wrong');
    fb.className = 'feedback bad';
    fb.innerHTML = `<div class="wrong-line">
                      <span class="wrong-small">正しくは</span>
                      <span class="wrong-big">${expected}</span>
                      <span class="wrong-small">だよ</span>
                    </div>
                    <div class="wait-ring"><div class="wait-ring-fill"></div></div>`;
    if (!forSub) {
      const newBucket = scoreAnswer(currentCard.id, false, dur);
      scheduler.reschedule(currentCard.id, newBucket);
      saveState();
    }
    if (!forSub) {
      document.getElementById('eq-q').textContent = expected;
      document.getElementById('eq-p').textContent = currentCard.d * expected;
    } else {
      document.getElementById('sub-ans').textContent = expected;
    }
    // Hold on the correct answer, ignoring taps, so it has time to sink in
    setTimeout(guarded(currentToken(), thenCb), WRONG_HOLD_MS);
  }
}

function disableInput(off) {
  answerLocked = off;
  document.getElementById('keypad').style.pointerEvents = off ? 'none' : '';
  document.getElementById('keypad').style.opacity = off ? '0.4' : '';
}

function startSubtractStage() {
  stage = 'sub';
  inputBuf = '';
  questionShownAt = performance.now();
  document.getElementById('card-subtract').style.display = 'flex';
  document.getElementById('sub-r').textContent = currentCard.r;
  document.getElementById('sub-p').textContent = currentCard.d * currentCard.q;
  document.getElementById('sub-ans').textContent = '?';
  document.getElementById('sub-ans').classList.remove('filled');
  document.getElementById('feedback').textContent = '';
  document.getElementById('feedback').className = 'feedback';
  document.getElementById('card').classList.remove('correct', 'wrong');
  disableInput(false);                  // subtraction prompt ready — accept taps
}

function advance() {
  if (Date.now() - sessionStart >= SESSION_MS) return endSession();
  const card = document.getElementById('card');
  card.classList.add('fading-out');
  const tok = currentToken();
  setTimeout(guarded(tok, () => {
    card.classList.remove('fading-out', 'correct', 'wrong');
    card.classList.add('fading-in');
    nextQuestion();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      card.classList.remove('fading-in');
    }));
  }), 180);
}

const PRAISE = ['せいかい！', 'いいね！', 'ばっちり！', 'すごい！', 'その調子！', 'よくできた！'];
function pickPraise() { return PRAISE[Math.floor(Math.random() * PRAISE.length)]; }

function endSession() {
  sessionToken += 1;                        // invalidate any pending fade/hold timeouts
  clearInterval(timerHandle);
  timerHandle = null;
  disableInput(false);
  const today = todayISO();
  const todaySessions = state.sessions.filter(s => s.dateISO === today);
  const slot = todaySessions.length === 0 ? 1 : todaySessions.length === 1 ? 2 : (todaySessions.length + 1);
  const coverageAfter = coverageScore();
  state.sessions.push({ dateISO: today, slot, endedAt: Date.now(), coverageAfter });
  updateStreak();
  const unlocked = checkTierUnlock();
  saveState();
  renderResult(coverageAfter, unlocked);
  show('result');
}

function updateStreak() {
  const today = todayISO();
  const last = state.streak.lastDay;
  if (last === today) return;
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  if (last === yesterday) state.streak.current += 1;
  else state.streak.current = 1;
  state.streak.lastDay = today;
}

function renderResult(coverageAfter, tierUnlocked) {
  const delta = coverageAfter - coverageBefore;
  document.getElementById('result-coverage').textContent = coverageAfter;
  document.getElementById('result-fill').style.width = `${coverageAfter / 10}%`;
  const deltaEl = document.getElementById('result-delta');
  if (delta > 0) { deltaEl.textContent = `+${delta} アップ！`; deltaEl.className = 'coverage-delta'; }
  else if (delta < 0) { deltaEl.textContent = `${delta}`; deltaEl.className = 'coverage-delta zero'; }
  else { deltaEl.textContent = 'そのまま — また練習しよう'; deltaEl.className = 'coverage-delta zero'; }

  let note = '';
  if (tierUnlocked) {
    note = `🎉 レベル ${state.tier} かいほう！ ${TIERS[state.tier - 1].label} に ちょうせん！`;
  } else if (coverageAfter >= 1000) {
    note = 'マスター！ すごい！';
  } else if (state.tier < TIERS.length && currentTierMastery() >= 0.7) {
    // Gauge this on the current tier, not the overall score: unlocking uses
    // tier mastery, and the overall score can't even reach 850 during tier 1.
    note = 'もうすこしで レベルアップ！';
  } else {
    note = 'まいにち つづけると どんどん おぼえるよ';
  }
  document.getElementById('result-note').textContent = note;

  const today = sessionsToday();
  document.getElementById('result-dot-1').classList.toggle('done', today.some(s => s.slot === 1));
  document.getElementById('result-dot-2').classList.toggle('done', today.some(s => s.slot === 2));
}

document.getElementById('btn-home').addEventListener('click', () => { renderHome(); show('home'); });

// ---------- Init ----------
renderHome();
show('home');

// Prevent double-tap zoom on iOS
let lastTap = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTap < 300) e.preventDefault();
  lastTap = now;
}, { passive: false });

// Register service worker if available (progressive enhancement)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
