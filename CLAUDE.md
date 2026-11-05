# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What LoreWeaver is

An immersive AI character platform for roleplay/storytelling (inspired by SillyTavern), planned as: offline-first web app → self-hosted sync server → Tauri desktop + Capacitor mobile shells. Only Phase 1 (the MVP spine) exists today: everything runs client-side in the browser with no backend.

A full SillyTavern source copy lives at `reference/SillyTavern-1.18.0/` for reference when porting features (backgrounds, characters, prompts, extensions). Read from it; never edit it, and never import from it into `src/`.

## Commands

```bash
npm install        # first time
npm run dev        # dev server at http://localhost:5173
npm run build      # production build
npm run preview    # serve the production build
npm test           # Vitest unit tests (pure modules only, src/**/*.test.ts)
npm run check      # type check (svelte-kit sync + svelte-check) — run this after changes
```

`npm run check` (0 errors, 0 warnings) and `npm test` are the verification gates; run both after changes before considering work done. There is no linter yet. Vitest is configured by a standalone `vitest.config.ts` (node environment, no SvelteKit plugin), so unit tests cover pure modules only — anything touching Dexie or the DOM is verified with a headless-browser check instead. For how to run those, read `docs/TESTING.md`.

## Git workflow

- **Commit and push frequently.** Commit each logical change as soon as it passes `npm run check`, rather than batching a session's work into one commit. Keep commits small enough that each one can be understood and reverted on its own.
- **Push after every commit** to `origin` so work is never only on one machine. Don't leave commits unpushed at the end of a session.
- Write commit messages that say what changed and why, in the imperative mood (e.g. `Fix layout calling IndexedDB during SSR`).

## Architecture

Single SvelteKit app (Svelte 5, runes mode, TypeScript). All persistence is client-side IndexedDB via Dexie. The layering:

1. **`src/lib/types.ts`** — the domain vocabulary (`Character`, `Chat`, `ChatMessage`, `Settings`). Everything downstream speaks these types.
2. **`src/lib/db.ts`** — Dexie schema (tables: characters, chats, messages, settings, lorebooks, lorebookEntries). This is the future sync boundary: Phase 3 syncs these tables to the personal server.
3. **`src/lib/state/settings.svelte.ts`** — reactive singleton using runes-in-module (`$state` in a `.svelte.ts` file). Pattern: read `settings.x` reactively anywhere; mutate only through `saveSettings()` so changes persist to the Dexie `settings` row (singleton keyed `id: 1`).
4. **`src/lib/prompt.ts` — the extension seam.** `buildPromptMessages()` assembles the API message array from a character card + history. All SillyTavern-style context features (personas, lorebooks/world-info, prompt presets, author's notes) belong here as additional messages injected into this array — not scattered elsewhere. Lorebooks are the first feature on this seam: `src/lib/lorebook.ts` (pure activation engine, a port of ST's world-info.js), `src/lib/lorebook-import.ts` (format converters + Dexie save), and `src/lib/lorebook-sources.ts` (the four source pools — global/chat/persona/character — plus evaluation) produce a `LorebookInjection` that the chat route passes into `buildPromptMessages()`. Phase 1 has no import UI: dev builds expose `__lw.importLorebook()` / `__lw.previewPrompt()` on the console (see `src/routes/+layout.svelte`).
5. **`src/lib/llm.ts`** — `streamChat()` talks to any OpenAI-compatible endpoint via SSE (`/chat/completions`, `stream: true`), parsing `data:` chunks manually. Provider switching (OpenAI / Ollama / llama.cpp / KoboldCpp) is purely base-URL + model in settings; no code forks per provider. New providers should stay behind this single OpenAI-compatible interface unless truly impossible.
6. **`src/routes/`** — `/` is the landing page (`src/lib/landing/`: My Chats carousel, character grid, character details, "View all"). `/chat/[id]` is the conversation (streaming, stop). `/characters` (card CRUD) is the other page; `/settings` opens the Model drawer. `src/routes/+layout.svelte` mounts the shared pieces on every route: the AppBar (`src/lib/ui/AppBar.svelte`, with the model chip and the mobile tab bar), the Studio drawer (`src/lib/ui/Studio.svelte`, look/layout, opened with `openStudio()`), the Model drawer (`src/lib/ui/ModelDrawer.svelte`, provider/API key/connection, opened with `openModel()`), and the Ctrl+K command palette (`src/lib/ui/CommandPalette.svelte`). Pages fill the bar's title, search and actions through `src/lib/state/appbar.svelte.ts`.
7. **Landing page (`src/lib/landing/`)** — ported from the SillyTavern "Landing Page" extension. Its data comes from `library.svelte.ts`, a Dexie `liveQuery`, so the page updates when the database changes. Appearance settings live in the `settings.appearance` block; change them with `updateAppearance()`, not by writing the object directly. Theme presets and derived tokens are in `appearance.ts`. The layout writes the `--lw-*` variables and the `stlp-*` root classes on `<html>`, so every route follows the theme; the resolved theme is cached in localStorage and applied by an inline script in `app.html` before first paint. Tailwind v4 utilities map onto the `--lw-*` variables in `src/styles/tailwind.css`; new UI uses Tailwind, and `landing.css` is being migrated gradually. Model discovery (`GET {baseUrl}/models`, connection test) lives in `src/lib/models.ts`.

   **Background image** — bundled images live in `static/backgrounds/` (served at `/backgrounds/…`); the originals are kept in `assets/backgrounds/` (not served). Studio → Background → Image picks one (search/sort/fitting) or takes a pasted URL, storing `bgImageUrl` + `bgFit` in appearance. The image renders only on `/`, in a fixed `.lw-bg-image` layer behind the `.landing` content — it is *not* applied to other routes (chat/characters keep the solid `--lw-bg`).

### Invariants and gotchas

- **First message is materialized, not injected.** When a chat is created, `character.firstMessage` is written as a real assistant message into history. `prompt.ts` never special-cases it. Don't add firstMessage at prompt time or it will be sent twice.
- **History never contains `system` rows**; `buildPromptMessages` skips them defensively, but the system prompt is built solely from the character card.
- **Dexie and browser APIs only run in `onMount` or `$effect`.** The layout once called `loadSettings()` in its component body, which ran during SSR, rejected with `MissingAPIError`, and killed the dev server.
- **SSR is on** (adapter-auto). Browser-only APIs (IndexedDB, cross-origin fetch to user-set base URLs) are safe in the current code because Dexie ops sit in async/effect contexts. If adding synchronous top-level Dexie/browser-API calls to component scripts, they will execute once server-side during SSR and can break it.
- **Local model servers and CORS**: when a user reports a connection failure against Ollama/KoboldCpp from the browser, suspect CORS first (e.g. Ollama's `OLLAMA_ORIGINS`) — the fetch goes straight from the page to the user's base URL.
- **Svelte 5 runes everywhere** (`$state`, `$derived`, `$effect`, `$props`, `{@render children()}`); only legacy store in use is `$app/stores` `page` for active-route styling in the layout. New code should use runes.
- **Persist with `$state.snapshot`.** IndexedDB cannot store Svelte proxies, so `saveSettings()` snapshots the settings before `db.settings.put`.

## Roadmap context (for choosing where new code goes)

- **Phase 2 (next):** personas, lorebooks/world-info, prompt presets, message branching/regeneration — all centered on `prompt.ts` + the chat route.
- **Phase 3:** self-hosted sync server (Node + Hono + SQLite) + LLM proxy so API keys move off devices; syncs the Dexie tables.
- **Phase 4:** Tauri (desktop) and Capacitor (mobile) wrapping this same frontend — avoid anything that breaks code reuse with a plain browser host.
- **Phase 5:** SillyTavern depth: group chats, regex scripts, quick replies, TTS/STT, image-gen hooks, extension system.

The README.md carries the same roadmap with user-facing framing.
