# Loreweaver FAQ

Field notes from real problems hit during use. Every entry follows the same
shape: **symptom → cause → fix**. If a problem was fixed by *procedure or
configuration* (not by a code change), it belongs here so it isn't
rediscovered the hard way.

---

## 1. After wiping/resetting the hub's `data/` folder, my data never re-syncs

**Symptom:** The hub's `data/<handle>/` is empty (or fresh defaults only), but
the client never pushes anything. Sync reports success. On the hub:
`data/_sync/changes-<handle>.jsonl` starts at `seq: 1` with `deviceId: "hub"`
entries (its own fresh bootstrap), and the client's device has only pushed
files that changed recently.

**Cause:** Each device keeps a base table — `data/_sync/state-<handle>.json`
on the client — recording, per file, the hub revision (`hubRev`) it last
synced. After the hub's data (and change log) is wiped, those revisions point
into a dead log. Unchanged local files still compare "in sync" against the
stale table, so the engine sees nothing to push. The client's `lastHubSeq`
also hops straight to the new log's high-water mark, skipping the hub's
bootstrap entries.

**Fix — reset the *client's* base table (one full re-push):**
1. Stop Loreweaver on the client.
2. Rename its state file away, e.g.
   `data/_sync/state-default-user.json` → `state-default-user.json.bak`.
3. Start Loreweaver and let one sync run. With an empty base table every
   local file counts as a local change and is pushed; the hub's identical
   defaults are adopted silently (equal hashes → base update, no conflict),
   `settings.json` goes through the per-key merge, and the worst case is a
   conflict copy — by design nothing is lost.
4. Verify on the hub, e.g. `ls data/default-user/characters/`.

**Do NOT:**
- Edit only part of the base table. *All* entries carry stale `hubRev` values;
  any later edit to an untouched file would push a stale revision, get a 409,
  and produce a spurious conflict copy for a file the hub doesn't even have.
  Reset the whole file.
- Reset the client's state file while the app is running — the scheduler
  rewrites it.
- Also delete the hub's `hub.json` or device registry — that only invalidates
  device tokens; it does not fix the stale base tables (and re-registering
  devices means new tokens on every device).

## 2. Chat list order is wrong — every synced chat shows the same "modified" time

**Symptom:** On a device that received chats via sync, the chat list (sorted
by last modified) is scrambled; everything looks like it was modified at
sync time.

**Cause:** Before commit `621f7c967` (2026-11-10), sync did not carry file
mtimes: pushes were stamped with the hub's "now" and pulls with the local
"now". SillyTavern sorts chat lists by file mtime, so received chats all
appeared equally recent.

**Fix:**
- Current code preserves mtimes end-to-end (push sends `mtimeMs`, hub stamps
  it, including on no-op puts; pulls apply `X-Mtime-Ms` locally). New and
  changed files are correct automatically.
- **Files already synced by an older build** keep their wrong timestamps
  until each file changes — repair them with the base-table reset from
  entry 1 (the full re-push re-stamps everything, no-op puts self-heal the
  timestamps of identical content).
- A device that only ever *pulled* (e.g. the phone) heals as its chats
  change; to fix it immediately, reset its base table too — files whose
  content already matches are adopted without a rewrite, so a full
  delete-and-re-pull of its synced data is the thorough option.

## 3. Third-party extensions are missing on another device after `git pull`

**Symptom:** Extensions installed via the extension installer (e.g.
`Extension-Summaryception`, `lorebook-forge`, `datacat-sillytavern-browser`,
`landing-page`, `SillyTavern-Lorebook-Studio`) exist on one device but not on
another that cloned the same repo.

**Cause:** They live in `public/scripts/extensions/third-party/`, which is
**gitignored** (upstream design: user-installed runtime code). No amount of
commit/push/pull will move them. Note the synced `extension_settings` in
`settings.json` may already reference them — settings without code.

**Fix — copy them across (git is not the vehicle):**
```bash
tar czf - -C public/scripts/extensions third-party \
  | ssh <host> "cd ~/loreweaver/public/scripts/extensions && rm -rf third-party && tar xzf -"
```
Alternatively install them via the extension installer on the other device.
When comparing trees between machines, remember: use `LC_ALL=C sort` for
file-list diffs (locales reorder names), and expect checksum differences
from git's CRLF (Windows) vs LF (Linux) checkout — that part is harmless.

## 4. "Regexes / macros / extension settings weren't synced"

**Symptom:** On another device, custom regexes or extension settings are
missing.

**Cause — know where each kind of data lives before assuming a sync bug:**
- Global regex scripts and most extension settings: `settings.json` →
  `extension_settings.*` (synced as a root file; check `extension_settings.regex`
  on both sides before reporting a bug).
- Character-scoped regex: stored *inside the character card* — syncs with the
  character.
- Third-party extension *code*: `public/scripts/extensions/third-party/` —
  gitignored, see entry 3.
- Server-side extension data: `data/<handle>/extensions/` — **denied by
  default**; needs `sync.syncExtensions: true` on hub AND client.
- `secrets.json`: never synced unless `sync.syncSecrets: true` on hub AND
  client (and only the exact root file; nested `secrets*` always denied).

## 5. The hub answers nothing on `127.0.0.1:8000`

**Symptom:** `curl http://127.0.0.1:8000/` on the hub returns connection
refused / `000`, though the server log says it is listening.

**Cause:** With `listen: true` in `config.yaml`, Loreweaver binds to the
machine's LAN/Tailscale address (e.g. `100.x.y.z:8000`), not loopback.

**Fix:** Probe the address from the log line
`Loreweaver is listening on IPv4: <ip>:8000`, or just reach it over
Tailscale as the clients do. A `403` on an unauthenticated curl is the
whitelist doing its job — the server is up.

## 6. Presets, persona, prompt list, or extension settings reset after a data-directory migration

**Symptom:** After copying/moving data between installs (git checkout →
packaged app, a re-setup, or a botched sync round), the generation preset
shows "Default", the prompt manager list shrinks (e.g. 68 prompts → 12),
context/response limits drop (80000/15000 → 4095/300), the persona is
unnamed with an empty description, and extension configs (`lorebook-forge`,
`summaryception`, `landing-page`, …) are empty — while chats, character
cards and preset *files* are all still present and correct.

**Cause:** All of the above live in exactly one file:
`data/<handle>/settings.json`. If that file comes from the wrong source (a
fresh scaffold, an older copy of the install, a data root swapped mid-way),
everything keyed in it is silently replaced — nothing else is damaged, so
the rest of the copy looks fine and the loss is only noticed in the UI.
Sync then faithfully propagates the bad file: `settings.json` syncs
per-key, and the `sync.settingsAuthoritativeDevice` device's values win.

**Fix:**
1. **Back up** the current file:
   `cp data/default-user/settings.json data/default-user/settings.json.pre-merge-backup`
2. Close the app — `settings.json` is rewritten on activity/shutdown.
3. Diff the old install's `settings.json` against the current one
   (the incident of 2026-11-10: original `C:\SillyTavern` vs live install).
   The keys that carry parameters:
   - `oai_settings` (preset selection, `prompts`, `prompt_order`, samplers,
     `openai_max_context`, `openai_max_tokens`)
   - `kai_settings`, `textgenerationwebui_settings`
   - `power_user.persona_description[s]`, `personas`, persona prefs
   - `extension_settings` (per-extension config; compare sizes — e.g.
     `lorebook-forge` 1.2 MB vs 375 bytes)
   - `world_info_settings`, `tags`, `username`, `user_avatar`
4. Merge the lost keys from the old file into the current one, but KEEP
   the current install's genuine UI state: `accountStorage`,
   `active_character`, `background`, per-page counts. (Wholesale copying
   the old file throws away today's state instead.)
5. Write as UTF-8 **without BOM**, restart, and verify in the UI.
6. Because the authoritative device wins settings clashes, restore the
   file on the `settingsAuthoritativeDevice` (the PC) — the fix then
   propagates to other devices on their next sync. If a non-authoritative
   device got clobbered instead, just let it pull.

Rule of thumb: before any data-directory migration, snapshot
`data/<handle>/settings.json` from the source install — it is the single
file where "everything works but my parameters are gone" comes from.
