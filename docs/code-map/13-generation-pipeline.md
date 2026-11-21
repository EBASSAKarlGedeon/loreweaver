# 13 — Generation Pipeline (Code Map)

> Paths relative to repo root. Line refs are approximate (`file:~line`). Written 2026-11-24.

## Purpose & user-facing surface

Everything between the user pressing Send and the raw token stream leaving the browser:
chat-completion source abstraction (`openai.js`), prompt assembly (PromptManager order,
world info, instruct formatting, author's note, CFG), macro expansion, token counting,
and the per-message "itemized prompt" introspection. User-facing surfaces:

- **AI Connection panel**: `#main_api` + `#chat_completion_source` selects — OpenAI,
  Claude, Google (AI Studio/Vertex), plus OpenRouter, MistralAI, Groq, Cohere, Perplexity,
  DeepSeek, xAI, AI21, Mistral, NanoGPT, ElectronHub, Chutes, SiliconFlow, MiniMax, Z.AI,
  etc. All go through one `sendOpenAIRequest`.
- **Prompt manager** (`PromptManager.js`, "Prompt Manager" drawer): drag-order prompt list
  with markers (main, NSFW, jailbreak, WI before/after, chat history, examples).
- **Lorebook / World Info editor** (`world-info.js`): entry editor with keys, logic,
  budget, recursion, per-position insertion.
- **Instruct mode & Context templates** (`instruct-mode.js`): sequences, system prompt
  wrapping, auto-select per model.
- **Logit bias editor, CFG scale, sampler params** — API-specific sliders in the config drawer.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `public/scripts/openai.js` | 7249 | Chat-completion abstraction: sources, models, presets, prompt building, token budget, request send, streaming parse. Exports `oai_settings`, `chat_completion_sources`, `sendOpenAIRequest`, `prepareOpenAIMessages`, `ChatCompletion`. |
| `public/scripts/templates.js` | 131 | Handlebars `renderTemplateAsync`/`renderTemplate` with sync/async URL fetch + cache (UI templates, not prompts). |
| `public/scripts/macros.js` | 747 | Legacy facade: `evaluateMacros` over the new engine; chat-state macro env builders (last message, swipe id, times). |
| `public/scripts/macros/` | ~20 files | **New macro engine**: `macro-system.js` (registry), `engine/MacroEngine|Lexer|Parser|Registry|EnvBuilder...`, `definitions/{core,chat,env,instruct,state,time,variable}-macros.js`. |
| `public/scripts/filters.js` | 460 | `FilterHelper` + `FILTER_TYPES`/`FILTER_STATES`: shared list filtering (characters, personas, groups, WI editor). |
| `public/scripts/logit-bias.js` | 142 | `displayLogitBias` list UI + `BIAS_CACHE` shared with openai.js. |
| `public/scripts/cfg-scale.js` | 497 | CFG/guidance scale for text-completion APIs; prompt duplication + negative prompt (`getCfgPrompt` ~:459). |
| `public/scripts/instruct-mode.js` | 870 | Instruct/context presets, sequences, `formatInstructModeChat/SystemPrompt/StoryString/Examples` (~:387/466/478/511), model auto-select. |
| `public/scripts/authors-note.js` | 619 | Author's Note floating prompt: settings UI, chat-metadata persistence, `setFloatingPrompt` (~:324), `/note` slash commands. |
| `public/scripts/world-info.js` | 6289 | Lorebook engine: entry model, scan (`checkWorldInfo` ~:4597), budget buffer (`WorldInfoBuffer` ~:199), editor UI, timers/timed effects, `getWorldInfoPrompt` ~:892. |
| `public/scripts/itemized-prompts.js` | 399 | Per-message raw prompt snapshots (`promptItemize` ~:248) persisted in IndexedDB (localforage store `SillyTavern_Prompts`). |
| `src/prompt-converters.js` | 1445 | **Server-side** message conversions per vendor: Claude (`convertClaudePrompt` ~:120), Google (~:432), Mistral (~:699), Cohere (~:384), xAI, AI21, merge/strict modes (`postProcessPrompt` ~:85, `mergeMessages` ~:823), reasoning budget calcs. |
| `src/tokenizers/` | data | Local tokenizer model files: claude.json, llama/llama3, mistral, gemma, jamba, yi, nerdstash (loaded by `src/endpoints/tokenizers.js`). |
| `public/scripts/tokenizers.js` | ~700 | Client side: `getTokenCountAsync` (~:443) via `/api/tokenizers/*`, local `guesstimate` fallback (3.35 bytes/token), cache. |

## Key functions

- `oai_settings` / `default_settings` — openai.js:~511/403 — full chat-completion settings
  blob (temps, model names per source, prompt strings, proxy config, prompt-manager order).
  Persisted as a preset in `data/<user>/OpenAI Settings/<preset>.json`, referenced from
  `settings.json`.
- `prepareOpenAIMessages(...)` — openai.js:~1533 — orchestrates chat-completion prompt
  build: creates a `ChatCompletion` (class ~:3822), sets token budget, calls
  `preparePromptsForChatCompletion` (~:1358) to flatten PromptManager order into `Prompt`
  objects, then `populateChatCompletion` (~:1176) which fills system prompts, character
  card, personality/scenario, WI, chat history (`populateChatHistory` ~:876), dialogue
  examples (`populateDialogueExamples` ~:1092, `parseExampleIntoIndividual` ~:720),
  depth injections. Throws `TokenBudgetExceededError` (~:3398) when mandatory prompts
  overflow. Called from `Generate()` (doc 12) — returns `[chatCompletion, isDryRun]`.
- `createGenerationParameters()` — openai.js:~2645 — builds the vendor request body per
  `chat_completion_source` (per-source model, temps, media inlining, reasoning effort,
  tool options, custom prompt post-processing type). Consumed by `sendOpenAIRequest`.
- `sendOpenAIRequest(type, messages, signal)` — openai.js:~3044 — POST to
  `/api/backends/chat-completions/generate` (server does vendor conversion via
  `src/prompt-converters.js`); streaming branch parses SSE via `getEventSourceStream` into
  an async generator yielding `{text, swipes, logprobs, toolCalls, state}`; non-stream
  branch checks quota/moderation errors. Fires `CHAT_COMPLETION_SETTINGS_READY`.
- `getStreamingReply()` — openai.js:~3128 — extracts reply deltas per source (handles
  reasoning blocks, images, signatures for Gemini/Claude/OpenRouter).
- `getStatusOpen()` — openai.js:~4358 — connection test per source (model list fetch etc.);
  result drives `online_status` in script.js.
- `initOpenAI()` — openai.js:~6622 — wires settings UI, preset load/save/import/export,
  logit bias editor, slash commands (`/model`, `/proxy*`, `/completion*`), model list
  load/refresh. Called in `firstLoadInit` (doc 12).
- `calculateLogitBias()` — openai.js:~3306 — resolves bias entries to token IDs using
  `BIAS_CACHE` from logit-bias.js; per-API bias maps.
- `evaluateMacros(content, env)` — macros.js:~610 — runs the macro pipeline (legacy
  `MacrosParser` is deprecated, macros.js:~50); the live engine is
  `macros/macro-system.js` (`macros.registry.registerMacro`), with definitions split by
  domain in `macros/definitions/*` and parsing/evaluation in `macros/engine/*`.
  Entry from script.js: `substituteParams` (doc 12). Registered macros include `{{char}}`,
  `{{user}}`, `{{time}}`, `{{roll:...}}`, `{{pick}}`, `{{random:...}}`, `{{var}}`/`{{setvar}}`,
  instruct macros from instruct-mode.js.
- `checkWorldInfo(chat, maxContext, isDryRun, globalScanData)` — world-info.js:~4597 —
  the activation engine: scans recent chat with entry keys (AND/NOT/regex logic,
  `world_info_logic` ~:33), optional recursion, `world_info_min_activations`, budget via
  `WorldInfoBuffer`, timed effects. Output split into `worldInfoBefore/After`,
  `WIDepthEntries`, `EMEntries`, AN-before/after, `outletEntries` (see
  `getWorldInfoPrompt` ~:892). Entries live in `data/<user>/worlds/<name>.json`.
- `formatInstructModeChat(name, mes, isUser, isNarrator, forceAvatar, ...)` —
  instruct-mode.js:~387 — wraps a message in instruct input/output/system sequences
  (first/last variants, names_behavior). Same file: `formatInstructModeStoryString`
  (~:478) builds context-template story strings; `autoSelectInstructPreset(modelId)`
  (~:236) maps model → preset + context template.
- `setFloatingPrompt()` — authors-note.js:~324 — computes the Author's Note / floating
  extension prompt injection (depth, interval, position, role) from chat_metadata + per-
  character overrides; `Generate` passes it into prompt assembly as a depth injection.
- `getGuidanceScale()` / `getCfgPrompt()` — cfg-scale.js:~401/459 — CFG only for
  text-completion APIs (`textgenerationwebui`); stores config in `chat_metadata.cfg` and
  duplicate-prompts the request server-side.
- `promptItemize()` — itemized-prompts.js:~248 — after each generation, the raw prompt
  arrays (final/whole prompt text) are stored per message ID for the "view itemized
  prompt" feature; `swapItemizedPrompts` (~:365) keeps them aligned across swipes.
- `renderTemplateAsync(id, data)` — templates.js:~60 — HTML UI fragments (not prompt text).
- Server conversions (doc 11 detail): `convertClaudePrompt` (system→first human + prefill
  assistant, caching headers), `convertGooglePrompt` (roles user/model, inline media),
  `convertMistralMessages` (system→first user), `postProcessPrompt` (NONE/SEMI/STRICT/
  MERGE custom post-processing), `convertTextCompletionPrompt` (~:957) for text-completion
  backends. `src/endpoints/tokenizers.js` loads the local model files from `src/tokenizers/`
  to serve exact token counts for Claude/llama/mistral/etc.

## Data structures & persistence

- **`oai_settings`** → OpenAI preset files (`OpenAI Settings/*.json`), key
  `preset_settings_openai` in `settings.json`; prompt order (`promptOrder`) per character
  or dummy. Migrations in `migrateChatCompletionSettings` (openai.js:~4179).
- **`chat_completion_sources`** (openai.js:~175): enum of all sources; each has feature
  flags (`updateFeatureSupportFlags` ~:6606) driving UI toggles via `data-source` attrs.
- **World info entry**: `{ key[], keysecondary[], comment, content, constant, selective,
  selectiveLogic, order, position, depth, probability, recursion, timedEffects, ... }`;
  lorebook files in `data/<user>/worlds/`; UI state (`world_info_depth`, budget, scan
  options) in `settings.json` (`worldInfoSettings`).
- **Instruct preset**: `{ input_sequence, output_sequence, system_sequence, wrap,
  names_behavior, ... }` in `data/<user>/instruct/*.json`; context templates in
  `data/<user>/context/`. Loreweaver ships a Loreweaver-specific `system_prompt` value.
- **Chat metadata keys**: `note_prompt`/`note_depth`/`note_interval` (authors-note
  `metadata_keys` ~:30), `cfg`, `tainted`, `timedWorldInfo`.
- **Itemized prompts**: IndexedDB `SillyTavern_Prompts` keyed by chat ID — **not** synced
  by the sync engine (syncs files under `data/`, not IndexedDB).
- **Macro env**: `getInstructMacros`, `getVariableMacros`, chat/env/time definitions;
  dynamic macros via `substituteParams({ dynamicMacros })`.

## Interactions

- **Doc 12**: `Generate()` (script.js:~4233) is the sole caller of
  `prepareOpenAIMessages`; `substituteParams` feeds every string through macros; result
  parsing back into `saveReply` via `extractMessageFromData`/`extractJsonFromData`
  (script.js:~6219/6254).
- **Doc 10/11 (server)**: browser POSTs assembled prompts to
  `/api/backends/chat-completions/generate` / `/api/backends/text-completions/generate`
  / `/api/novelai/generate` / `/api/backends/kobold*/generate`; the server's backend
  endpoints use `src/prompt-converters.js` and proxy/secret config (doc 10).
- **Doc 14 (extensions)**: extensions inject via `setExtensionPrompt` (depth injections
  gathered by `getAllExtensionPrompts` script.js:~3174) and can hook
  `GENERATE_BEFORE_COMBINE_PROMPTS` etc. PromptManager is the UI for the prompt order.
- **Itemized prompts** feed the RPG-engine/extension introspection and the little
  "itemized prompt" button on each message.

## Gotchas

- **Two prompt pipelines coexist**: text-completion prompt assembly lives inline in
  `Generate()` (script.js ~:4900–5550, `mesSend`/`setPromptString`), while chat-completion
  assembly is entirely in openai.js via PromptManager. Don't "fix" one and expect the
  other to follow; instruct formatting is shared but applied differently.
- **Server-side prompt conversion is invisible to the browser**: the browser sends
  OpenAI-style `messages` for all chat-completion sources; `src/prompt-converters.js`
  reshapes them per vendor (Claude prefill, Google roles, Mistral system limits). Debug
  prompt logs (`power_user.console_log_prompts`) show pre-conversion text only.
- `TokenBudgetExceededError` is thrown *before* the request when mandatory prompts don't
  fit — surfaced in the PromptManager error slot, not toastr alone.
- World info budget interacts with recursion: `world_info_budget_cap = 0` disables the
  cap; recursive scans consume the same `WorldInfoBuffer`, so a "missing" entry is often
  budget starvation, not key failure.
- `openai_messages_count` and example-chat cycling: unpinned examples are dropped
  oldest-first to fit budget (`pin_examples` toggles exactness).
- Macros engine transition: `MacrosParser` (macros.js) is deprecated — new code should
  register via `macros.registry.registerMacro` (macros/macro-system.js); unresolved
  macros are left as-is via the `helperMissing` Handlebars shim (macros.js:~18).
- Instruct auto-select (`autoSelectInstructPreset`) can silently switch presets on model
  change; "Bind to model" toggle (`updateBindModelTemplatesState` ~:162) controls it.
- Author's Note `shouldWIAddPrompt` (authors-note.js:~28) is a mutable flag flipped by
  world-info timers — order of WI vs AN processing matters in depth injections.
- Itemized prompts live in IndexedDB, so they vanish if browser storage is cleared and
  are not covered by device sync (Loreweaver sync is file-based).
- `src/tokenizers/` files are large model binaries loaded server-side; client token
  counts are approximations (`guesstimate`) unless the server endpoint supports the API.
