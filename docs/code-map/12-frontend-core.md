# 12 — Frontend Core (Code Map)

> Paths relative to repo root. Line refs are approximate (`file:~line`). Written 2026-11-24.

## Purpose & user-facing surface

The entire Loreweaver UI: a single-page app (`public/index.html`) driven by one giant
controller module (`public/script.js`) plus per-feature ES modules in `public/scripts/`.
Everything the user sees — chat, character list, persona manager, group chats, API
connection panel, all settings drawers — lives here. There is no SPA framework: jQuery +
hand-rolled DOM manipulation, with Handlebars-rendered fragments (`scripts/templates.js`)
for repeated UI pieces.

User-facing surfaces:

- **Chat screen** (`#sheld` → `#chat` message list + `#form_sheld` input bar): message
  rendering, editing, swipes, file/image attachments, reasoning blocks.
- **Top-bar drawers** (`#top-settings-holder`): AI Configuration (presets, samplers) and
  API Connections (`#rm_api_block`, `#main_api` + `#chat_completion_source` selects).
- **Right drawer** (`#right-nav-panel`): character management — list, create/edit card
  (`select_rm_create`), group chat editor, past-chats browser (`displayPastChats`).
- **Persona manager** (bottom bar, `scripts/personas.js`), background picker, extensions
  panel, welcome screen.
- **Popups / dialogs** (`scripts/popup.js`), toasts (toastr), splash/loader overlays
  (`scripts/loader.js`).
- **Slash-command bar**: text typed into `#send_textarea` starting with `/` is executed as
  a slash command instead of a chat message.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `public/index.html` | 8218 | The whole DOM: drawers, chat, all settings panels. Script tags at end of body (~:8187) load libs then `script.js` as module. |
| `public/script.js` | 12539 | Core controller: boot, global state, events, Generate flow, chat/character CRUD, save/load, swipes, message DOM. Exports the shared state every other module imports. |
| `public/scripts/events.js` | 113 | `event_types` enum + `eventSource` (EventEmitter). The app-wide pub/sub. |
| `public/scripts/loader.js` | 60 | Deprecated `showLoader()`/`hideLoader()` shims over `action-loader.js`. |
| `public/scripts/dom-handlers.js` | 66 | `initDomHandlers()`: traps mouse wheel inside focused number inputs. |
| `public/scripts/keyboard.js` | 254 | `initKeyboard()`: maps every "interactable" selector (see `interactableSelectors` ~:1) to keyboard activation, Enter/Escape handling. |
| `public/scripts/power-user.js` | 4460 | `power_user` settings object + all UI-appearance toggles (themes, movingUI, zen sliders, chat display modes), debug menu, `playMessageSound`, `fixMarkdown`. |
| `public/scripts/personas.js` | 3006 | Persona (user) management: avatar list, per-chat/per-character persona locking, description injection position/depth, auto-select. |
| `public/scripts/chats.js` | 2422 | Chat utilities "moved out of script.js eventually": file attachments (`populateFileAttachment`, `appendFileContent`), `<style>` tag encode/decode, hidden-message ranges, creator notes. |
| `public/scripts/group-chats.js` | 2490 | Group model (`groups`, `selected_group`), member activation, `generateGroupWrapper` (~:945) turn-taking, group chat CRUD. |
| `public/scripts/bookmarks.js` | 737 | Chat checkpoints: `Checkpoint #` named chat snapshots + `/go` `/checkpoint` `/delchat` slash commands, group bookmark saving. |
| `public/scripts/popup.js` | 966 | `Popup` class (~:148), `POPUP_TYPE`/`POPUP_RESULT`, `callGenericPopup` — all confirm/input/display dialogs. |
| `public/scripts/i18n.js` | 332 | Locale loading, `t` template tag, `data-i18n` MutationObserver translation, `localStorage.language` override. |
| `public/scripts/login.js` | 291 | Standalone login page module (user list, CSRF token, `discreetLogin`) — separate from script.js boot. |
| `public/scripts/templates.js` | 131 | Handlebars `renderTemplateAsync` with template cache (see also doc 13). |

## Key functions

- `firstLoadInit()` — script.js:~692 — the ordered boot sequence: fetch CSRF token → splash
  loader → `initDomHandlers`, markdown/purify setup, `getClientVersion`, secrets, locales,
  then ~40 `init*` calls in a strict order (extensions before presets, `getSettings` before
  personas/characters/world info), ending with `APP_INITIALIZED`/`APP_READY` emits. Only
  caller: top-level `await` in script.js module scope (~:338 area).
- `pingServer()` — script.js:~673 — POST `/api/ping`; boot retries until reachable
  (`reloadLoop()` ~:7844 reloads the page on failure).
- `getSettings()` / `saveSettings()` — script.js:~7856 / ~7994 — load/save the whole
  `settings` blob from/to `/api/settings/get`|`save`; fires `SETTINGS_LOADED_BEFORE/AFTER`,
  `SETTINGS_LOADED`, `SETTINGS_UPDATED`. Every feature module populates itself from it.
- `Generate(type, {...}, dryRun)` — script.js:~4233 — **the** generation entry point.
  `type` ∈ `''` (send) | `'regenerate'` | `'swipe'` | `'continue'` | `'impersonate'` |
  `'quiet'` | `'normalize'`. Emits `GENERATION_STARTED` / `GENERATION_AFTER_COMMANDS`;
  runs slash commands from the textarea first (`processCommands`, may abort); delegates to
  `generateGroupWrapper` for groups; builds the text-completion prompt inline (history
  into `mesSend`, examples budgeting ~:4900, instruct formatting, WI, AN, bias) or hands
  off to `prepareOpenAIMessages` for chat-completion; token budgets (`getMaxPromptTokens`
  ~:5924); calls `sendGenerationRequest`/`sendStreamingRequest`; result → `saveReply`.
  Called from: send/regenerate/continue buttons, slash commands, extensions, group wrapper.
- `stopGeneration()` — script.js:~5550 — aborts `abortController`, fires `GENERATION_STOPPED`.
- `sendGenerationRequest` / `sendStreamingRequest` / `getGenerateUrl` — script.js:~6059/6090/6115 —
  route per `main_api` to `/api/backends/{kobold,koboldhorde,text-completions}/generate`,
  `/api/novelai/generate`, or `sendOpenAIRequest` (chat completions, see doc 13).
- `saveReply({type, getMessage, ...})` — script.js:~6585 — writes the AI reply into `chat`
  (`normal|swipe|append|continue|appendFinal`), sets reasoning/media, triggers chat save.
- `swipe()` — script.js:~9896 — the whole swipe state machine (direction, overswipe
  behavior, regeneration vs cached swipes); `swipe_left`/`swipe_right` are thin wrappers.
- `saveChat()` — script.js:~7338 — 1:1 character chats only; **throws if called for group
  chats** (must use group-chats' savers); `saveChatConditional()` ~:9354 is the dispatcher
  everyone uses; `saveChatDebounced()` ~:7304 for streaming-time autosave.
- `getChat()` / `openCharacterChat()` / `doNewChat()` — script.js:~7577/7687/10560 —
  load a chat file into `chat`, add first-message greeting, fire `CHAT_CHANGED`.
- Character CRUD: `getCharacters` (~:1294, from `/api/characters/all`), `printCharacters`
  (~:993, list DOM), `createOrEditCharacter` (~:9690, save form), `importCharacter`
  (~:10472), `deleteCharacter` (~:10770), `duplicateCharacter` (~:5977), `renameCharacter`
  (~:7128, also rewrites names in past chats via `renamePastChats`).
- `messageFormatting()` — script.js:~1755 — message → HTML (showdown markdown, DOMPurify,
  code blocks, media, reasoning block). Used everywhere messages render.
- `addOneMessage()` / `printMessages()` / `redisplayChat()` / `showMoreMessages()` —
  script.js:~2494/1477/1499/1433 — chat DOM lifecycle.
- `substituteParams()` — script.js:~2924 — macro evaluation entry (delegates to macros
  engine, doc 13); `getCharacterCardFields` (~:3419) provides `{{char}}`/`{{persona}}` data.
- `processCommands()` — script.js:~3068 — textarea text starting with `/` goes to
  `executeSlashCommandsOnChatInput` (slash-commands subsystem, doc 14-adjacent).
- `Generate` group path: `generateGroupWrapper()` — group-chats.js:~945 — picks members by
  activation strategy (list/auto/manual/mention/native), runs sequential turns, applies
  group nudges/trims (`cleanGroupMessage` script.js:~3114).
- Popup: `Popup.show()` + `callGenericPopup()` — popup.js:~148/838 — promise-based dialogs.
- `initKeyboard()` — keyboard.js — keyboard accessibility for ~30 selector classes.
- i18n: `initLocales()`, `t` — i18n.js — fetches `/locales/*.json`, live `data-i18n` DOM
  translation via MutationObserver.
- login.js: `getCsrfToken`, `getUserList`, `login` — self-contained; used by `login.html`.

## Data structures & persistence

- **Global module state (script.js, all exported)**: `chat` (array of message objects, the
  active conversation), `chat_metadata`, `characters` (loaded card list), `this_chid`,
  `name1`/`name2`, `user_avatar`, `main_api`, `chat_completion_source` (in openai.js),
  `online_status`, `selected_group`, `menu_type`, `is_send_press`, `abortController`,
  `max_context`/`amount_gen`, `settings` (whole settings blob).
- **Message object** (chat file line): `{ name, is_user, is_system, is_hidden, mes,
  swipes[], swipe_id, extra{ reasoning, image_urls, title, token counts, ... },
  gen_started, gen_finished, send_date, force_avatar }`. Swipes stored per-message.
- **Persistence** (server-side, under `data/<user>/`, see doc 10/11):
  `settings.json` via `/api/settings/*`; chats as JSONL at
  `chats/<character name>/<chatfile>.jsonl` (line 1 = metadata, then messages) and
  `group chats/<group id>/*.jsonl`; characters as PNG cards in `characters/`; groups in
  `groups.json`; presets under `OpenAI Settings/`, `TextGen Settings/`, etc.
  Synced by the sync engine (docs 15).
- **localStorage** (per-device, NOT synced): `language` (i18n), `eventTracing`,
  `trackDynamicTranslate`, MANCER server URL (textgen-settings), draft input text key
  (RossAscends-mods `getUserInputKey`), boolean UI feature toggles via `f-localStorage.js`.
- **IndexedDB**: itemized prompts (`localforage` store `SillyTavern_Prompts`,
  itemized-prompts.js) — see doc 13.

## Interactions

- **Doc 13 (generation pipeline)**: `Generate` calls `prepareOpenAIMessages`,
  `evaluateMacros`, `checkWorldInfo`, instruct/AN/cfg helpers; consumes their outputs.
- **Doc 14 (extensions)**: `setExtensionPrompt()` (script.js:~8868) is the injection API
  every extension uses; `extension_prompt_types`/`roles` enums flow into prompt assembly.
- **Doc 10/11 (server)**: all persistence goes through `/api/*` endpoints with the CSRF
  header from `getRequestHeaders()` (~:645).
- **Slash commands subsystem** (`public/scripts/slash-commands/`): registered by
  `initDefaultSlashCommands`, executed from `processCommands`; bookmarks adds its own.
- **Sync status** (`scripts/sync-status.js`): lazily imported in `firstLoadInit`
  (Loreweaver addition).

## Gotchas

- **Init order matters** in `firstLoadInit`: `initExtensions()` must run before
  `initPresetManager()`/`getSettings()`; `getSettings()` must precede `initPersonas()`,
  `getCharacters()`, `initWorldInfo()` — several modules read `power_user`/`settings`
  during their init and will misbehave if reordered.
- `saveChat()` hard-throws for group chats (data-corruption guard, script.js:~7341);
  callers must use `saveChatConditional()` or group savers.
- `chat` array indexes are **message IDs** everywhere; deleting a message requires
  `updateViewMessageIds`/`refreshSwipeButtons` fixups, and itemized prompts are tracked
  per-mesId separately.
- Generation state is a web of globals (`is_send_press`, `is_group_generating`,
  `streamingProcessor`); `resetChatState()` (~:7034) must be called on chat switches or
  buttons stay dead.
- The giant `jQuery(async function () { ... })` at script.js:~11043 ("DOM Handlers Start")
  wires nearly every click handler with `$(document).on(...)` — new buttons usually belong
  there; it runs *after* all module imports (module scope awaits `firstLoadInit`).
- Import cycles are pervasive by design: `power-user.js`, `personas.js`, `group-chats.js`
  all import from `script.js` while `script.js` imports from them (ES module hoisting makes
  it work, but circularity means no top-level side effects depending on order).
- `power_user.instruct.enabled` is ignored when `main_api === 'openai'` (script.js:~4256) —
  instruct formatting never applies to chat-completion sources; they use the PromptManager.
- Splash screen logo/message in `firstLoadInit` is Loreweaver-specific (fork change).
- `settings` blob save is debounced (`saveSettingsDebounced`); racing writes are handled
  server-side by last-write-wins, which sync then arbitrates (doc 15).
- i18n keys are the English strings themselves; locale files map them verbatim.
