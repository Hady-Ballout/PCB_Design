# Tinkered teardown — UI adoptions (round 1)

Source: `Tinkeredaipublicsurfaceteardown.pdf` (competitive UI audit, 3 Sep 2026).
Scope agreed with the user: UI only, no palette change, items 2, 3, 4, 7, 8, 9,
10, 11 and 13 from the adoption list. Neo Brutalism (cream paper, black ink,
hard offset shadows, flat yellow/blue/pink/purple accents) stays as is.

## Landing page (`src/features/auth/auth.jsx` HomePage, `auth.css`)

The live home is `HomePage` in `auth.jsx`; `landing/LandingPage.jsx` is unused
and untouched.

- **Header.** A slim sticky bar: the "Impedo" sticker wordmark left; on the
  right one low-contrast text link "Log in" and one solid yellow pill
  "Start building free" (→ `#signup`). Two account affordances, nothing else.
- **Hero typography.** The H1 becomes a display headline sentence
  ("From a sentence to a circuit you can build.") in Archivo Black with
  letter-spacing −0.04em and line-height 0.95. The sticker is now the brand
  chip in the header, so the hero no longer repeats the wordmark.
- **Eyebrows.** `.home-eyebrow` and `.case-tag` become bare mono uppercase
  microtype (JetBrains Mono, 11px, 0.2em tracking). Case tags gain a
  numeral prefix ("01 · SENSORS + DISPLAY"). Pipeline step numerals render as
  "01" … "04" in mono inside their accent circles.
- **Prompt hero.** Below the subtitle, a bordered prompt panel: a textarea
  whose placeholder types itself out, cycling four example builds; bottom-right
  a single "Build this →" pill. Submitting stashes the text in
  `sessionStorage` and routes to `#signup` (or straight into the workspace if
  already signed in). The workspace drains the stash into the chat draft on
  mount. Reduced-motion users see the first example as a static placeholder.
- **Pill CTAs.** `.btn` gets `border-radius: 999px`. Hard shadows stay.

## App shell (`src/app/App.jsx`, `styles.css`)

- **Top bar.** New sticky `header.app-topbar` above the workspace grid:
  brand chip left; centre a segmented pill group replacing the tab-strip
  launchbar, in workflow order Breadboard → Code → 3D PCB with arrow glyphs
  between segments (active segment filled yellow); right side holds the design
  status pill, the simulation Run/Stop slot, and the existing account menu
  (moved from its fixed floating position into the bar, still collapsible).
- **Segmented control.** Reuses `openEditorView`. `EDITOR_VIEW_LABELS` is
  reordered so Breadboard comes first; nothing else in editorConfig changes.
- **Run/Stop in the top bar.** `RealisticSchematic` accepts an optional
  `runControlHost` DOM element and portals its existing Run/Stop button into
  it; without the prop it renders in its toolbar exactly as today (tests
  unchanged). The button turns red (error tokens) while running.
- **Status pill.** Pure helper `designStatus({ issues, pcbLayout })` in
  `src/features/editors/designStatus.js`: `null` when there is no circuit;
  otherwise `{ tone: 'ok' | 'warn' | 'error', label }` — errors or a
  non-fabricable layout → "Issues found" (error tone), warnings only →
  "Warnings" (warn tone), clean → "Checks pass" (ok tone). Rendered as a
  bordered pill in the top bar.

## Out of scope

Palette changes, footer, FAQ, sticky showcase, blueprint frame, library
search, auth card changes, left icon rail. Backend untouched.
