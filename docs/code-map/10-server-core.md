# 10 — Server Core: Bootstrap, Middleware & Config (Code Map)

> Paths relative to repo root. Line refs are approximate (`file:~line`). Written 2026-11-24.

## Purpose & user-facing surface

Boots the Express HTTP(S) server that serves the Loreweaver frontend (`public/`) and the
`/api/*` backend. User-facing surface:

- The web UI at `/` (login redirect when accounts are enabled), login page at `/login`.
- Version endpoint `GET /version`, session ping `POST /api/ping`, CSRF token `GET /csrf-token`.
- Optional CORS proxy at `/proxy/:url(*)`, OAuth PKCE callback at `/callback/:source?`.
- Static assets from `public/` (webpack-compiled `lib.js`, user CSS at `/css/user.css`).
- The server also compiles frontend libs with webpack at startup, launches the browser
  (optional), writes an optional heartbeat file, logs access to `data-root/access.log`.

There is no "app server vs static server" split: one Express app does everything.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `server.js` | 17 | Entry point. Parses CLI, sets `globalThis.DATA_ROOT`/`COMMAND_LINE_ARGS`, `chdir` to server dir, imports `src/server-main.js`. |
| `src/server-global.js` | 5 | Standalone/global-mode shim: sets `globalThis.FORCE_GLOBAL_MODE = true` and re-imports `server.js` (used by electron/packaged app). |
| `src/server-init.js` | 12 | Pre-start: `addMissingConfigValues()` on `config.yaml` before anything else imports config. |
| `src/server-main.js` | 498 | The real bootstrap: builds the Express middleware chain, mounts routers, runs migrations, graceful shutdown, post-listen tasks. |
| `src/server-startup.js` | 460 | `redirectDeprecatedEndpoints()`, `setupPrivateEndpoints()` (mounts all `/api/*` routers), `ServerStartup` class (HTTP/HTTPS, IPv4/IPv6 listen logic). |
| `src/server-events.js` | 21 | Global `EventEmitter` (`serverEvents`, also `process.serverEvents`). Only event: `SERVER_STARTED`. |
| `src/server-directory.js` | 3 | Resolves server install directory (`serverDirectory`). |
| `src/express-common.js` | 127 | Shared IP/rate-limit helpers: `getIpFromRequest`, `getRealOrForwardedIp`, `getIpAddress`, `filterValidIpPatterns`, `retryAfter`; deprecated no-op `jsonParser`/`urlencodedParser`. |
| `src/middleware/whitelist.js` | 104 | IP whitelist middleware (config `whitelist` or deprecated `whitelist.txt`); Docker host resolution; 403 page from `data-root/_errors/forbidden-by-whitelist.html`. |
| `src/middleware/basicAuth.js` | 87 | HTTP Basic Auth against user accounts (node-persist), per-user option, rate-limited attempts. |
| `src/middleware/hostWhitelist.js` | 45 | Host-header validation (DNS-rebinding protection), config `hostWhitelist.*`; warn-only "scan" mode. |
| `src/middleware/accessLogWriter.js` | 59 | Logs each new client IP + UA to `data-root/access.log`; `migrateAccessLog()` moves legacy root `access.log`. |
| `src/middleware/cacheBuster.js` | 110 | Sends `Clear-Site-Data: "cache"` once per user+UA when `cacheBuster.enabled` (mounted on `/`). |
| `src/middleware/corsProxy.js` | 46 | `/proxy/:url(*)` forwarding fetch; strips identity headers; blocks circular requests. |
| `src/middleware/multerMonkeyPatch.js` | 30 | Re-decodes multer `req.file.originalname` Latin1→UTF-8 (multer #1104 workaround). |
| `src/middleware/userCss.js` | 19 | Serves `data-root/_css/user.css` at `/css/user.css` if present. |
| `src/middleware/validateFileName.js` | 44 | `getFileNameValidationFunction(field)` — rejects path separators/NUL in body fields; default export validates `avatar_url`. |
| `src/middleware/webpack-serve.js` | 55 | Spartan webpack-dev-middleware: serves compiled `lib.js`; `runWebpackCompiler()` invoked during pre-setup. |
| `src/plugin-loader.js` | 293 | Server plugin system from `plugins/` dir (opt-in `enableServerPlugins`); git auto-update; mounts plugin routers under `/api/plugins/<id>`. |
| `src/config-init.js` | 253 | `initConfig()` / `addMissingConfigValues()`: fills `config.yaml` from `default/config.yaml`, migrates old flat keys to new namespaced keys (also env vars via `keyToEnv`). |
| `src/command-line.js` | 383 | `CommandLineParser`: yargs parsing merged with config.yaml values; builds listen/browser-launch URL getters. |
| `src/constants.js` | 573 | Shared constants: `USER_DIRECTORY_TEMPLATE` (per-user dir names), `DEFAULT_USER`, `UNSAFE_EXTENSIONS`, provider key whitelists (`OPENAI_KEYS`, `VLLM_KEYS`, …), `CHAT_COMPLETION_SOURCES`, `TEXTGEN_TYPES`, Gemini/Vertex safety settings, `MEDIA_EXTENSIONS`, `UPLOADS_DIRECTORY = '_uploads'`. |
| `src/fetch-patch.js` | 40 | Wraps `globalThis.fetch` so `file://` URLs work but only inside the server dir and only for `.wasm`. |
| `src/private-request-filter.js` | 231 | SSRF guard: replaces `http/https.globalAgent` with an agent that resolves the host and blocks private IPs unless whitelisted (`privateAddressWhitelist.*` config). |
| `src/request-proxy.js` | 63 | Outgoing HTTP/SOCKS proxy via `ProxyAgent` (`requestProxy.*` config); sets `process.env.all_proxy`/`no_proxy`. |
| `src/sync/*` | — | Loreweaver offline two-way sync engine (scan, state, merge, transport, retention) + scheduler in `src/sync/index.js` (`start()`/`stop()` called from `server-main.js`). Spec: `docs/SYNC-SPEC.md`; code map: `15-sync-system.md`. |

## Key functions & routes (bulleted)

### Bootstrap order (strict)

1. `server.js:~12` — `CommandLineParser.parse()` → also calls `initConfig()` (config.yaml created/filled).
2. `server-main.js:~440-450` — startup chain: `initUserStorage(DATA_ROOT)` → `setDnsResolutionOrder()` → `ensurePublicDirectoriesExist()` → `migrateUserData()` → `migrateSystemPrompts()` → `migratePublicOverrides()` → `verifySecuritySettings()` → `preSetupTasks()` → `apply404Middleware()` → `new ServerStartup(app, cliArgs).start()` → `postSetupTasks()`.
3. `preSetupTasks()` (`server-main.js:~350`) — prints banner, `migrateGroupChatsMetadataFormat`, `checkForNewContent`, `diskCache.verify`, `migrateFlatSecrets`, `cleanUploads`, `migrateAccessLog`, `settingsInit()`, `statsInit()`, `loadPlugins()`, registers SIGINT/SIGTERM/uncaughtException graceful exit (stats flush → plugin cleanup → `diskCache.dispose()`), `initPrivateRequestFilter()`, `initRequestProxy()`, waits for webpack compile.
4. `postSetupTasks()` (`server-main.js:~400`) — browser launch, heartbeat file loop (`data-root/heartbeat.json`), window title, listen banner, emits `SERVER_STARTED`, starts sync scheduler (`syncScheduler.start()`).

### Middleware chain (`server-main.js:~75-320`, order matters)

- `helmet` (CSP off) → `compression` → `responseTime` → `bodyParser.json/urlencoded` (500 MB limit) → optional `cors()` (`cors.*` config) → optional `basicAuthMiddleware` (only when `listen` + `basicAuthMode`) → optional whitelist → `hostWhitelistMiddleware` → optional access logger.
- **`app.use('/api/sync', createSyncRouter(DATA_ROOT))` (`server-main.js:~117`) is mounted here — BEFORE cookie-session/CSRF/login** — because hub sync traffic authenticates with per-device bearer tokens, not ST sessions. Loreweaver-specific; whitelists still apply. See `15-sync-system.md`.
- `cookieSession` → `setUserDataMiddleware` (resolves `req.user` from session handle) → CSRF (`csrf-sync`; token header `x-csrf-token`; `/proxy/*` skipped when CORS proxy enabled; `--disableCsrf` disables with warning and returns `'disabled'` token).
- `GET /` (cache buster + login redirect), `GET /callback/:source?` (307 → `/?source=…&query=…`), `GET /login`, webpack serve, user CSS, `express.static(public)`.
- **Public API boundary**: `app.use('/api/users', usersPublicRouter)` is the only router before `requireLoginMiddleware`.
- After login requirement: `POST /api/ping` (session touch via `?extend`), `/proxy/:url(*)` (404+message when disabled), multer upload middleware (single field `avatar`, dest `data-root/_uploads`) + `multerMonkeyPatch`, `GET /version`.
- `redirectDeprecatedEndpoints()` → `setupPrivateEndpoints()` → later `apply404Middleware()` serves `data-root/_errors/url-not-found.html` (must be last).

### Router mounting (`server-startup.js`)

- `setupPrivateEndpoints(app):~122-170` mounts ~48 routers: `users` router at `/` (frontend file routes), `/api/users` (private + admin), `/api/moving-ui`, `/api/images`, `/api/quick-replies`, `/api/avatars`, `/api/themes`, `/api/openai`, `/api/google`, `/api/anthropic`, `/api/tokenizers`, `/api/presets`, `/api/secrets`, `/thumbnail`, `/api/novelai`, `/api/extensions`, `/api/assets`, `/api/files`, `/api/characters`, `/api/chats`, `/api/groups`, `/api/worldinfo`, `/api/stats`, `/api/backgrounds`, `/api/sprites`, `/api/content`, `/api/settings`, `/api/sd`, `/api/sd-follow`, `/api/horde`, `/api/vector`, `/api/translate`, `/api/extra/classify`, `/api/extra/caption`, `/api/search`, `/api/backends/{text-completions,kobold,chat-completions}`, `/api/openrouter`, `/api/nanogpt`, `/api/speech`, `/api/azure`, `/api/volcengine`, `/api/rpg-engine-kv`, `/api/minimax`, `/api/data-maid`, `/api/backups`, `/api/image-metadata`, `/api/sync-status` (login-protected UI status; device hub traffic stays on `/api/sync`). Details in `11-server-endpoints.md`.
- `redirectDeprecatedEndpoints(app):~86` — 40+ legacy `POST` names (`/createcharacter`, `/getchat`, `/getworldinfo`, …) 308-redirect to `/api/...` equivalents so old clients/links keep working.
- `ServerStartup.start()`:~310 — `enableIPv4/enableIPv6` may be `'auto'` (probes interfaces via `getHasIP()`); starts HTTPS (cert/key from `ssl.*`) or HTTP per stack with `ipv6Only: true`; tolerates one stack failing, `#fatal()` exits if the only enabled stack fails (EADDRINUSE message mentions another Loreweaver instance / `port` in config.yaml).

### Config & CLI

- `CommandLineParser.parse()` (`command-line.js:~100`): yargs options (`--port`, `--listen`, `--ssl`, `--whitelist`, `--dataRoot`, `--configPath`, `--corsProxy`, `--disableCsrf`, `--requestProxy*`, `--heartbeatInterval`, browser-launch args, deprecated `autorun*` aliases) fall back to config.yaml keys; `--global` / `globalThis.FORCE_GLOBAL_MODE` switches to OS data dir via `envPaths('SillyTavern')`. Validates IPv4/IPv6 protocol values (`true|false|'auto'`).
- `initConfig()` (`config-init.js:~230`): logs config path, registers it in `util.js`, runs `addMissingConfigValues()`.
- `addMissingConfigValues()` (`config-init.js:~130`): deep-merges `default/config.yaml` into user `config.yaml` and writes it back; `keyMigrationMap` (~40 entries) renames old keys (e.g. `disableThumbnails`→`thumbnails.enabled`, `autorun`→`browserLaunch.enabled`) and migrates matching env vars.

### Network guards

- `PrivateRequestAgent.connect()` (`private-request-filter.js:~150`): DNS-resolves the target, compares against RFC1918/loopback/link-local ranges, blocks unless in `privateAddressWhitelist.allowedRanges`; `allowUnresolvedHosts` opt-out; warns on startup when `listen` is on but filter disabled. Applies to all Node `http/https` requests through the global agents.
- `initRequestProxy()` (`request-proxy.js:~11`): `ProxyAgent` over the existing agents; warns that proxy bypasses the private filter for proxied requests.

### Plugin loader

- `loadPlugins(app, './plugins')` (`plugin-loader.js:~40`): disabled unless `enableServerPlugins`; optional git `pull` auto-update (`enableServerPluginsAutoUpdate`); loads `.js/.cjs/.mjs` files or npm packages (`package.json` `main`) or `index.*` dirs; plugin contract: exports `info{id,name,description}` + `init(router)` + optional `exit()`; router mounted at `/api/plugins/<id>`; returns cleanup fn used in graceful shutdown.

## Data structures & persistence

- `config.yaml` (server dir or global data dir): all server settings; auto-completed/migrated by `config-init.js`. Read everywhere via `getConfigValue(path, default, type)` from `src/util.js`.
- `globalThis.DATA_ROOT` (default `./data`, `--dataRoot`): contains `default-user/` (see `USER_DIRECTORY_TEMPLATE` in `src/constants.js:~14` — chats, characters, worlds, backgrounds, themes, vectors, backups, etc.), `_uploads/` (multer temp), `access.log`, `heartbeat.json`, `whitelist`-related error pages in `_errors/`, `_css/user.css`.
- `cookieSecret`: derived/managed in `src/users.js` (`getCookieSecret(DATA_ROOT)`); the legacy `cookieSecret` config key is removed by `config-init.js`.
- `whitelist.txt` (deprecated) still read at module load of `middleware/whitelist.js`.
- Access log: append-only `data-root/access.log`, one line per **new** client IP.
- Server plugins live in `./plugins/` (not synced, not user data).

## Interactions

- `src/users.js` (session/user storage) is the backbone of the login boundary — covered by its own concerns inside docs 11/12 usage but not separately mapped.
- Mounts every router from `src/endpoints/*` → see `11-server-endpoints.md`.
- Starts/stops the sync scheduler → `15-sync-system.md`, spec `docs/SYNC-SPEC.md`.
- `middleware/webpack-serve.js` consumes root `webpack.config.js` (frontend libs bundle) → affects `12-frontend-core.md`.
- `plugin-loader.js` + `/api/plugins/*` is the server half of the extensions story → `14-extensions-subsystem.md`.
- `private-request-filter` / `request-proxy` affect **all** outbound fetches from endpoint modules (LLM calls, image gen, extension installs).

## Gotchas

- **Mount order is load-bearing**: `/api/sync` must stay before `cookieSession`/CSRF/`setUserDataMiddleware`, or device bearer-token sync breaks (Loreweaver change; documented inline in `server-main.js:~110`). Conversely, `usersPublicRouter` must remain the only pre-login router; `apply404Middleware()` must run after all routers or it swallows them.
- `getWhitelistMiddleware()` is awaited at module top-level of `server-main.js` — whitelist/Docker-host resolution happens once at startup; changing `whitelist` config requires restart.
- Multer field name is fixed to `avatar` for *all* uploads server-wide (`server-main.js:~290`); endpoints re-read `req.file`. `bodyParser` limits (500 MB) apply globally — huge uploads are possible by design.
- `enableIPv4/IPv6: 'auto'` silently depends on whether `listen` is on (`hasIPv6Any` vs `hasIPv6Local` probes).
- `redirectDeprecatedEndpoints` uses **308** (method-preserving) — 301 would break POST bodies.
- The private request filter resolves every hostname itself; a filtered server cannot talk to unresolved hosts unless `privateAddressWhitelist.allowUnresolvedHosts: true` (relevant for localhost-only backends like KoboldAI/Ooba — they resolve to private IPs, so the filter blocks them unless whitelisted).
- `src/fetch-patch.js` runs at import time (side-effect import at top of `server-main.js`); only `.wasm` files under the server dir are fetchable via `file://`.
- `server-global.js` (`FORCE_GLOBAL_MODE = true`) is how the packaged app forces OS-level config/data paths regardless of `--global`.
- Deprecated `whitelist.txt` is read synchronously at module import — its entries silently override config `whitelist` if the file exists.
- Body fields validated by `getFileNameValidationFunction` reject `/`, `\` (Windows), and NUL — endpoints relying on it include characters, avatars, groups, settings snapshots, chats.
- CSRF skip rule: `/proxy/*` is exempt **only** when `--corsProxy` is enabled; otherwise proxy requests need a token too.
- Heartbeat file loop uses `setInterval(...).unref()` — it never keeps the process alive and never cleans up on shutdown (harmless by design).
