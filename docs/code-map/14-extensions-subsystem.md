# 14 — Extensions Subsystem (Code Map)

> How extensions are discovered, activated, and hooked — plus a per-extension overview of the
> built-ins shipped in `public/scripts/extensions/`.
> Paths relative to repo root. Line refs approximate, written 2026-11-24.

## Purpose & user-facing surface

- The "Extensions" panel (wand menu → Extensions) lists built-in + third-party extensions with
  per-extension enable/disable, plus a global toggle-all.
- Third-party extensions install from URL/zip into `public/scripts/extensions/third-party/`
  (server endpoint: `src/endpoints/extensions.js` — install/update/delete; needs admin/fullpages).
- The RPG engine (`rpg-engine/`) is our largest third-party-style extension — documented
  separately in maps 20–25.

## Loader core — `public/scripts/extensions.js`

| Function | Where | What it does |
|---|---|---|
| `discoverExtensions()` | ~298 | Collects manifests from built-ins + `third-party/*` (server-side listing) |
| `activateExtensions()` | ~568 | The gate: for each manifest checks `minimum_client_version`, `requires` (extras modules), `dependencies` (must exist AND be enabled), `disabledExtensions` — then `addExtensionLocale → addExtensionScript → addExtensionStyle`, marks active, fires `activate` hook |
| `callExtensionHook()` | ~406 | Invokes the manifest-declared hook export (`hooks: {activate|install|update|delete|enable|disable|clean}`) via dynamic `import()`, 5 s timeout per hook |
| `enableExtension()` / `disableExtension()` | ~473 / ~490 | Toggle + persist to `extension_settings.disabledExtensions` + page reload |
| `findExtension()` / `getExtensionManifest()` | ~508 / ~524 | Lookup tolerant to missing `third-party/` prefix |
| `addExtensionsButtonAndMenu()` | ~688 | Builds the panel UI; `showHideExtensionsMenu()` ~228 |
| `renderExtensionTemplateAsync()` | ~137 | Server-rendered HTML templates for extension UIs (`/template/` endpoint) |
| `doExtrasFetch()` | ~260 | Legacy extras-API helper (most built-ins no longer need extras) |
| `saveMetadataDebounced()` | ~89 | Debounced chat-metadata save — extensions mutating chat metadata use this |

**Manifest contract** (`manifest.json` per extension): `display_name`, `loading_order`
(lower = earlier), `js` (entry, dynamic-imported), `css`, `requires` (extras modules array),
`dependencies` (other extensions), `minimum_client_version`, `hooks` (exported function names),
`optional`, `i18n`. Example: `public/scripts/extensions/rpg-engine/manifest.json` (loading_order 100).

**Extension API surface** (what extensions typically use): `SillyTavern.getContext()` /
global `SillyTavern` (script.js), `eventSource.on(event_types.*)` (public/scripts/events.js),
`extension_settings` (power-user.js), `saveSettingsDebounced()`, slash-command registration
(`registerMacro`/SlashCommandParser), `popup.js`, and the re-exported regex API from
`extensions/regex/index.js` (marked "re-exports for legacy extensions" ~line 1).

## Built-in extensions — `public/scripts/extensions/<name>/`

| Ext | ~Lines | Purpose (entry `index.js`) |
|---|---|---|
| `assets` | 598 | Asset browser/downloader for cards & assets |
| `attachments` | 410 | Attach files/images to messages (data bank attachments) |
| `caption` | 813 | Image captioning via multimodal models; settings migration at top |
| `connection-manager` | 1158 | Named connection profiles (API+model+keys) with slash commands; empty-value recording quirk noted in code header |
| `expressions` | 2576 | Sprite expressions: classify LLM/CNN → character sprite swap; hooks `CHARACTER_MESSAGE_RENDERED`, `CHAT_CHANGED` etc. |
| `gallery` | 853 | In-chat image gallery viewer (draggables cleanup noted in code header) |
| `memory` | 1131 | Author's-note-style summarization ("memory" extension) + token counting |
| `quick-reply` | 321 | QR sets + slash commands (core logic lives in `scripts/quick-reply.js` + presets endpoint) |
| `regex` | 2157 | Regex scripts engine: per-message find/replace/injection, presets, legacy re-exports; scripts also stored per-character (char-data.js) |
| `shared.js` | — | Shared helpers for extension authors (query DOM helpers, save_metadata) |
| `stable-diffusion` | 5998 | The big one: image generation UI, prompt editing (Extra Networks, layout presets), generation sources (local/online), interactive mode |
| `token-counter` | 118 | Visual token chunk overlay for text |
| `translate` | 804 | Message translation (swipe-aware translation flow) |
| `tts` | 1622 | TTS provider registry (`registerTtsProvider`), per-character voices, narration |
| `vectors` | 2358 | Vector storage: hashing/embedding pipelines (`HashedMessage` typedef), retrieval injection (Data Bank, chat/vector memory) |

Third-party currently contains only `rpg-engine/` (empty dir otherwise — installs land here).

## Data structures & persistence

- `extension_settings` (localStorage via power-user.js, persisted to `settings.json` under
  `extension_settings`): per-extension settings blobs + `disabledExtensions` array.
- Chat-scoped data: `chat_metadata` (e.g. regex per-character scripts, quick-reply chat sets),
  saved via `saveMetadataDebounced`.
- Installed third-party extensions live server-side under
  `data/<user-handle>/extensions/<name>` for per-user installs, or `public/scripts/extensions/third-party/`
  for global installs (server endpoint `src/endpoints/extensions.js` decides; per-user dir is the
  default in current ST).

## Interactions

- Frontend core (map 12): `script.js` exposes the global API and event bus everything hangs on.
- Generation pipeline (map 13): extensions inject into prompts (vectors/memory/regex are the main prompt-mutators).
- Server (map 11): `/api/extensions/*` (discovery, install), `/template/` rendering.
- RPG engine: its own maps 20–25; it registers through this same loader with `loading_order: 100`.

## Gotchas

- Activation is **page-reload based**: enable/disable reloads the app; extension code should be
  idempotent on boot (the RPG engine carefully tolerates re-init).
- `dependencies` must be *enabled*, not just present — a disabled dependency blocks activation.
- Hook calls have a hard 5 s timeout and are fire-and-forget after that — don't put long work in `activate`.
- `loading_order` decides boot order globally (built-ins sort first); an extension depending on
  another must set a higher loading_order.
- `third-party/` prefix is optional in most API lookups, but NOT in some string-built paths —
  prefer `findExtension()`/`getExtensionManifest()` over manual path concatenation.
