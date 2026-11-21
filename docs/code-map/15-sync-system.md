# 15 — Sync System (Code Map)

> Offline-capable two-way sync between Loreweaver devices over a hub-and-spoke topology.
> **This is a code map. The design lives in [`docs/SYNC-SPEC.md`](../SYNC-SPEC.md)** — read it
> before touching sync (its section 12 is the acceptance checklist). Device onboarding:
> [`docs/SYNC-ONBOARDING.md`](../SYNC-ONBOARDING.md). Tests: `tests/sync/` (123 tests, plain Node + jest-style).
> Paths relative to repo root. Line refs approximate, written 2026-11-24.

## Purpose & user-facing surface

- Personal multi-device sync (Windows PC ↔ hub server ↔ Android) for everything under
  `data/` (chats, characters, worlds/lorebooks, settings) — **never API keys** (per-device
  secrets). No cloud drives; devices talk to the hub over Tailscale.
- Client status UI: `public/scripts/sync-status.js` — polls `/api/sync-status`, shows
  enabled/last-run/last-error in settings.
- Device tokens are minted by the CLI `sync-token.js` (repo root) — `node sync-token.js <device>`
  prints a bearer token to configure on the client.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `src/server-main.js` | — | Mounts the hub router at `/api/sync` (line ~161) **before** session/CSRF middleware (line ~175+) so bearer-token device traffic skips CSRF; starts scheduler via `syncScheduler.start()` (~line 457) |
| `src/endpoints/sync.js` | 563 | The HUB: `createSyncRouter(dataRoot)` — all hub routes + per-handle locking + state maintenance |
| `src/endpoints/sync-status.js` | 112 | Cheap status endpoint for the client UI (enabled, retention, last result) |
| `src/sync/index.js` | 182 | The SCHEDULER (client role): `runSyncOnce()` (~53), `start()/stop()` (~144/161), config reader (`sync.*` keys ~29-44) |
| `src/sync/engine.js` | 508 | `createSyncEngine(options)` (~48) — the client engine: diff local↔hub, push/pull/delete, chat fast-forward, conflict copies |
| `src/sync/transport-http.js` | 129 | HTTP transport wrapping the hub routes with the device bearer token |
| `src/sync/paths.js` | 182 | Path safety: `normalizeSyncPath` (~64), `isSyncPathAllowed` (~110), `validateSyncPath` (~158), `resolveSyncPath` (~175) — rejects traversal/absolute/denied paths |
| `src/sync/scan.js` | 267 | Filesystem primitives: `scanDirectory` (~135), SHA-256 hashing with stable-file guard `readStableFile` (~147), crash-safe `atomicWriteFile` (~182), `moveToTrash` (~237) |
| `src/sync/state.js` | 307 | Device identity + seq bookkeeping: `loadOrCreateDevice` (~20), token hash compare `safeEqual` (~278), `atomicWriteJson` (~285) |
| `src/sync/merge.js` | 137 | Chat-aware merge: `isChatPath` (~19), `splitChatLines/joinChatLines` (~32/60), `chatPrefixMerge` (~79), `planMerge` (~116) dispatching to chat-prefix or generic conflict-copy |
| `src/sync/settings-merge.js` | 120 | `settings.json` per-key 3-way merge: `mergeSettingsBuffers(base, local, hub, winner)` (~101), node merge `mergeNode` (~37) |
| `src/sync/retention.js` | 70 | `pruneRetention` (~19): deletes `sync-trash/` + `sync-conflicts/` entries older than `sync.retentionDays` (runs on both hub and client schedulers) |
| `sync-token.js` | 145 | CLI: mints device tokens (device name → token + hash stored hub-side) |

## Key functions & routes

Hub routes (all under `/api/sync`, auth = `Authorization: Bearer <device token>`; unknown or
unhashed-token devices rejected):

- `POST /hello` — `src/endpoints/sync.js:~299` — device announces itself; returns its change-log
  cursor. First contact enrolls the device (state row created by `loadOrCreateDevice`).
- `GET /changes?cursor=N` — `~321` — hub-assigned change-log entries after `seq=N` (ordering
  authority is the hub; every applied change gets the next `seq`).
- `GET /file?path=…` / `PUT /file` / `DELETE /file` — `~343`/`~498` — content transfer with
  base+hash 3-way conflict detection server-side.
- Internal maintenance: `rescanHandle` (~224) rebuilds the hub's file index; `applyLocalDrift`
  (~193) records edits the HUB itself made to its own `data/` (hub runs Loreweaver too);
  `withHandleLock` (~87) serializes per-device work.

Client flow (`runSyncOnce` — `src/sync/index.js:~53`):

1. Scan local `data/` (`scanDirectory` + hash cache) → local file list with SHA-256.
2. `hello` + fetch hub `/changes` since cursor; fetch/push changed files via transport.
3. Merge: `planMerge` per path — chat files fast-forward by message prefix (the longer side
   wins if one is a strict prefix; otherwise conflict copy); every other divergence keeps BOTH
   (winner under `data/…`, loser as conflict copy under `sync-conflicts/`). Deletes are never
   hard-removed — moved to `sync-trash/` first.
4. `settings.json` merges per-key (`mergeSettingsBuffers`); `sync.settingsAuthoritativeDevice`
   names the device whose value wins key clashes (set ONLY in that device's config; currently
   the packaged app `windows-app`).
5. Persist new cursor + device state (`state.js`), prune retention (`retention.js`).

## Data structures & persistence

- Hub state: `<DATA_ROOT>/sync/` (device registry with SHA-256-hashed tokens, change log, file
  index). Written only via `atomicWriteJson`.
- Client state: same layout under the client's data root.
- Trash/conflicts: `data/<user-handle>/sync-trash/` and `sync-conflicts/` (retention-pruned).
- Config keys (`config.yaml`): `sync.enabled`, `sync.hubUrl` (client), `sync.retentionDays` (30),
  `sync.syncExtensions` / `sync.syncSecrets` (opt-ins widening the deny list), `sync.settingsAuthoritativeDevice`.

## Interactions

- Server core (map 10): mount order in `server-main.js` is the critical contract.
- Frontend (map 12): `public/scripts/sync-status.js` status block in settings.
- The RPG engine's KV endpoint (`rpg-engine-kv`) is NOT synced by this system; the engine runs
  its own client-side store + Loreweaver-server mirroring (see engine map 21).

## Gotchas

- **Mount order**: `/api/sync` MUST be registered before session/CSRF/basic-auth body middleware
  in `server-main.js` — device calls carry no cookies/CSRF tokens. Moving it breaks every device.
- Both hub AND client need the opt-in flags (`sync.syncExtensions`/`sync.syncSecrets`) set for
  extensions/secrets to flow; nested `secrets*` paths are always denied regardless.
- Nested `secrets*` under any folder is always denied (hard-coded deny, opt-ins can't override).
- Writes are only ever applied through `atomicWriteFile` — never `fs.writeFile` directly in sync
  code (crash-safety depends on it; tested in `tests/sync/scan-state.test.js`).
- Conflict policy is "never lose data": the loser of any merge becomes a conflict copy — do not
  "simplify" `planMerge` to last-writer-wins.
- The hub also RUNS Loreweaver and edits its own `data/`; `applyLocalDrift` exists so hub-side
  edits get seq numbers too. Removing it silently diverges hub-vs-device views.
