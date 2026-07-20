---
name: verify
description: Build/launch/drive recipe for verifying PCB Pilot frontend changes at the browser surface.
---

# Verifying PCB Pilot changes

## Launch

- `npm run dev` runs web (vite, 127.0.0.1:5174) + API (tsx, 8787). The user often
  already has it running — probe first: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174`.
  Starting `npm run dev:web` when 5174 is taken fails (`--strictPort`); just reuse
  the running server — vite serves the current working tree with HMR, no restart needed.
- Frontend-only changes verify fine against the already-running server. The API is
  needed for auth/generation; a logged-in session (`pcb_token` in localStorage) is
  usually already present in the user's browser.

## Drive (Claude in Chrome)

- Public home page: `http://127.0.0.1:5174/#home` (no auth). Workspace: `/` (needs token).
- Screenshot pixel coordinates ≠ CSS pixel coordinates here (Windows 125% scaling:
  screenshots are ~1.25× the CSS viewport). Don't do pixel math against
  `getBoundingClientRect()` — use `find` + click by ref, and `javascript_tool`
  with `getComputedStyle` / `elementFromPoint` for assertions.
- Occasional `Page.captureScreenshot` CDP timeouts on this machine — retry once
  before concluding the renderer is stuck.

## Gotchas

- Test suite has one known pre-existing failure (pcbGenerator "lays out MCU
  circuits") — not a signal about your change.
- Theme state: `localStorage['pcb_theme']` + `<html data-theme>`; index.html sets
  it pre-paint, `src/app/theme.js` owns the rules.
