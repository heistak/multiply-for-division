# わり算れんしゅう (Division Sub-Skill Trainer)

Web app that drills the specific sub-skill inside long division:

> **Given divisor _d_ and remainder segment _r_, find the largest _q_ such that _d · q_ ≤ _r_.**

All UI is in Japanese. No accounts, no server; data is kept in `localStorage`.

Divisors run 2–9 and _r_ ranges over `[d, 10d-1]` — exactly the states that occur
in 4年生 ÷1桁 筆算, since the previous remainder is always < _d_. That is 9·_d_
cards per divisor, 396 in total. ÷10 is excluded as a no-op (just read the tens
digit) and ÷11–12 because 2-digit divisors need 仮商 — estimate, test, adjust —
which is a different skill from the 九九 recall this drills.

## Features

- **Progressive deck** — starts with ÷2–5, unlocks ÷6–9 as mastery grows. 396 cards.
- **Coverage score (0–1000)** — mastery over the full deck, so the ceiling never
  moves; no right/wrong tally is shown. Finishing tier 1 reads ~318, tier 2 reads 1000.
- **Within-session Leitner scheduling** — wrong or new cards reappear a few questions later; correct/fast cards drift out.
- **5-minute sessions**, two per day tracked as dots on the home screen.
- **Optional subtraction step** (off by default): after the multiplication, asks _r − d·q = ?_
- **Offline-capable PWA** — installable to home screen on tablets/phones.
- **Backup / restore** JSON export so progress survives clearing browser data.

## Running locally

Just open `index.html` in a browser, or serve the directory:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000/

## Hosting on GitHub Pages

```bash
gh repo create <name> --public --source=. --push
gh api -X POST /repos/<owner>/<name>/pages -f 'build_type=workflow' -f 'source[branch]=main' -f 'source[path]=/'
```

The app is a static site, no build step.

## Files

- `index.html` — markup for all four screens
- `style.css` — styles, dark theme, responsive & touch-tuned
- `app.js` — scheduler, scoring, persistence, UI wiring
- `manifest.json`, `icon.svg`, `sw.js` — PWA shell
