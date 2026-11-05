# UI overhaul — implementation plan

Audience: an AI model implementing this step by step. Read `CLAUDE.md` and `docs/TESTING.md` first. Follow them (runes everywhere, Dexie/browser APIs only in `onMount`/`$effect`, `npm run check` must pass with 0 errors, commit + push after every step).

Goal: one dark-mode luxury look across every page, driven by the theme engine that currently only the landing page uses; one shared top bar; model/connection settings moved into a renamed "Studio" drawer; Tailwind v4 for layout and new UI; purposeful motion.

## Decisions already made (do not re-open)

- Tailwind v4 is adopted. New and reworked UI is written with Tailwind utilities mapped to the theme variables. Existing `landing.css` is migrated gradually, not rewritten in one go.
- "Appearance" is renamed **Studio**. It gains a sixth tab, **Model** (tabs: Theme, Background, Layout, Cards, Advanced, Model).
- Studio opens as a **non-blocking right-side drawer** from any page (no dimming backdrop that blocks the page; Esc closes it).
- The search *input* exists **only on the landing page**. The shared top bar everywhere else has no search input. A global **command palette (Ctrl+K)** works on every page.
- `/settings` stays as a route that redirects to Studio's Model tab.
- Dropped from the earlier idea list: live preview strip in Studio.
- No Sync/backend work. Stay inside Phase 1 constraints; everything is client-side.

## Ground rules

1. One step = one commit = pushed. Message: imperative, says what and why. End with `Co-Authored-By: Claude <noreply@anthropic.com>`.
2. After each step run `npm run check` (0 errors). From Step 3 on, also verify visually using the headless-browser scripts in `scripts/` (see `docs/TESTING.md`); take a screenshot of `/`, `/characters`, `/chat/<id>` and fix regressions before committing.
3. Never write synchronous Dexie/`window`/`document`/`localStorage` access at component top level or module top level. Use `onMount`/`$effect`, or guard with `typeof document !== 'undefined'`.
4. Persist with `$state.snapshot`. Change appearance only through `updateAppearance()`, settings only through `saveSettings()`.
5. Respect accessibility: visible keyboard focus, `prefers-reduced-motion`, 4.5:1 text contrast, tap targets ≥ 40px on mobile.
6. Do not add dependencies beyond Tailwind (`tailwindcss`, `@tailwindcss/vite`) and, only if Step 12 needs it, nothing else. Icons stay in the existing `Icon.svelte`.
7. If a step reveals the plan is wrong, stop and write the problem in your report instead of improvising a different architecture.

---

## Phase A — Foundation and theme sync

### Step 1 — Install Tailwind v4
- `npm i -D tailwindcss @tailwindcss/vite`. Confirm the plugin supports the installed Vite (5.x); if not, report instead of upgrading Vite.
- `vite.config.ts`: add `tailwindcss()` before `sveltekit()`.
- Create `src/styles/tailwind.css` containing the Tailwind v4 `@import`s for **theme and utilities only** (do **not** import Preflight yet — it would reset elements that `landing.css` and `app.css` currently rely on). Import it from the root layout before `app.css`.
- Acceptance: a throwaway utility class (e.g. `text-red-500`) works on one element, then remove it. `npm run build` passes. Landing page looks unchanged.

### Step 2 — Rename the theme namespace and make it global
This is the keystone; everything else depends on it.
- Rename CSS variables `--stlp-*` → `--lw-*` in `appearance.ts`, `landing.css`, `AppearancePanel.svelte`, `+page.svelte` and any component using them. Do it with a project-wide search; leave class names `stlp-*` alone for now (renaming classes is optional later).
- `themeStyle()` currently returns an inline style for the `.landing` div, including `background-image`. Split it: `themeVars(a)` (variables only) and keep the background-image part separate.
- Apply variables and root classes to `<html>` instead of `.landing`: in `src/routes/+layout.svelte`, add an `$effect` that sets each variable with `document.documentElement.style.setProperty` and toggles the classes from `rootClasses()` on `document.documentElement` (remove classes it previously added). Remove `style={themeStyle(a)}` and `rootClasses` from `.landing` in `+page.svelte`, but keep landing-only background handling working.
- Flash prevention: after each appearance save, also write a small JSON of the resolved variables to `localStorage` (try/catch, per-viewer cache only). Add an inline script in `src/app.html` `<head>` that reads it and sets the variables on `<html>` before first paint. If the cache is missing, fall back to the default theme in CSS.
- Acceptance: changing a theme in the existing Appearance panel changes `<html>`'s variables; reload shows no color flash; landing unchanged visually.

### Step 3 — Luxury default preset and derived surfaces
- Add preset **"Obsidian & Brass"** to `THEMES` (suggested: bg `#0d0c0a`, accent `#c9a45c` brass, accent2 `#8a6a2f`, text bone `#ece6d8`). Make it the default theme id in `DEFAULT_APPEARANCE`. Keep all existing presets. Existing users with a saved theme keep theirs.
- Add derived tokens computed from `bg` in `themeVars()`: `--lw-surface` (panels), `--lw-surface-2` (raised), `--lw-border`, `--lw-hairline`, `--lw-text`, `--lw-text-dim`, plus `--lw-danger` and `--lw-ok`. Derive by lightening/mixing `bg` toward white (small steps); use `color-mix(in oklab, …)` in CSS where possible instead of JS math. They must work for every preset and for custom/random palettes.
- Rewrite `app.css` `:root` tokens (`--bg`, `--bg-panel`, `--bg-panel-2`, `--border`, `--text`, `--text-dim`, `--accent`, `--accent-2`, `--user-bubble`, `--assistant-bubble`, `--danger`, `--ok`) as **aliases** to the `--lw-*` variables so any page not yet migrated inherits the theme. Delete the old purple values.
- Acceptance: `/characters`, `/settings`, `/chat/<id>` change color when you change the theme in Appearance.

### Step 4 — Tailwind theme mapping and token scale
- In `tailwind.css`, use Tailwind v4 `@theme inline` to map utilities to the live variables: colors `surface`, `surface-2`, `border`, `hairline`, `text`, `dim`, `accent`, `accent-2`, `danger`, `ok`; `rounded-lg` etc. from `--lw-radius`; font families `display` and `body`; durations/easings (`--ease-lw`, 160ms / 280ms / 480ms); elevation shadows `lw-1/2/3`.
- Document the tokens in a short comment block at the top of `tailwind.css` (names only, no prose essay).
- Acceptance: `bg-surface text-text border-border rounded-lg` render correctly and follow theme changes live without re-render.

### Step 5 — Typography
- Add a luxury pair, self-hosted via `@fontsource-variable/*` or `static/fonts` (avoid runtime CDN dependence; offline-first). Suggested: a refined display serif for headings and character names (e.g. Cormorant Garamond or Fraunces) and a quiet sans for UI/chat (e.g. Inter Tight or Manrope). Pick one display + one body; do not add more families. If adding a package, that is the only allowed exception to ground rule 6.
- Add them as new `Appearance.font` options (`luxury` default, keep `system`, `serif`, `rounded`, `mono`). Update the `FONTS` map, the type in `types.ts`, the dropdown in the panel, and make `luxury` the default. Saved rows keep their existing font.
- Define a type scale in `@theme` (xs … 4xl with line-height; serif body gets slightly more line-height than sans). Message text max line length ≈ 70ch.
- Acceptance: headings use display font under `luxury`, body uses sans, switching font in the panel updates every page.

---

## Phase B — Shared top bar

### Step 6 — `AppBar` component
- Create `src/lib/ui/AppBar.svelte`. Rendered by the root layout on **every** route. Delete the old `.nav` markup in the layout and the landing page's own `<header class="stlp-topbar">` (the landing keeps its search input, rendered as a child area under or beside the bar — see below).
- Contents: brand mark (links to `/`), nav links **Home, Characters** (and **Chats** as an anchor to the landing's chats section or the All Chats modal; if that is awkward, omit Chats and report), a **context slot** (Step 7), a **model chip** (Step 19), and the Studio button (gear icon).
- The landing search input appears in the bar's context slot **only when the route is `/`**. Other routes never show a search input.
- Tailwind only. Glass surface using `--lw-blur`, hairline bottom border, sticky, `z-index` above content. The same height and spacing on all routes.
- Layout change: the root layout becomes a flex column (`AppBar` + scrollable main). Remove `height: 100vh` conflicts with the landing page's own scrolling; verify landing scroll, chat scroll, and characters scroll all still work.
- Acceptance: identical bar on `/`, `/characters`, `/chat/<id>`, `/settings`; no duplicate bars.

### Step 7 — Context slot
- `AppBar` exposes a snippet/prop-driven slot. Pages register their contribution through a tiny rune store `src/lib/state/appbar.svelte.ts` (`appbar.title`, `appbar.subtitle`, `appbar.actions`), set in the page's `$effect` and cleared on destroy. (Avoid snippets passed through the layout; SvelteKit layouts cannot receive child-page snippets.)
- Chat page: character name + portrait thumbnail. Characters page: a "New character" button. Landing: the search input.
- Acceptance: navigating between routes updates the slot with no flicker and no stale content.

### Step 8 — Active-route indicator
- A single brass underline element that slides (transform/width transition, ≤ 280ms) between nav items based on the active route. Disabled under reduced motion and when `animations` is off.

### Step 9 — Mobile bottom tab bar
- Under `md` breakpoint: nav moves to a fixed bottom bar (Home, Characters, Chats, Studio); the top bar shrinks to brand + context slot + model chip. Respect `env(safe-area-inset-bottom)`. Add bottom padding to main content so nothing hides behind it.
- Acceptance: at 390×844 no horizontal scroll and nothing overlaps the composer on the chat page.

### Step 10 — Command palette (Ctrl+K)
- `src/lib/ui/CommandPalette.svelte`, mounted once in the root layout. Opens on Ctrl/Cmd+K from any page (including the landing page — the landing's Ctrl+K "focus search" handler is replaced; keep `/` as the key that focuses the landing search).
- Sources (read via the existing `library.svelte.ts` liveQuery, or a lightweight Dexie query when opened): characters (open details/start chat), chats (open), actions (Open Studio, Open Studio → Model, New character, switch theme preset — list each preset). Fuzzy-ish substring match, arrow keys + Enter, Esc closes, focus trap, `role="dialog"` with listbox semantics.
- Acceptance: works on all routes; no Dexie call at module top level.

---

## Phase C — Studio and model settings

### Step 11 — Rename and drawer shell
- Rename `AppearancePanel.svelte` → `src/lib/ui/Studio.svelte`; title "Studio", subtitle "Look, layout and model. Changes save automatically."
- It becomes a right-side drawer (full-width sheet on mobile) with **no blocking backdrop** (page stays interactive so theme changes can be seen), slide-in animation, Esc and a close button. Mount it once in the root layout, controlled by a rune store `src/lib/state/ui.svelte.ts` (`ui.studioOpen`, `ui.studioTab`, `openStudio(tab?)`).
- Remove the landing page's local `showAppearance` state and its gear button; the AppBar's gear calls `openStudio()`.
- Convert the panel's markup to Tailwind as you touch it; delete the matching `.stlp-settings-*` rules from `landing.css` once unused (grep to confirm).
- Acceptance: Studio opens from every page; landing behaves the same otherwise.

### Step 12 — Model tab (sixth tab)
- Add `'model'` to the tab list (last). Fields: API key (password), Base URL, Model. Reuse `saveSettings`. Because it writes to the real `settings` object, use an explicit **Save** button with a "Saved" confirmation (no per-keystroke persistence for secrets), and a "Show key" toggle.
- **Provider presets** as four one-tap cards (OpenAI, Ollama, llama.cpp, KoboldCpp) that fill base URL (and suggest a model placeholder). URLs: `https://api.openai.com/v1`, `http://localhost:11434/v1`, `http://localhost:8080/v1`, `http://localhost:5001/v1`. Highlight the card matching the current base URL.
- Remove the "Common base URLs" list.

### Step 13 — Test connection and model list
- Add `src/lib/models.ts`: `listModels()` calls `GET {baseUrl}/models` with the bearer key, returns `string[]` (OpenAI shape `data[].id`; tolerate Ollama/Kobold variations; return `[]` on unsupported). Keep it behind the same OpenAI-compatible interface.
- Studio Model tab: **Test connection** button → shows one of: reachable (with model count), HTTP error with status, or network failure with this hint: "The browser couldn't reach this URL. For local servers this is usually CORS — for Ollama set `OLLAMA_ORIGINS`." Show a spinner while pending, 8s timeout via `AbortController`.
- **Model picker**: a combobox (input + dropdown of fetched models, still free-typing) populated after a successful test or on tab open (only if base URL is set; fail silently to the plain input).

### Step 14 — `/settings` redirect
- `src/routes/settings/+page.ts` redirects (`throw redirect(307, '/')`) is **not** enough because Studio must open. Instead keep a minimal `+page.svelte` that, in `onMount`, calls `openStudio('model')` and `goto('/', { replaceState: true })`. Remove the old form.
- Acceptance: visiting `/settings` lands on `/` with Studio open on the Model tab.

### Step 15 — Model chip in the top bar
- Shows current model name (truncated) with a status dot: neutral until a test has run this session, green/red after. Click → `openStudio('model')`. Hidden when no model is configured, replaced by "Set up model".

### Step 16 — Per-character model override
- `types.ts`: add optional `model?: string` to `Character`. No Dexie schema version bump (non-indexed field).
- `llm.ts`: `streamChat` gains an optional `model` argument defaulting to `settings.model`. The chat page passes the character's model when set. Do **not** touch `prompt.ts`.
- Characters editor: an optional "Model (leave empty to use the default)" field, with the same fetched-model suggestions.
- Chat header shows the effective model.

---

## Phase D — Page redesigns

### Step 17 — Characters page (two-pane)
- Left: responsive card grid of characters (reuse portrait art; create a shared `CharacterTile` or reuse `CharacterCard` with a prop for size). Right: editor form with a **live card preview** that mirrors name, portrait, description as you type. Mobile: grid first, editor in a slide-over sheet.
- Keep all existing CRUD behavior (create, edit, delete with confirmation, image URL/data URL field). Fields as today plus the model override from Step 16.
- Keyboard: arrow keys across the grid, Enter selects, visible focus.

### Step 18 — Chat view
- Centered message column (~70ch), portrait + name in the header via the AppBar context slot (Step 7), no ALL-CAPS role labels. Assistant messages: character name in the display font above the text. User messages: right-aligned, subtly tinted with the accent. Replace bubbles' heavy borders with hairlines.
- Floating glass composer pinned to the bottom (`--lw-blur`), auto-growing textarea, Enter to send / Shift+Enter newline (keep current behavior), Stop button replaces Send while streaming.
- Do not change `prompt.ts`, message persistence, or the materialized first message.

### Step 19 — Streaming polish
- Soft blinking caret at the end of the streaming assistant message (CSS only), removed when done. A "Jump to latest" pill appears when the user has scrolled up during streaming; auto-scroll only if the user is already at the bottom. Respect reduced motion (static caret).

### Step 20 — Empty states
- Replace blank/plain placeholders with one sentence + one primary action each: no characters ("No characters yet. Create one."), no chats ("No conversations yet. Pick a character to begin."), no model configured in chat ("Add a model to start chatting." → opens Studio → Model), connection failure inside chat (state what failed + "Check connection" → Studio → Model). Errors state the cause and the fix and do not apologize.

---

## Phase E — Motion and polish

### Step 21 — Action-driven card motion
- Character/chat card hover: small lift + accent glow (only if `glow` is on). Opening a character from the grid expands/morphs into the details view (View Transitions API where supported, else a short scale/fade). Buttons confirm presses with a subtle scale. No entrance fade-ins on sections, no hover effects on non-interactive elements.
- All motion durations come from the token scale; all of it is disabled when `animations` is off or the OS reports reduced motion.

### Step 22 — Single orchestrated entrance
- On the landing page only: the hero text and the first row of cards stagger in once per session (use `sessionStorage` in try/catch; skip if present). Nothing else animates on load.

### Step 23 — Reduced motion
- Add a global `@media (prefers-reduced-motion: reduce)` rule that sets all token durations to ~0 and disables ambient orbs, and sync the `animations` flag: if the OS requests reduced motion and the user has never touched the toggle, default `animations` to false.

### Step 24 — Theme-switch crossfade
- When the theme changes, transition `background-color`, `color`, `border-color` on `html` and surfaces over ~300ms (class added briefly during the change, removed afterwards so it doesn't slow every slider drag). Skip when animations are off.

---

## Phase F — Cleanup and verification

### Step 25 — Migrate remaining CSS and enable Preflight
- Convert leftover `app.css` rules (`.panel`, forms, `.msg`, `.composer`, `.chat`) to Tailwind in their components, delete dead rules, then evaluate adding Tailwind Preflight. Only add it if screenshots of every route show no regressions; otherwise keep a small custom reset and note why.
- Grep for unused `stlp-*` rules in `landing.css` and remove them. Do not rename remaining `stlp-*` classes unless trivial.

### Step 26 — Final verification
- `npm run check` (0 errors) and `npm run build`.
- Run the scripts in `scripts/` (navigation and popup checks) and update them if selectors changed (the Appearance button is now the AppBar gear; the settings route now redirects).
- Manual matrix: routes `/`, `/characters`, `/chat/<id>`, `/settings` × viewports 390×844, 768×1024, 1440×900 × presets Obsidian & Brass, Crimson, Monochrome, plus one random palette. Check: same bar everywhere, theme sync, no horizontal scroll, keyboard focus visible, Esc closes Studio and palette, reduced motion honored.
- Update `CLAUDE.md` architecture section (global theme on `<html>`, `--lw-*` variables, Tailwind, AppBar, Studio, command palette, `models.ts`) and `README.md` where they mention Appearance or `/settings`.

## Files likely touched (reference)
`vite.config.ts`, `src/app.html`, `src/app.css`, new `src/styles/tailwind.css`, `src/routes/+layout.svelte`, `src/routes/+page.svelte`, `src/routes/settings/+page.svelte`, `src/routes/characters/+page.svelte`, `src/routes/chat/[id]/+page.svelte`, `src/lib/types.ts`, `src/lib/llm.ts`, `src/lib/state/settings.svelte.ts`, `src/lib/landing/{appearance.ts,landing.css,AppearancePanel.svelte→ui/Studio.svelte}`, new `src/lib/ui/{AppBar,CommandPalette,Studio}.svelte`, new `src/lib/state/{appbar,ui}.svelte.ts`, new `src/lib/models.ts`, `scripts/*.mjs`, `CLAUDE.md`, `README.md`.

## Known risks
- **Flash of default theme** on first paint: handled by the localStorage cache + inline script (Step 2). Treat the cache as optional; the app must work without it.
- **Preflight** can break `landing.css` styling: deliberately deferred to Step 25.
- **Root layout height/scroll** changes in Step 6 can break landing, chat and characters scrolling: verify all three.
- **Model list fetch** may fail for CORS or non-standard servers: must degrade silently to a plain text input.
- **API key** is stored in IndexedDB as before; do not log it or put it in the localStorage theme cache.
