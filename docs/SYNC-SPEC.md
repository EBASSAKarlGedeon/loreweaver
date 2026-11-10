# Loreweaver Sync Spec (Phase 2)

Status: DESIGN APPROVED, NOT IMPLEMENTED. Written so a cheaper model can implement it milestone by milestone.
Read `CLAUDE.md` first (working agreements: minimal changes to ST code, small commits, never push without asking).

## 1. Goal and decisions already made

Offline-capable two-way sync of user data between Windows, Linux and Android devices.

| Decision | Choice |
|---|---|
| Topology | **Hub and spoke.** One always-on hub (the owner's personal server) plus N client devices. Clients never talk to each other. |
| Transport | HTTPS/HTTP between the clients' local Loreweaver backend and the hub's Loreweaver backend, over **Tailscale**. |
| Hub software | The same Loreweaver Node server, with `sync.role: hub`. No separate product. |
| Who syncs | The **local Node backend** of each device runs the sync engine (not the browser). This keeps it identical on Windows, Linux, Electron and Android (nodejs-mobile). |
| Granularity | **File-level** sync with content hashes. Chats get one smarter merge rule (section 6). No record-level CRDTs. |
| Conflict policy | **Never lose data.** The loser is always preserved as a conflict copy. |
| Secrets | `secrets.json` is **not synced by default** (API keys are per-device). Opt-in via `sync.syncSecrets: true` — see the addendum at the end. |
| Cloud drives | Not used. The transport is behind an interface (section 9) so WebDAV/OneDrive could be added later. Out of scope now. |

Expected usage (drives the design): one person, one device active at a time (Windows evenings, Linux work hours, phone away from home). Real concurrent edits of the same file are rare. Optimise for fast-forward syncs being trivial and correct, and for conflicts being safe rather than clever.

## 2. What syncs

Per user handle (start with `default-user` only; the handle is part of every path). Paths are relative to `data/<handle>/`.

Synced (directory names come from `USER_DIRECTORY_TEMPLATE` in `src/constants.js`):
`chats`, `group chats`, `characters`, `groups`, `worlds`, `User Avatars`, `backgrounds`, `themes`, `movingUI`, `QuickReplies`, `instruct`, `context`, `sysprompt`, `reasoning`, `NovelAI Settings`, `KoboldAI Settings`, `OpenAI Settings`, `TextGen Settings`, `user/files`, `user/images`, `user/workflows`, plus the root file `settings.json`.

NOT synced (hard-coded deny list; two items are opt-in-able, see the addendum):
- `secrets.json` (API keys) and anything matching `**/secrets*` — **except** the exact root file `secrets.json` when `sync.syncSecrets: true` (opt-in; nested `secrets*` copies stay denied always).
- `thumbnails/**` (regenerable cache), `vectors/**` (regenerable, large), `backups/**` (local safety net).
- `extensions/**` (third-party code) — **except** when `sync.syncExtensions: true` (opt-in; open question Q2, resolved).
- `assets/**` (large downloadable media; revisit later, open question Q3).
- Account/auth data: `data/_storage`, `data/_uploads`, cookie secret, user account records. These live outside `data/<handle>/` anyway.
- Temp and partial files: `*.tmp`, `*.partial`, `.git*`, `Thumbs.db`, `desktop.ini`, and the sync engine's own state files. These can never be opted in.

`config.yaml` sync allow-list may only *narrow* the synced set, except for the two opt-ins above, which are bounded and explicit.

Known wrinkle, RESOLVED: `settings.json` mixes UI preferences with a few device-specific values. It now syncs via a **per-key 3-way merge** (see section 8.1) with a small device-local key list, not whole-file last-writer-wins.

## 3. Identity and state

- `deviceId`: random UUID, generated on first run, stored in `data/_sync/device.json`. Never synced.
- Hub keeps `data/_sync/hub.json`: `{ seq, devices: { <deviceId>: { name, tokenHash, lastSeen } } }`.
- Every device (including the hub itself) keeps a **base table** `data/_sync/state-<handle>.json`:
  `{ "<relPath>": { hash, size, mtimeMs, hubRev } }` = the file's state as of the last successful sync. This is the "common ancestor" for 3-way decisions.
- Hub keeps a **change log** `data/_sync/changes-<handle>.jsonl`, one line per change:
  `{ seq, path, op: "put"|"delete", hash, size, deviceId, ts }`. `seq` is a hub-assigned, strictly increasing integer. **The hub's `seq` is the only ordering used. Device clocks are never trusted for ordering** (mtime is a tiebreaker for display only).
- Hub also keeps an index `path -> { hash, size, rev(seq), deleted }` (rebuildable from a full scan).
- Hash = SHA-256 hex of file bytes.

## 4. Hub awareness of its own edits

The hub is also a normal Loreweaver instance that may be used directly. It must notice local edits without hooks into ST's code:
- Before serving any sync request, the hub rescans the synced directories. Hash is cached per path keyed on `(size, mtimeMs)` so unchanged files are not re-read.
- Files that differ from the index get a new `seq` entry with `deviceId: "hub"`. Files missing from disk but present in the index get a `delete` entry.
- Rescan must be cheap: directory walk plus `stat` only. Run at most once per second under load (coalesce).

## 5. Protocol

All endpoints under `/api/sync/*`, JSON unless noted, handled by a new router `src/endpoints/sync.js` registered in `src/server-startup.js` (one import plus one `app.use`, nothing else touched).

Auth: header `Authorization: Bearer <deviceToken>`. Tokens are issued once by the hub admin (CLI command or admin-only endpoint), stored hashed (sha256 of the token). The hub validates the token on every `/api/sync/*` call and does not use ST's normal session or CSRF flow for these routes (they need their own middleware). Tailscale provides transport encryption; the token provides authorization.

| Endpoint | Purpose |
|---|---|
| `POST /api/sync/hello` | Body `{ deviceId, name, protocol: 1 }`. Returns `{ hubSeq, protocol, serverTime }`. Registers or updates the device. |
| `GET /api/sync/changes?handle=H&since=N` | Returns `{ hubSeq, changes: [{seq,path,op,hash,size}] }`, collapsed to the latest entry per path, ordered by seq. Paginated with `limit` plus `nextSince`. |
| `GET /api/sync/file?handle=H&path=P` | Streams file bytes. Response headers `X-Content-Hash` and `X-Mtime-Ms` (the hub copy's mtime, ms since epoch). |
| `PUT /api/sync/file?handle=H&path=P&baseRev=R[&mtimeMs=T]` | Streams file bytes. Header `X-Content-Hash` is verified against the received bytes. `baseRev` is the `hubRev` the client last synced for this path (0 if new). Optional `mtimeMs` is the origin file's modification time; when present and valid (finite, > 0, at most ~5 min in the future) the hub sets it on the stored copy so display ordering (chat lists sort by mtime) survives sync — device clocks are still never used for conflict ordering. Returns `200 { seq, hash }`, or `409 { currentHash, currentRev }` if the hub's rev for the path is newer than `baseRev` and its hash differs from the upload's hash. |
| `DELETE /api/sync/file?handle=H&path=P&baseRev=R` | Same optimistic check, records a delete (tombstone). Hub moves the old file into `data/<handle>/sync-trash/` instead of unlinking. |

Rules for the hub:
- Validate `path`: normalise, reject absolute paths, `..`, backslash tricks, drive letters, and anything outside the allowed set or inside the deny list. Resolve and confirm the final path is inside `data/<handle>/` (use the existing `isPathUnderParent`-style helper if present in `src/util.js`).
- Write atomically (temp file then rename; ST already depends on `write-file-atomic`).
- Max upload size from config (default 256 MB).
- `PUT` with identical hash to the current one is a no-op returning the current seq.

## 6. Sync algorithm (client side, one run)

```
hello
local = scan synced dirs -> {path: {hash,size,mtimeMs}}   (hash cache keyed on size+mtime)
base  = state file
remote changes = GET changes since base.lastHubSeq
for each path in union(local, base, remote changes):
    L = local state (absent = deleted), B = base state, R = hub state (latest from changes, else same as base)
    localChanged  = L.hash != B.hash   (absent counts as a value)
    remoteChanged = R.hash != B.hash
    if !localChanged && !remoteChanged: skip
    if  localChanged && !remoteChanged: push (PUT or DELETE with baseRev=B.hubRev)
    if !localChanged &&  remoteChanged: pull (GET, or delete locally into sync-trash)
    if  localChanged &&  remoteChanged:
        if L.hash == R.hash: just update base (both sides made same change)
        else: CONFLICT -> section 7
after each successful action: update base entry (hash, size, mtimeMs, hubRev) and persist the state file
at the end: base.lastHubSeq = hubSeq returned by the last changes call
```

Details:
- A file is skipped if it changed during the scan (size/mtime differ between hashing and use) or if it was modified within the last 2 seconds. It is picked up on the next run. This avoids syncing half-written chat files.
- Pull writes to a temp file, verifies the hash, then renames atomically, applying the hub copy's mtime (`X-Mtime-Ms`) to the local file so chat-list ordering matches everywhere. If the same file was modified locally in the meantime (mtime check), skip and retry next run.
- Push sends the local file's mtime as the optional `mtimeMs` query parameter; the hub stamps it on its copy (see section 5).
- Push loops are bounded: if a `PUT` returns 409, treat it as a conflict for that path (section 7), do not retry blindly.
- Failure of one path never aborts the run. Collect errors, continue, report at the end. The base table only advances for paths that actually succeeded.
- Offline: if `hello` fails, do nothing and retry on the next trigger. No error spam.

## 7. Conflict handling

A conflict means both sides changed the same path since the last common state and the contents differ.

**Rule A, chats (`chats/**/*.jsonl`, `group chats/**/*.jsonl`): prefix fast-forward.**
- Chat files are JSONL: line 1 is a metadata header, the following lines are messages.
- Parse both versions into line arrays. Compare after the header line.
- If one version's message lines are a strict prefix of the other's (the "I continued on another device" case, which should be the vast majority of chat conflicts): take the longer one as the result. Treat it as a normal fast-forward (push or pull), no conflict copy needed.
- Header differences (for example `chat_metadata` changes): take the header from the side with the longer message list.
- Otherwise (messages diverge, or an earlier message was edited or swiped on one side): fall through to Rule B.

**Rule B, everything else (and chats that diverge): last-writer-wins by hub order, loser preserved.**
- Winner = the version already on the hub (the hub's order is authoritative). Exception: for `settings.json` and other non-chat files, winner is the version with the later mtime on its own device (best effort, display only), but the hub still serialises the result.
- The loser is saved, never discarded: as `data/<handle>/sync-conflicts/<relPath>.<deviceName>.<ISO-timestamp>.conflict` on every device that sees the conflict (hub keeps its copy too).
- For chats, additionally save the loser as a normal chat file named `<original name> (conflict <deviceName> <date>).jsonl` in the same folder so it shows up in the chat list and the user can read or recover it. This conflict copy is a regular file and syncs normally.
- The winning version is then propagated by normal push or pull.
- Log every conflict to `data/_sync/log.jsonl` and surface a count in the UI (section 10).

**Deletes vs edits:** if one side deleted and the other edited, the edit wins (restore the file). Deletions only win over unchanged files.

**Retention:** `sync-trash/` and `sync-conflicts/` are pruned after 30 days (configurable). They are excluded from sync.

### 7.1 settings.json: per-key 3-way merge (Rule C, replaces whole-file Rule B for this file)

Whole-file last-writer-wins made `settings.json` a perpetual conflict: each device's running UI rewrites the whole file, so every sync round tripped Rule B and "reset" the other device's theme, extension settings and backgrounds. Resolved with a per-key merge:

- Each device keeps an ancestor snapshot of `settings.json` at `data/_sync/settings-base-<handle>.json` (never synced). It is updated whenever the device pushes or pulls a settings version, so it always reflects the last state both sides agreed on.
- Merge rules per key (objects recurse, arrays and leaves are atomic):
  - Only one side changed since the base → that side's value wins.
  - Both changed identically → trivial.
  - Both changed differently → the configured winner takes the key and it is logged as a conflict key (no file-level conflict copy for settings).
  - One side deleted, other unchanged → deletion wins.
- Device-local keys are excluded from merging entirely; the local value always stays: `api_server`, `active_character`, `active_group`, `selected_button`.
- Winner for key clashes: `sync.settingsAuthoritativeDevice` (default: empty → hub wins). Set it to this device's `sync.deviceName` **only on the authoritative device** to make it win every key clash. Current setting (2026-11-10, user decision): the packaged Windows app (`windows-app`) is authoritative; the PC repo checkout (`windows`) has it empty.
- If either version fails to parse as JSON, fall back to Rule B whole-file handling.

## 8. Triggers

- On backend startup (after a short delay).
- Debounced after local file changes (poll the directory on a timer in v1; no native file watchers required, which keeps Android simple): every 60 s by default.
- Manual "Sync now" action.
- Android/Electron: also on app foreground and on network regained.
- Only one sync run at a time per process (mutex). If a run is in progress, mark dirty and rerun once.

## 9. Code layout (keep ST changes minimal)

New files only, plus two tiny hooks:
```
src/sync/
  index.js        start/stop scheduler, reads config, owns the mutex
  scan.js         walk + hash + (size,mtime) hash cache
  state.js        base table, device.json, hub.json, change log (atomic JSON/JSONL IO)
  engine.js       section 6 algorithm
  merge.js        section 7 rules (chat prefix merge, conflict copies)
  transport.js    interface { hello(), changes(since), getFile(path), putFile(path, stream, baseRev), deleteFile(path, baseRev) }
  transport-http.js  implementation talking to the hub; the only file that knows about HTTP
  paths.js        allow list, deny list, path validation (shared by hub and client)
src/endpoints/sync.js   hub router (section 5)
```
Hooks in existing code: import and `app.use('/api/sync', syncRouter)` in `src/server-startup.js`; call `sync.start()` after the server is listening. Nothing else in ST is modified in v1.

Config (`default/config.yaml`, mirror in the root `config.yaml` only if the repo convention requires it):
```yaml
sync:
  enabled: false
  role: client            # hub | client
  hubUrl: ""              # e.g. http://100.x.y.z:8000 (tailscale address)
  deviceName: ""          # human label, defaults to hostname
  token: ""               # client only; stored in config or a local-only file, never synced
  intervalSeconds: 60
  maxFileMB: 256
  retentionDays: 30
  handles: ["default-user"]
```

## 10. UI (last milestone, keep tiny)

A small status block in the existing settings area or a minimal built-in extension: last sync time, result (OK / offline / N conflicts / N errors), "Sync now" button, link to the conflicts folder listing. No new design system, reuse existing ST components.

## 11. Milestones (each is one or more small commits)

1. **paths.js + scan.js + state.js** with unit tests (allow/deny lists, traversal attempts, hash cache, atomic state IO).
2. **Hub router + change log** with tests: hello, changes, file GET/PUT/DELETE, 409 behaviour, hub rescan picking up local edits, path validation, auth.
3. **Engine, no conflicts**: push, pull, deletes, offline behaviour. Test with two temp data dirs and an in-process hub.
4. **merge.js**: chat prefix fast-forward, conflict copies, delete-vs-edit. Tests for each case in section 7.
5. **Scheduler, config, startup hook**, mutex, debounce, backoff.
6. **Device token provisioning** (CLI script `node sync-token.js create <name>` or admin endpoint).
7. **UI status block.**
8. Manual end-to-end test on real devices over Tailscale; write the results in this file.

Follow the existing test setup in `tests/`. Keep commits small, one milestone per commit, and ask before pushing.

## 12. Acceptance tests (must pass before calling it done)

DONE 2026-11-10: all items below verified — 123 automated tests in `tests/sync/` cover every line item (see CLAUDE.md Phase 2 for the test-to-item mapping), and the live multi-device flow (hub `thinkpad-srv` over Tailscale <-> Windows <-> S21 Ultra) was verified in real use.

- Edit a character on A, sync, B sees it after sync. Reverse direction too.
- Continue the same chat on A, sync; continue on B (after syncing) and sync again: no conflict, full history everywhere.
- Edit the same chat on A and B offline (appending different messages), then sync both: both A-side and B-side messages are preserved (one as the main file, the other as a `(conflict ...)` chat plus a `.conflict` copy). Nothing lost.
- Delete a lorebook on A: it disappears on B after sync and sits in `sync-trash/` on both.
- With `sync.syncSecrets` off (default), `secrets.json` is never uploaded, downloaded, listed or overwritten, even if a client requests it directly (hub returns 400/403). Nested `secrets*` files stay denied even with the opt-in.
- A request with `path=../../x`, an absolute path, or a denied path is rejected with 400/403.
- Killing the process mid-sync never leaves a half-written file at a real path.
- With the hub unreachable, the app works normally and the next successful run converges.

## 13. Open questions (defaults chosen; change only if the user says so)

- Q1. ~~`settings.json` device-local keys~~ **RESOLVED** (2026-11): per-key 3-way merge with device-local keys (section 7.1) plus optional `sync.settingsAuthoritativeDevice` for the user's PC.
- Q2. ~~Sync `extensions/`: default no.~~ **RESOLVED** (2026-11): opt-in via `sync.syncExtensions: true` (default stays no).
- Q3. Sync `assets/` (large media): default no.
- Q4. Multi-user (`handle`s other than `default-user`): default only `default-user`.
- Q5. Encryption at rest on the hub: default none (Tailscale is the boundary).

## 14. Non-goals

Real-time collaboration, per-message CRDT merges, peer-to-peer between clients, cloud-drive backends, and any change to ST's on-disk formats. (API-key syncing was a non-goal until the user explicitly opted in via `sync.syncSecrets`; it stays off by default. See the addendum.)

## 15. Addendum (2026-11): user decisions on settings, extensions and secrets

The defaults above were revisited after real two-device use hit the problems they predict. Decisions, made by the user:

1. **settings.json**: per-key 3-way merge (section 7.1) instead of whole-file last-writer-wins, because the running UI on each device kept rewriting the whole file and "resetting" themes/extension settings on the other device. The user's PC is configured as `settingsAuthoritativeDevice` so it wins key clashes.
2. **extensions/**: the user wants installed extension code and their settings synced. Opt-in flag `sync.syncExtensions` (default `false`); hub enforces its own flag on uploads regardless of what a client requests.
3. **secrets.json**: the user wants connection profiles including API keys to follow devices. Opt-in flag `sync.syncSecrets` (default `false`), documented warning: enabling it means any compromised device exposes every synced key, and the hub holds all of them. Only the exact root file is allowed; nested `secrets*` paths stay denied unconditionally.

Both flags must be enabled on the hub **and** on each client that should sync them; the hub never accepts an upload its own config forbids.
