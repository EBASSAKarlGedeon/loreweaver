# 11 — Server Endpoints: `src/endpoints/*` (Code Map)

> Paths relative to repo root. Line refs are approximate (`file:~line`). Written 2026-11-24.
> All routers are mounted (login-required) by `setupPrivateEndpoints()` in `src/server-startup.js:~122`,
> except `users-public` (public, pre-login) and `sync` (bearer-token, pre-session; see `15-sync-system.md`).
> Route paths below are relative to each router's mount point. Suffixes omitted from `router.post('/x')` are POSTs.

## Purpose & user-facing surface

Every backend REST route the frontend (and API callers) can hit: LLM backends, character/chat
CRUD, settings/secrets persistence, media generation (images/TTS/captioning), search, tokenizers,
account management, and Loreweaver-specific additions (sync status, RPG-engine KV, data-maid,
sd-follow, image-metadata).

## Files overview

49 modules in `src/endpoints/` (incl. `backends/`), ~24,400 lines total. Grouped below.

## Chat-completion & LLM backend modules

| File | ~Lines | Purpose & key routes (mount → path) | Notable behavior |
|---|---|---|---|
| `backends/chat-completions.js` | 2896 | `/api/backends/chat-completions` → `POST /status`, `POST /bias`, `POST /generate`, `POST /process`, subrouter `/multimodal-models` | The main text-generation workhorse. Dispatches on `CHAT_COMPLETION_SOURCES` (`src/constants.js`): openai, claude, openrouter, makersuite, vertexai, mistralai, custom, cohere, perplexity, groq, deepseek, xai, minimax, … Handles prompt conversion, streaming, logit bias. Consumed by frontend `generate` pipeline (doc 13). |
| `backends/text-completions.js` | 646 | `/api/backends/text-completions` → `POST /status`, `POST /props`, `POST /generate`; subrouters `/ollama`, `/llamacpp`, `/tabby` | Legacy text-completion backends; dispatches on `TEXTGEN_TYPES` (ooba, mancer, vllm, aphrodite, tabby, koboldcpp, togetherai, llamacpp, ollama, …). Filters payloads through per-provider key whitelists (`TOGETHERAI_KEYS`, `FEATHERLESS_KEYS`, …). |
| `backends/kobold.js` | 281 | `/api/backends/kobold` → `POST /generate`, `POST /status`, `POST /transcribe-audio`, `POST /embed` | KoboldAI/KoboldCpp classic API; also used for STT and embeddings. |
| `openai.js` | 939 | `/api/openai` → `POST /caption-image`, `POST /generate-voice`, `POST /generate-image`, `POST /generate-video`, `POST /transcribe-audio` (+ `/groq|/mistral|/zai|/chutes/transcribe-audio`), model lists: `/electronhub/models`, `/chutes|/nanogpt|/siliconflow|/workers-ai/models/embedding`, `/electronhub/generate-voice`, `/chutes/generate-voice`; subrouter `/custom` (`POST /custom/generate-voice`) | OpenAI-adjacent endpoints: vision captioning, TTS/STT, image/video generation for many OpenAI-compatible aggregators (ElectronHub, Chutes, NanoGPT, SiliconFlow, Workers AI, Groq, MistralAI, z.ai). `/custom` is the user-defined OpenAI-compatible endpoint. |
| `anthropic.js` | 66 | `/api/anthropic` → `POST /caption-image` | Claude vision captioning only (chat generation goes through `backends/chat-completions`). |
| `google.js` | 641 | `/api/google` → `POST /caption-image`, `POST /list-voices`, `POST /generate-voice`, `POST /list-native-voices`, `POST /generate-native-tts`, `POST /generate-image`, `POST /generate-video` | Gemini/Vertex multimodal services; uses `GEMINI_SAFETY`/`VERTEX_SAFETY` (all thresholds OFF) from `src/constants.js`. Chat generation itself is in `backends/chat-completions.js`. |
| `novelai.js` | 481 | `/api/novelai` → `POST /status`, `POST /generate`, `POST /generate-image`, `POST /generate-voice` | NovelAI text gen, image gen (incl. V4) and TTS. |
| `horde.js` | 408 | `/api/horde` → `POST /text-workers`, `/text-models`, `/status`, `/cancel-task`, `/task-status`, `/generate-text`, `/sd-samplers`, `/sd-models`, `/caption-image`, `/user-info`, `/generate-image` | AI Horde crowdsourced text + image generation; polls task status. |
| `openrouter.js` | 209 | `/api/openrouter` → `POST /models/providers`, `/models/multimodal`, `/models/embedding`, `/models/image`, `/credits`, `/image/generate` | Model catalog + credits + image gen. Auth-related OAuth callback lands on `GET /callback/:source?` in `server-main.js`. |
| `nanogpt.js` | 138 | `/api/nanogpt` → `POST /credits`, `POST /models/providers` | NanoGPT aggregator catalog/credits. |
| `azure.js` | 88 | `/api/azure` → `POST /list`, `POST /generate` | Azure TTS voice list + synthesis. |

## Content modules (characters, chats, groups, files)

| File | ~Lines | Purpose & key routes | Notable behavior |
|---|---|---|---|
| `characters.js` | 1685 | `/api/characters` → `POST /create /rename /edit /edit-avatar /edit-attribute /merge-attributes /delete /all /get /chats /import /duplicate /export` | Core character CRUD. Exports `diskCache` (memory cache of parsed cards) — `diskCache.verify()` runs at startup, `dispose()` on shutdown. Character edits bump cache invalidation. PNG/charx card parsing via `src/character-card-parser.js`. All mutating routes validate `avatar_url`/`file_name` (`validateFileName.js`). |
| `chats.js` | 1077 | `/api/chats` → `POST /save /get /rename /delete /export /import /group/import /group/get /group/info /group/delete /group/save /search /recent` | Chat file CRUD + full-text chat search + recent chats. Exports `getChatData()` and `CHAT_BACKUPS_PREFIX = 'chat_'`. Group-chat metadata format migration runs from `server-main.js` pre-setup. |
| `groups.js` | 234 | `/api/groups` → `POST /all /create /edit /delete` | Group definitions (JSON per group in `groups/` dir); deletion trashes the file. |
| `worldinfo.js` | 157 | `/api/worldinfo` → `POST /list /get /delete /import /edit` | World/lorebook files in `worlds/`. |
| `assets.js` | 369 | `/api/assets` → `POST /get /download /delete /character` | Type/URI asset registry (character assets) stored under `assets/`; `character` route serves assets for a specific character. |
| `avatars.js` | 65 | `/api/avatars` → `POST /get /delete /upload` | User persona avatars in `User Avatars/`. |
| `backgrounds.js` | 156 | `/api/backgrounds` → `POST /all /folders /delete /rename /upload` | Chat backgrounds; supports subfolders. |
| `files.js` | 101 | `/api/files` → `POST /sanitize-filename /upload /delete /verify` | Generic user file storage under `user/files` (UNSAFE_EXTENSIONS blocklist applies). |
| `backups.js` | 73 | `/api/backups` → `POST /chat/get /chat/delete /chat/download` | Browse/manage automatic chat backups (`chat_`-prefixed in `backups/`). |
| `thumbnails.js` | 312 | `/thumbnail` → `GET /?type=…&file=…` (also exports empty `apiRouter`) | On-demand thumbnail generation (bg/avatar/persona types); `SKIPPED_EXTENSIONS` (apng/video) are served as-is; 404 lets the frontend show placeholders. `thumbnails.enabled` config can disable. |

## Config & personalization modules

| File | ~Lines | Purpose & key routes | Notable behavior |
|---|---|---|---|
| `settings.js` | 381 | `/api/settings` → `POST /save /get /get-snapshots /make-snapshot /load-snapshot /restore-snapshot` | The big `settings.json` read/write. `init()` (`settings.js:~379`) runs at startup to seed missing files. Exports `getSettingsBackupFilePrefix()`. Snapshots validate names (`validateFileName`). This is also the file the sync engine 3-way merges (doc 15). |
| `secrets.js` | 644 | `/api/secrets` → `POST /write /read /view /find /delete /rotate /rename /settings` | Per-user secret store (`secrets.json`), used by every provider module via `readSecret()`. Exports `SECRET_KEYS` and `migrateFlatSecrets()` (startup migration from flat format). Not synced by default (doc 15). |
| `themes.js` | 38 | `/api/themes` → `POST /save /delete` | UI theme files in `themes/`. |
| `presets.js` | 103 | `/api/presets` → `POST /save /delete /restore` | Instruct/context/preset files under per-API preset dirs. |
| `quick-replies.js` | 32 | `/api/quick-replies` → `POST /save /delete` | QR sets in `QuickReplies/`. |
| `moving-ui.js` | 17 | `/api/moving-ui` → `POST /save` | MovingUI state persistence. |
| `users-public.js` | 211 | `/api/users` (PUBLIC — mounted before login) → `POST /list /login /recover-step1 /recover-step2` | Only pre-auth API surface. Rate-limited login; account recovery flow. |
| `users-private.js` | 269 | `/api/users` → `POST /logout /change-avatar /change-password /backup /reset-settings /change-name /reset-step1 /reset-step2`; `GET /me` | Session-user self-service; `backup` produces a user-data zip. |
| `users-admin.js` | 265 | `/api/users` → `POST /get /disable /enable /promote /demote /create /delete /slugify` (all `requireAdminMiddleware`) | Admin account management. |

## Media modules (images, speech, captioning)

| File | ~Lines | Purpose & key routes | Notable behavior |
|---|---|---|---|
| `stable-diffusion.js` | 2208 | `/api/sd` → `POST /ping /upscalers /vaes /samplers /schedulers /models /get-model /set-model /generate`, `/sd-next/upscalers`; 17 cloud subrouters: `/comfy /comfyrunpod /together /sdcpp /drawthings /pollinations /stability /huggingface /chutes /electronhub /nanogpt /bfl /falai /xai /aimlapi /zai /workersai` | The biggest endpoint: local backends (A1111/Forge/SD.Next/ComfyUI/SD.cpp/DrawThings) plus one subrouter per cloud image provider. Writes generated images into `user/images`. |
| `sd-follow.js` | 758 | `/api/sd-follow` → `POST /generate /status` | **Loreweaver-specific** ([rpge-patch 024]): the RPG engine reuses the user's saved `extension_settings.sd` from settings.json — this endpoint replays the exact request the chat-side SD extension would send for the configured source, avoiding a mirror of ~25 per-source payload builders that would drift on upstream pulls. |
| `images.js` | 155 | `/api/images` → `POST /upload /list/:folder /folders /delete` | User image management (`user/images` incl. subfolders). |
| `image-metadata.js` | 741 | `/api/image-metadata` → `POST /folders/get /folders/create /folders/set-thumbnails /folders/update /folders/delete /folders/assign /folders/unassign`, `POST /`, `/all`, `/cleanup` | **Loreweaver-specific**: generic image metadata service with mtime-based cache (generates metadata on demand), folder organization for generated images. |
| `speech.js` | 432 | `/api/speech` → `POST /recognize`, `POST /synthesize`; subrouters `/pollinations` (`/voices /generate`), `/elevenlabs` (`/voices /voice-settings /synthesize /history /history-audio /voices/add …`) | STT (recognize) and TTS synthesis aggregation for browser speech extensions. |
| `minimax.js` | 228 | `/api/minimax` → `POST /generate-voice` | MiniMax TTS (global/CN endpoints). |
| `volcengine.js` | 136 | `/api/volcengine` → `POST /generate-voice` | Volcengine (Doubao) TTS. |
| `caption.js` | 29 | `/api/extra/caption` → `POST /` | Generic image captioning via the "extra" API (captures image, forwards to chosen interrogator source). |
| `classify.js` | 55 | `/api/extra/classify` → `POST /labels`, `POST /` | Emotion classification via transformers.js model (downloaded to extensions dir). |
| `sprites.js` | 289 | `/api/sprites` → `GET /get`, `POST /delete /upload-zip /upload` | Character expression sprites (`sprites/<char>/…`), zip import. |
| `translate.js` | 409 | `/api/translate` → `POST /libre /google /yandex /lingva /deepl /onering /deeplx /bing` | Translation providers for the chat translation extension. |

## Misc & Loreweaver additions

| File | ~Lines | Purpose & key routes | Notable behavior |
|---|---|---|---|
| `tokenizers.js` | 1137 | `/api/tokenizers` → `POST /<tokenizer>/encode` + `/decode` for `llama, nerdstash, nerdstash_v2, mistral, yi, gemma, jamba, gpt2, claude, llama3, qwen2, command-r, command-a, nemo, deepseek`; `POST /openai/encode /openai/decode /openai/count`; `POST /remote/kobold/count`, `/remote/textgenerationwebui/encode` | Local tokenizer bindings (sentencepiece + tiktoken + web tokenizers) so token counting works offline; remote routes delegate to a KoboldAI/ooba endpoint. |
| `vectors.js` | 605 | `/api/vector` → `POST /query /query-multi /insert /list /delete /purge-all /purge` | Vector storage (`vectors/` dir) for the Data Vector Retrieval extension; backend-agnostic (local transformers or remote embedding APIs). |
| `search.js` | 456 | `/api/search` → `POST /serpapi /transcript /searxng /tavily /koboldcpp /serper /zai /visit` | Web-search providers + page visit/transcript fetch for the Web Search extension. |
| `extensions.js` | 515 | `/api/extensions` → `POST /install /update /branches /switch /move /version /delete`; `GET /discover` | Third-party UI extension manager (git/zip installs into `extensions/third-party`). Everything behind `extensionsEnabledFeatureGuard` (`extensions.enabled` config); serves the third-party extension files via the users router (`/scripts/extensions/third-party/*` in `src/users.js`). |
| `content-manager.js` | 1124 | `/api/content` → `POST /importURL /importUUID` | Imports characters/lorebooks from URLs or shared-content UUIDs. `checkForNewContent()` also runs at server startup. |
| `stats.js` | 469 | `/api/stats` → `POST /get /recreate /update` | Chat statistics collection (message/timing stats per user). `init()` at startup, `onExit()` flushes to disk on shutdown (both wired in `server-main.js`). |
| `data-maid.js` | 816 | `/api/data-maid` → `POST /report /finalize /delete`, `GET /view` | **Loreweaver-specific**: scans user data for junk/stale files (report → review at `/view` → delete/finalize). |
| `rpg-engine-kv.js` | 181 | `/api/rpg-engine-kv` → `POST /list /get /put /delete` | **Loreweaver-specific**: server-side KV mirror for the RPG engine (browser + server persistence; see doc `21-rpg-storage-bridge.md`). |
| `sync.js` | 563 | `/api/sync` (special mount, bearer-token auth at `sync.js:~278`) → `POST /hello`, `GET /changes`, `GET /file`, `PUT /file` | Hub-side device sync protocol. Created by `createSyncRouter(DATA_ROOT)` and mounted **before** session/CSRF/login in `server-main.js`. Full detail: `15-sync-system.md` + `docs/SYNC-SPEC.md`. |
| `sync-status.js` | 112 | `/api/sync-status` → `GET /`, `POST /run`, `GET /conflicts` (all `requireLoginMiddleware`) | **Loreweaver-specific**: browser-facing sync status block (read last run result, trigger a run, list conflict copies). Reads state from the sync scheduler, not the device protocol. |

## Data structures & persistence

- Most config-type modules persist JSON per user under the user directory template
  (`src/constants.js:~14`): `settings.json`, `secrets.json`, `worlds/`, `groups/`, `themes/`,
  `QuickReplies/`, `presets` under API-named dirs (`NovelAI Settings`, `OpenAI Settings`,
  `TextGen Settings`, `instruct/`, `context/`), `backups/`, `vectors/`, `user/images`,
  `user/files`, `assets/`, `sprites/`, `thumbnails/`.
- `characters/` holds PNG/charx cards; `chats/` + `group chats/` hold JSONL/JSON chat files.
- Mutating endpoints use `writeFileAtomic` and trash-on-delete via shared helpers in
  `src/util.js` (see `15-sync-system.md` — the sync engine relies on these file conventions).
- Secrets live only server-side per user; `readSecret(handle, key)` is the common access path.

## Interactions

- All routers depend on `src/users.js` middleware (`setUserDataMiddleware` → `req.user.directories`).
- Provider modules read secrets from `secrets.js` and keys/whitelists from `src/constants.js`.
- `backends/*` + `openai.js` are the server half of the generation pipeline → doc
  `13-generation-pipeline.md`; `vectors/classify/caption/speech/stable-diffusion` serve the
  built-in UI extensions → doc `14-extensions-subsystem.md`; `rpg-engine-kv`/`sd-follow`/
  `image-metadata`/`data-maid`/`sync*` are Loreweaver additions documented in docs 15/20–25.
- `characters.js`/`chats.js` file layout is the data contract for the sync engine (doc 15).

## Gotchas

- **Almost everything is `POST`** even for reads (`/all`, `/get`) — a deliberate ST convention;
  only a handful are GET (`/thumbnail`, `/api/users/me`, sprites `/get`, data-maid `/view`,
  sync-status `/`, sync `/changes` `/file`).
- `users-public` is mounted **twice** conceptually: `server-main.js` mounts it pre-login,
  `users-private`/`users-admin` join it at the same `/api/users` path post-login.
- `sd-follow` intentionally couples to the saved `extension_settings.sd` — if a user has never
  configured SD in the chat UI, the RPG engine's image generation has no source to replay.
- `stable-diffusion.js` subrouters are defined locally in the same file (e.g. `const comfy =
  express.Router()` at ~385) — route names alone don't tell you the source; check the `const` blocks.
- `secrets.js` routes distinguish `read` (masked?) vs `view` (full) vs `find` (existence check);
  deleting a user or rotating keys is handled by `rotate`, not by re-`write`.
- `sync.js` is NOT login-protected — it must never be moved after the login middleware; the
  login-protected status UI is deliberately a separate module (`sync-status.js`).
- Legacy endpoints still get traffic via 308 redirects from `server-startup.js` — e.g.
  `downloadbackground` actually **uploads** a background; the redirect keeps the quirk alive.
- `thumbnails.apiRouter` is exported but currently has no routes; the public GET route does the work.
- Chat-generation endpoints (anthropic/google/claude/makersuite) don't generate chat text —
  only `backends/chat-completions.js` does, dispatched by `CHAT_COMPLETION_SOURCES`.
