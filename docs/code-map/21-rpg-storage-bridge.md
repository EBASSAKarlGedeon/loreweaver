# 21 — RPG Engine: Storage, Persistence & Loreweaver Bridge (Code Map)

> ⚠️ **Nested repo boundary:** the app source lives inside the RPG engine's own git repo at
> `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/` (patch log: `PATCHES.md`
> there; `app/src/scripts/storage.js` etc.). The **server side** (`src/endpoints/rpg-engine-kv.js`,
> `src/server-startup.js`, `src/sync/*`) is Loreweaver repo root code. All engine paths below are
> given from the **Loreweaver repo root**. Paths relative to repo root. Line refs are approximate
> (`file:~line`). Written 2026-11-24.

## Purpose & user-facing surface

The engine keeps everything (adventures, hero library, worlds, community records, embedding
vectors) in a browser-IndexedDB KV store. Loreweaver adds two server bridges on top:

- **Server-side saves** (`shims/loreweaver-storage.js`): every mutating write to the `rpg` and
  `worlds` KV folders is mirrored to `data/<user-handle>/rpg-engine/kv/` on the Loreweaver
  server via the `/api/rpg-engine-kv/*` endpoints, so Phase 2 sync (doc 15) carries game saves
  between devices like any other file. User-visible effect: adventures/worlds survive a
  device switch; a fresh browser boots into the other device's saves after reconcile.
- **AI bridge** (`shims/loreweaver-bridge.js`): text generation routes through Loreweaver's
  Connection Manager profiles (`/api/backends/chat-completions/generate`); API keys never reach
  the page. (Full request-flow detail belongs to doc 23; the storage interaction here is the
  `rpge.loreweaverBridge` localStorage config.)

User-facing settings surface: `localStorage["rpge.serverSaves"] = { enabled:false }` turns
mirroring off (default on); Settings → Data & Backup (backup.js) is the manual export/import of
everything; Settings → Storage shows browser + app byte reports.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `app/shims/perchance-shim.js` | 206 | Stand-in for the Perchance platform: defines `root.kv` — IndexedDB DB `rpge-kv`, one store, folder = key prefix `folder\0key`; also offline stubs (`generateImage` rejects, `uploadPlugin`/`createServerSocket`/`commentsPlugin` reject "offline") |
| `app/shims/loreweaver-storage.js` | 340 | The server mirror: wraps `root.kv`, debounced write-through, boot reconcile, tombstones, conflict copies |
| `app/shims/loreweaver-bridge.js` | 258 | The AI bridge shim: fetch wrapper rewriting `/chat/completions` calls to the Loreweaver endpoint, per-job role matrix (see doc 23) |
| `app/shims/tweaks.js` | 45 | Small DOM/timing fixes injected before the app (load order: bridge → perchance-shim → tweaks → boot.js → main.js) |
| `app/src/scripts/storage.js` | 279 | `SessionStore` + `HeroStore` + save export/import over the `rpg` folder |
| `app/src/scripts/backup.js` | 687 | Settings → Data & Backup: full-browser export/import `.mno-backup` |
| `app/src/scripts/storage-errors.js` | 321 | One place that knows what "local storage unavailable" looks like; degraded-window logic; resilient partial backup download |
| `app/src/scripts/storage-info.js` | 44 | `fmtBytes` + `navigator.storage` browser report |
| `app/src/scripts/libcache.js` | 145 | Sharded added-world file cache (one IndexedDB key per world) |
| `app/src/scripts/embeddings.js` | 447 | MiniLM vectors + RRF fusion with BM25 (kv folder `embvec`) |
| `app/src/scripts/bm25.js` | 139 | Tiny BM25 ranker for per-turn GM context selection |
| `app/src/scripts/last-edit.js` | 37 | Landing footer "last edited x ago" |
| `app/src/scripts/perchance-limits.js` | 14 | Dead constants since patch 018 (kept importable for fallbacks) |
| `src/endpoints/rpg-engine-kv.js` | 181 | Loreweaver server: `/api/rpg-engine-kv` router (list/get/put/delete + tombstones) |
| `src/server-startup.js` | ~190 | Mounts the router at `/api/rpg-engine-kv` (line ~188, inside the normal session/CSRF-protected route block — unlike the sync router, which must mount early) |
| `src/sync/paths.js` | 182 | `SYNCED_DIRS` includes `USER_DIRECTORY_TEMPLATE.rpgEngine` = `'rpg-engine'` (constants.js:~44), so `data/<handle>/rpg-engine/**` syncs |
| `src/sync/scan.js` | 267 | `atomicWriteFile` used by the kv endpoint (crash-safe writes) |

## Key functions

### Browser-side KV (`perchance-shim.js`)

- `makeFolder(name)` — perchance-shim.js:~35 — the folder API: `get/getMany/has/set/setMany/
  delete/deleteMany/keys/values/entries/clear/update`. `update` does read-modify-write inside
  ONE transaction (callers rely on that: no interleaved `get`+`set` races). Values are
  structured-clone-purified via `JSON.parse(JSON.stringify(v))`.
- `kv` Proxy — perchance-shim.js:~67 — any property access creates the folder on demand. Folders
  in use: `rpg`, `worlds`, `community`, `embvec` (doc 24/25 cover content schemas).
- `boot.js` copies `root.kv` to `window.kv`; loreweaver-storage.js then **replaces**
  `window.root.kv` with the mirroring Proxy (see below), so the app's `new SessionStore(kv)` /
  `new WorldStore(kv)` transparently get mirrored folders.

### Store layer (`storage.js`)

- `new SessionStore(kv)` / `list()` — storage.js:~13/23 — reads `rpg/sessions` (the adventure
  index). Reads never throw raw storage errors: a fallback `[]` is returned but TAGGED
  (`markFallbackList`) so writers can tell "truthfully empty" from "storage failed".
- `SessionStore.save(state, {touch})` — storage.js:~38 — writes `rpg/session_<id>` (the full
  save) then `rpg/sessions` (the index). Index entries carry a cached ~2–4 KB `avatar` data-URL
  thumbnail + `portraitSig` fingerprint so the 52px list faces never decode megabyte saves per
  turn (re-derived only when the portrait changed). While storage is degraded an empty index is
  suspect — the blob write proceeds (id-keyed, can't clobber), the index write is refused and a
  friendly tagged error raised so the UI opens the backup panel.
- `SessionStore.load(id)` — storage.js:~86 — a failed read reads as "missing" (graceful fallback).
- `SessionStore.backfillAvatars(entries, onFace, {max:24})` — storage.js:~96 — background one-at-
  a-time thumb backfill for pre-avatar entries; persists via `rpg.update("sessions", …)` (single
  transaction, merges only the two fields it owns).
- `SessionStore.remove(id)` — storage.js:~117 — read-then-delete (suspect-empty guard again);
  also drops `ctxmeter_<id>` (nicety) and clears `activeSession` if it pointed here.
- `SessionStore.getActive()/setActive(id)` — storage.js:~138/142 — `rpg/activeSession` pointer so
  a reload resumes the chat (`main.js init()` ~637 auto-enters it); a failed write only costs
  auto-resume, never the save.
- `new HeroStore(kv)` / `list/findByLabel/save/remove` — storage.js:~162/168/177/186/219 — global
  hero library (bio + avatar only; stats are per-world) in `rpg/savedHeroes`, capped
  `MAX_SAVED_HEROES = 40`, save-slot labels case-insensitive, overwrites keep the slot's id.
  Same suspect-empty rule before writing the list.
- `exportState(state)` / `parseImported(raw)` — storage.js:~246/263 — download as
  `<name>.mno-adv` (v2 payload `{version:2, ...state}`); import validates v1/v2, throws TAGGED
  errors (`isBackupFile` / `isWorldFile`) when handed a full backup or a world so the importer
  can offer the right button instead of "Unsupported save version".
- `WorldStore` — world.js:~712 — worlds live in the `worlds` folder (`index` = card meta list,
  one record per world id = the full world file). Documented in doc 24; listed here because it
  rides the same error helpers and the same mirror.

### Storage-failure policy (`storage-errors.js`)

- `safeStorageRead(fn, fallback, tag, onFallback)` / `withStorageRetry(fn, {retries})` —
  storage-errors.js:~40/~55 — reads retry once then fall back; writes retry once then throw a
  friendly tagged Error (`isStorageUnavailable`) — "Couldn't save that adventure — this device
  may be low on space… Nothing was deleted."
- `markStorageDegraded()` / `markStorageHealthy()` / `isStorageDegraded()` — storage-errors.js
  ~24/28/32 — any proven failure marks storage degraded for `DEGRADED_WINDOW_MS` (120 s); a
  succeeding read lifts it. The degraded window is what makes an EMPTY list read suspect
  (storage.js refuses index overwrites from it — the classic "I lost everything" bug).
- `notifyStorageError(notify, action, err)` — storage-errors.js:~70 — throttled toast (30 s
  window) plus, for critical failures, ONE popup panel (30-s throttle) with a one-click
  "Download everything" partial backup; never fires for non-storage errors (real bugs stay
  loud). Leaves `window.__mnoLastStorageError` + a console.warn with the original error.
- `buildResilientBackup(...)`-style partial download lives here too — every read optional, a
  partial backup still downloads rather than aborting (never throws).

### Backup (`backup.js` — loaded on demand, never in boot path)

- `KV_REGISTRY` — backup.js:~47 — kv exposes no folder enumeration, so export walks an explicit
  registry: `rpg` (sessions, activeSession, savedHeroes, `^session_`), `worlds` (index + all),
  `community` (user/links/library/settings/pendingDeletes + opt-in `^cache:` shards). Deliberately
  absent: `embvec` (derived, rebuilds itself) — the Storage readout reports it separately.
- `buildBackup({includeCache, includeUser})` — backup.js:~107 — one plain JSON
  `{format:"mno-backup", version:1, exportedAt, user, community, rpg, worlds, localStorage}`
  (`LS_KEYS` ~58: the chosen machine-local prefs incl. `mno.showNsfw`, `mno.aiProvider`,
  `mno.worlds.folders*`, Tavern nick). Downloads as `.mno-backup`.
- `restoreBackup` path (~239/513) applies the same registry/LS_KEYS in reverse (merge or
  replace); import validates by the `format` field, so legacy `.json` backups still import.
- The file carries the **creator code** (device secret = master key to published worlds);
  WARNING_HTML (~62) is shown on every export — that warning is the entire protection.

### Search infra

- `bm25.js` — `rank(queryText, docs, getText)` — bm25.js:~72 — BM25 (K1 1.2, B 0.75) with the
  normalization that made live turns work: dots→space + single-letter-run rejoining
  (`G.I.N.A.`→`gina`), apostrophe strip, naive singularize, top-40 informative query terms plus
  always-kept capitalized names, `BM25_NO_KEYWORD_PENALTY` 0.4 for entries the author's
  keywords/triggers never matched verbatim. Scores are per-turn, never stored. `lorebook.js`
  imports STOPWORDS direction only (no cycle).
- `embeddings.js` — all-MiniLM-L6-v2 (384-dim, ~23 MB) inside a **blob-shimmed worker only** (the
  preview iframe forbids cross-origin worker URLs; the main thread keeps hashing/RRF/kv-cache
  only). `vecKey(text)` (~55) = `m6q1_` + fnv1a(text) into kv folder `embvec` (cap 5000 entries,
  ~7.5 MB, age 60 d, 7-day sweep). `fuseRrf`/`rrfIndices` (~89/68) blend BM25 + cosine ranks
  (RRF K=60, `EMB_COS_MIN` 0.25 floor). Everything degrades silently to BM25-only; vectors are a
  derived cache — never in saves/exports/backups, no per-turn kv writes in steady state.

### Small storage modules

- `libcache.js` — one IndexedDB key per added world (`cache:<worldId>` → `{jsonHash, text,
  bytes, cachedAt}`) with one-shot migration from the legacy single `cache` blob (which could
  exceed Chrome's IndexedDB read limit and take Explore/backup down with it). All calls never
  throw; unreadable legacy data is left in place, never silently deleted.
- `storage-info.js` — `fmtBytes(n)` (~13, 1024-based, mixed precision) and
  `readBrowserStorage()` (~34, verbatim `navigator.storage` estimate — deliberately NOT merged
  with the app's own byte count, which lives in backup.js's Storage readout).
- `last-edit.js` — `initLastEdit()` (~13) fills `#lastEditEl` from
  `window.generatorLastEditTime` (fetched from `/api/getGeneratorStats` when absent),
  repaints every 30 s; `update-check.js` calls `window.__refreshLastEdit` on a confirmed bump.
- `perchance-limits.js` — `PERCHANCE_INPUT_CAP` 6976 + `PERCHANCE_CHARS_PER_TOKEN` 4.0: dead
  constants kept importable (no side effects) for fit-measure fallback paths since patch 018
  removed the Perchance text AI.

## The Loreweaver server bridge (end-to-end)

**Persistence model:** browser IndexedDB (`rpge-kv`) is ALWAYS the primary store — instant
reads/writes, the game works offline and under standalone serving. The server copy is a
write-through mirror used only for cross-device sync; mid-session remote saves appear at next
page load (reconcile runs at boot only).

- `shims/loreweaver-storage.js init(origKv)` — loreweaver-storage.js:~284 — installs a Proxy over
  `window.root.kv` that wraps the `rpg` and `worlds` folders (`MIRROR_FOLDERS` ~36) with
  `mirrorFolder(name, folder)` (~127); non-mirrored folders pass through untouched.
- **What is mirrored:** `rpg` (sessions, `session_<id>`, activeSession, savedHeroes,
  ctxmeter caches) and `worlds` (index + every world file). NOT mirrored: `embvec`
  (regenerable megabytes) and `community` (deprecated features).
- **Write-through:** every mutating call (`set`/`setMany`/`update`/`delete`/`deleteMany`/`clear`)
  is mirrored after the local write resolves, debounced per key (`DEBOUNCE_MS` 400, timers
  Map ~120). `clear()` wipes the whole folder server-side via list+delete so a boot reconcile
  cannot resurrect keys.
- **Server endpoint** (`src/endpoints/rpg-engine-kv.js`): router mounted at `/api/rpg-engine-kv`
  (`src/server-startup.js:~188`), session + CSRF protected (same session as the rest of
  Loreweaver). Routes: `POST /list` (~85; all entries with mtimeMs+size), `/get` (~102),
  `/put` (~117; content must be a string, written with `atomicWriteFile` from `src/sync/scan.js`,
  and a successful put deletes any tombstone), `/delete` (~148; writes a `<name>.tomb.json`
  marker `{"deletedAt": <now>}` before unlinking the data file). Storage root:
  `data/<handle>/rpg-engine/kv/`; `SYNCED_DIRS` includes `rpg-engine` (`src/sync/paths.js:~27`,
  template constant `src/constants.js:~44`) so Phase 2 sync carries it.
- **Key naming:** client sends opaque filesystem-safe names — base64url of `"folder\0key"`
  (`nameOf()` loreweaver-storage.js:~62) + `.json`. The endpoint's `NAME_RE` (~24) allowlists
  `[A-Za-z0-9_-]+` optionally suffixed `.json`/`.tomb.json` or carrying the mid-name
  `.conflict-<ms>` marker; `dataFile()`/`tombFile()` re-verify `resolved.startsWith(dir)`.
- **Bookkeeping:** per-key "last pushed server mtime" in `localStorage["rpge.kvMeta"]`
  (`readMeta`/`writeMeta` ~77/80). A server entry whose mtime ≤ pushed mtime is "unchanged since
  our last push" and skipped.
- **Reconcile on boot** (`reconcile(origKv)` loreweaver-storage.js:~207, scheduled via
  `requestIdleCallback` 12-s cap): lists server entries; server-newer data files are pulled and
  written into IndexedDB; identical-content-but-newer-mtime is just adopted; **local-only keys
  are pushed** unless a NEWER tombstone says another device deleted them (then the local copy is
  deleted); tombstones clean up bookkeeping. Fires the `rpge-saves-synced` window event
  afterwards so late-boot pages (import/bridge panels) re-render from server data.
- **Conflict handling:** when BOTH sides changed since the last known sync, the SERVER value
  wins into the browser and the local version is preserved server-side as
  `<name>.conflict-<Date.now()>.json` (it syncs too; the game UI doesn't read these yet) —
  console `[rpge saves] CONFLICT on … kept as a conflict copy` (loreweaver-storage.js:~242).
  Never data loss; the loser always survives somewhere.
- **Pre-sync push skip:** the v1 clobber bug — a fresh browser's own boot writes (e.g. worlds
  index normalization) used to push the local empty state to the server BEFORE the first
  reconcile, zeroing the server's data (survivors only as conflict copies). Fix (~43/130): the
  shim fetches the server entry-name list early (`serverNames` Set) and, until
  `firstSyncDone`, a push/delete/wipe is allowed ONLY for keys the server does not have; keys
  the server has are left for the reconcile to merge.
- **Config:** `localStorage["rpge.serverSaves"] = {enabled:false}` disables mirroring (default
  on); `window.LoreweaverSaves` (~323) is a debug API (`isEnabled`, `meta()`, `reconcileNow()`).
- **Cross-tab/event plumbing:** BroadcastChannel `rpge-kv` forwards `worlds-changed` messages as
  the `rpge-worlds-changed` window event so the Worlds list refreshes live after imports
  (loreweaver-storage.js:~332; main.js listens).
- **AI bridge storage touchpoint:** config lives in
  `localStorage["rpge.loreweaverBridge"] = {enabled, usePreset, roles, contextTokens}`; patch 018
  writes a first-run default `{enabled:true, usePreset:true, contextTokens:16384}` at module load
  (ai-provider.js), so a fresh browser generates through Loreweaver's selected profile with zero
  setup. `loreweaver-bridge.js` fetches profiles/settings from `/api/settings/get` (5-min TTL)
  and POSTs with the session CSRF token (`/csrf-token`, retry once on rotation).

## Data structures & persistence (summary)

| Where | What | Persistence |
|---|---|---|
| IndexedDB `rpge-kv`, folder `rpg` | `sessions` index, `session_<id>` blobs, `activeSession`, `savedHeroes`, `ctxmeter_<id>` | browser + server mirror |
| IndexedDB, folder `worlds` | `index` + one record per world id (full world file) | browser + server mirror |
| IndexedDB, folder `community` | user/links/library/settings/pendingDeletes + `cache:<worldId>` shards | browser only (deprecated mirror) |
| IndexedDB, folder `embvec` | `m6q1_<fnv1a>` → MiniLM vectors | browser only, derived, swept |
| Server `data/<handle>/rpg-engine/kv/` | base64url-named `.json` values + `.tomb.json` + `.conflict-<ms>.json` | synced via doc 15 |
| localStorage | `rpge.kvMeta`, `rpge.serverSaves`, `rpge.loreweaverBridge`, `mno.*` prefs | browser only (selected keys ride backups) |
| `.mno-adv` / `.mno-world` / `.mno-backup` files | manual export/import (save / world / everything) | local files |

## Interactions

- **Doc 15 (sync system):** the whole reason the mirror exists — `SYNCED_DIRS` + hub change-log
  treat `rpg-engine/kv/*` like any synced file; tombstones prevent offline-deletion
  resurrection by another device's boot reconcile.
- **Doc 11 (server endpoints):** rpg-engine-kv.js is one of the grouped routers; its writes reuse
  `src/sync/scan.js`'s `atomicWriteFile`.
- **Doc 22 (main.js):** every store consumer (session/world/hero flows, ctx-meter caches);
  `unhandledrejection` last-resort net in main.js ~75 swallows + toasts storage errors only.
- **Doc 23 (AI plumbing):** the bridge shim + `rpge.loreweaverBridge` config; embeddings/bm25
  feed GM context selection.
- **Doc 24 (worlds):** WorldStore/libcache/share-external world files.

## Gotchas

- `world.root.kv` is REPLACED at shim init — code that captured the raw folder reference before
  the shim runs sees unmirrored storage. The shim relies on module load order (bridge →
  perchance-shim → storage shim → boot.js → main.js).
- Reconcile is boot-only: saves synced in mid-session appear at next page load; conflict copies
  are preserved but not surfaced in the game UI yet (v1 limitation, stated in the shim header).
- Tombstone arithmetic: local-only keys are deleted locally when `tomb.mtimeMs > pushed` — the
  per-key pushed mtime (kvMeta) is the clock; a key pushed before the delete is correctly seen
  as locally stale.
- An empty `sessions` read is NOT proof of an empty library: reads fall back to `[]` on failure
  and tag it — writing an index derived from that read orphans every other adventure. All three
  stores (session, hero, world) guard this.
- The kv endpoint allowlists names, so conflict-copy names must keep passing `NAME_RE` — new
  suffix shapes need the regex extended on BOTH client and server.
- The kv router mounts in the NORMAL route block (session+CSRF), unlike the sync hub router
  which must mount before session middleware; the storage shim therefore needs the browser
  session (cookies) and the `/csrf-token` handshake — standalone serving (python http.server)
  keeps the game running on IndexedDB alone.
- `embvec` keys embed a model/quantization prefix (`m6q1_`); bump it when the model changes so
  stale vectors get swept rather than trusted.
- Backup files contain the creator code — a master key for published worlds; never treat a
  `.mno-backup` as a shareable artifact (the export warning is the only guard).
