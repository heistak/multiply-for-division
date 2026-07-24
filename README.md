# わり算れんしゅう (Division Sub-Skill Trainer)

Web app that drills the specific sub-skill inside long division:

> **Given divisor _d_ and remainder segment _r_, find the largest _q_ such that _d · q_ ≤ _r_.**

All UI is in Japanese. No accounts, no server; data is kept in `localStorage`.

## Features

- **Progressive deck** — starts with ÷2–5, unlocks ÷6–9 and ÷10–12 as mastery grows.
- **Coverage score (0–1000)** — mastery over the currently-unlocked deck; no right/wrong tally shown.
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
