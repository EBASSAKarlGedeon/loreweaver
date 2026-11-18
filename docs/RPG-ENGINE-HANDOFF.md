# RPG Engine Integration — Handoff / Status

**Purpose:** continue this work after a context clear. Companion deep-reference: `docs/RPG-ENGINE-PORT.md` (what the port is, engine internals, shim contract). This file is about **project state, decisions, and what's next**.

Last updated: 2026-11-18 (imports DONE: v1 personas→heroes, v2 cards→NPCs + WI→lorebook; overlay regression lesson in §9; next: OP-MC features).

---

## 1. What this project is

Loreweaver (SillyTavern fork, AGPL, repo `C:\Users\Gedeon\Documents\Coding\Loreweaver`, branch `release`) + the **RPG Engine port**: the MNO Perchance RPG generator running as a Loreweaver extension, with AI calls routed through Loreweaver's backend.

**Agreed architecture (do not revisit):**
- Do NOT merge the two frontends. RPG Engine keeps its own game UI; Loreweaver owns providers/keys/presets/characters/World-Info/storage/sync.
- One app, two workspaces. Integration happens through a **server-side bridge**, never through `SillyTavern.getContext()` or iframe parent access.
- Presets/connections = **live references**; characters/World-Info/lorebooks = **linked snapshots** with source id + explicit re-import (never auto-overwrite a running adventure).
- `narrator-prompt.md` stays the GM base contract; Loreweaver prompt content may only be added as an explicit optional "additional GM instructions" section.
- Keep `app/src/` untouched where possible (port stays upgradable); any required patch goes into a `PATCHES.md` in the port with file/line notes.

## 2. Where things live (paths)

| What | Path |
|---|---|
| Port source (git clone = `github.com/EBASSAKarlGedeon/rpg-engine`, branch `main`) | `C:\Users\Gedeon\Documents\Coding\Loreweaver\public\scripts\extensions\rpg-engine\` |
| Port app inside it | `...\rpg-engine\rpg-engine-port\rpg-engine\` |
| **Deployed clone the packaged app actually serves** (user-scope install) | `C:\Users\Gedeon\AppData\Local\SillyTavern\Data\data\default-user\extensions\rpg-engine\` — URL: `/scripts/extensions/third-party/rpg-engine/...` |
| Packaged app's own public dir (NOT the repo's) | `dist\win-unpacked\resources\app\public\` |
| Packaged app data (settings.json, secrets.json) | `C:\Users\Gedeon\AppData\Local\SillyTavern\Data\data\default-user\` |
| Bridge files | `app/shims/loreweaver-bridge.js`, `app/loreweaver-bridge.html` (in the port) |
| Bridge e2e test | `rpg-engine-port/rpg-engine/tools/check-bridge.js` (`npm run test:bridge`) |
| Dev-repo docs | `docs/RPG-ENGINE-PORT.md`, this file |

**IMPORTANT gotcha:** the packaged app (`dist/win-unpacked/Loreweaver.exe`, listens on `127.0.0.1:8000`) serves ITS OWN `public/` from `resources/app/`, and installs extensions into the **AppData** clone above. The repo's `public/scripts/extensions/rpg-engine/` is only served by a dev server run from the repo. Always test against the AppData clone or pull it after pushing.

## 3. Done (commits on `rpg-engine` repo, all pushed to origin/main)

- `5138c5b` — full port committed (`rpg-engine-port/rpg-engine/`: app/, shims, tools, docs; node_modules ignored). **Note: this published the MNO author's unlicensed `app/src/` to the public repo — flagged to user, keep credit intact.**
- `9b83ec9` — root drawer stub wired up: loads the game wrapper (⚔ launcher + wand-menu entry + full-screen overlay + `window.rpgEngine`), "Open RPG Engine" button, "Open Loreweaver bridge" button.
- `8768f11` — **Bridge v2**: parameterises every engine `/chat/completions` call by a **Connection Manager profile**: `chat_completion_source` = profile `api`, `custom_url` = profile `api-url` (overrides engine baseUrl), `model` = profile `model` (overrides engine), `secret_id` = profile `secret-id` (key resolved **server-side** from `secrets.json` → `api_key_custom` list entries `{id, value, label, active}`), `custom_prompt_post_processing`; profile **preset sampling** (temperature/top_p/top_k/top_a/min_p/frequency/presence/repetition) merged for fields the engine didn't set. Config: `localStorage["rpge.loreweaverBridge"] = {enabled, profileId, usePreset}`.
- `ebf3599` — `/api/settings/get` is a **POST with `X-CSRF-Token`** (GET 404s).
- `7ac3d1b` — `/api/settings/get` returns `settings` as a **JSON string** (must parse). `connectionManager` profiles live at `parsed.extension_settings.connectionManager.{profiles, selectedProfile}`; presets at `openai_setting_names` + `openai_settings` (array of JSON strings, parallel arrays).
- `5fb3674` + `6ef5e38` — **Bridge v3 (role matrix, roadmap item 1)**: per-job Connection Manager profiles. The engine's `routedGenText` route ids (gm/check/staging/tracker/npc/scene/memory/npclife/other) now ride the request as `X-RPGE-Route` via the 2-line `app/src/` patch documented in **`PATCHES.md`** ([rpge-patch 001] — `openaiGenText(norm, route)` sets the header, `routedGenText` passes the route through). Shim picks `cfg.roles[route]` profile, falls back to main (`profileId` → selected → first). `cheap-model.html` page is auto-tagged role `cheap`. Bridge page has a "Per-job profiles" section (10 rows, default "(main profile)"). Route header stays on the wire to the Loreweaver server (server never forwards it upstream; useful in logs). Tests: check-bridge extended with a second mock profile + role assertions; full suite green (BRIDGE/BOOT/TWEAKS/E2E OK).
- `f409b1d` — UX: "Open Loreweaver bridge" now opens a **same-window overlay iframe** (no new Electron BrowserWindow / window-open delay; Close ✕ or Escape closes, iframe stays alive); the game overlay iframe is **preloaded hidden** at app load (idle callback, 15s cap) so the first "Open RPG Engine" is instant. Root extension `style.css` now holds the bridge-overlay styles (game overlay styles are in the port's own `style.css`). check-overlay.js updated for the preload invariant.
- `d6ab265` + `3766f9d` — **Fixed "Open RPG Engine does nothing" (two stacked bugs, both found live):**
  1. The port's `style.css` (game overlay + ⚔ launcher styles) was never loaded — ST only loads the manifest CSS of *top-level* extension folders, and the port is nested. The wrapper now injects its own `<link>` at init (`ensureStyles`).
  2. Even styled, the overlay collapsed to **height 0**: the `landing-page` extension sets `body { position: fixed }`, which breaks `top:0; bottom:0` inset-stretching for fixed-position children on that page (proven with a test div: 0px with body fixed, full height with static). Both overlays now use explicit `100vw`/`100vh` instead of `inset: 0`.
  **Lesson:** never rely on inset-stretch for fixed full-screen overlays in Loreweaver, and never assume nested-extension CSS loads. Verify UI fixes with screenshots, not DOM checks (both bugs were invisible to programmatic `isVisible` checks).

**Role matrix verified LIVE** (preview browser, real profiles): tracker → NanoGPT (z-ai/glm-5.1:thinking @ nano-gpt.com, its own secret), unrouted → Openrouter (z-ai/glm-5.2, its secret); both 200. Sniffed the outgoing bridged request bodies to confirm.

**Verified live** (agent browser against the packaged app @ `127.0.0.1:8000`): bridge page loads, all 3 user profiles listed (GLM Flash / NanoGPT / Openrouter), bridge enabled → test call → 200 through the real OpenRouter key server-side; streaming SSE with `[DONE]` and real model text; game boots (Worlds page). Caveat seen: GLM reasoning models can burn small `max_tokens` (e.g. the page's 16-token test) on reasoning before any content — cosmetic.

## 4. Key Loreweaver internals learned (needed for future steps)

- Connection profiles: `extension_settings.connectionManager.{selectedProfile, profiles[]}`; profile fields: `id, mode("cc"), api("custom"), name, model, api-url, proxy, preset, secret-id, prompt-post-processing, reasoning-template`. Profile application pattern (frontend `public/scripts/extensions/shared.js` `ConnectionManagerRequestService.sendRequest`) → `ChatCompletionService.processRequest` → preset via `presetToGeneratePayload` (client-side; maps preset → sampler fields via `settingsToUpdate`).
- Secrets: `secrets.json` per-user; multi-secret entries under key `api_key_custom` as a list; `readSecret(dirs, KEY, secret_id)` picks by id. Generate endpoint: `/api/backends/chat-completions/generate` (POST, CSRF `X-CSRF-Token` from `GET /csrf-token`); for `chat_completion_source: "custom"` it forwards `{model, messages, stream, max_tokens, stop, temperature, top_p, top_k, penalties...}` to `{custom_url}/chat/completions` with Bearer key and pipes SSE verbatim (`forwardFetchResponse`). Fields not whitelisted are dropped (e.g. Ollama `think`).
- Engine call sites (all covered by the fetch-interception shim, zero `src/` edits): `src/scripts/ai-provider.js` `openaiGenText` + `testAiConnection`, `app/shims/perchance-shim.js` `generateText` (cheap slot), `app/cheap-model.html` test.
- Engine's Perchance input cap `PERCHANCE_INPUT_CAP = 6976` (`perchance-limits.js`) still applies in shim mode — with real models this under-uses context; fix later (see TODO 6).
- The engine caches profiles/presets 5 min (`getLoreweaverSettings`).

## 5. What's left (agreed roadmap, in order)

1. **~~Per-role profile matrix~~ DONE (bridge v3, `5fb3674`).** Config: `localStorage["rpge.loreweaverBridge"].roles = { gm: profileId, tracker: profileId, … }` (missing/unset = main profile). Engine exposes its route via `X-RPGE-Route` header (patch 001, `PATCHES.md`). Cheap page = role `cheap`. If `app/src/` is ever refreshed from upstream, re-apply patch 001. Full design in `docs/RPG-ENGINE-PORT.md` §5b.
2. **~~Server-side saves~~ DONE (`ab86ae2` in rpg-engine repo; `c2c26787e` in Loreweaver repo) — full design in `docs/RPG-ENGINE-PORT.md` §5c.** The engine's kv folders `rpg` (adventures, heroes, session pointer, ctx-meter cache) and `worlds` (world library + index) are mirrored through the new shim `app/shims/loreweaver-storage.js` (wired into `index.html` after perchance-shim) to `data/<user>/rpg-engine/kv/` via new Loreweaver endpoints `/api/rpg-engine-kv/{list,get,put,delete}` (`src/endpoints/rpg-engine-kv.js`, mounted in `server-startup.js`). IndexedDB stays primary (offline-first, zero latency); writes are debounced (400 ms) and pushed; boot reconcile pulls server-newer values, pushes local-only ones, honours tombstones (`.tomb.json` delete markers so remote deletes aren't resurrected) and keeps both-sides-changed locals as `<name>.conflict-<ts>.json` on the server. Entry names are padding-stripped base64url of `folder\u0000key` (+`.json`). `embvec` (regenerable vectors) and `community` (deprecated) are NOT mirrored. Sync carries the dir: `USER_DIRECTORY_TEMPLATE.rpgEngine` + `SYNCED_DIRS` (`src/constants.js`, `src/sync/paths.js`); all 130 sync tests pass. Config: `localStorage["rpge.serverSaves"] = { enabled: false }` disables (default on). Test: `node tools/check-storage.js` (mock Loreweaver kv backend, 5 scenarios). **Deploy caveat (RESOLVED 2026-11-18):** Loreweaver repo pushed to origin/release (`529e1dec5..b29a39cd5`) and the packaged app REBUILT with `npm run dist` (electron-builder had to be reinstalled: `npm i -D electron-builder@26.18.0`) — new build runs `b29a39cd5`, contains the endpoint + sync dirs, verified live. **Hub + S21 requirement: the hub (thinkpad-srv) MUST `git pull origin release` and restart its Loreweaver backend — the hub validates every incoming sync path against its own `SYNCED_DIRS` (`src/endpoints/sync.js` → `isSyncPathAllowed`), so an old hub rejects all `rpg-engine/...` pushes. Same for the S21 Ultra: its sync ENGINE code (src/sync) also gates on SYNCED_DIRS, so pulling only the extension there is NOT enough — update the Loreweaver checkout behind it too. Until those pull, saves simply fail to sync (writes stay local, retried later — no data loss).** v1 limitations: reconcile runs at page load only (mid-session syncs land at next load); conflict copies are preserved but not yet surfaced in the UI.
3. **~~Imports~~ DONE in two steps.** **v1 (`0e814e3`, overlay fix `0993ab6`): personas → hero library.** New page `app/loreweaver-import.html` (also: drawer button "Import from Loreweaver" in the extension panel + a link on the bridge page; both open in the same-window overlay, generalized as `openOverlayPage(id)` in the root `index.js`). Lists the Loreweaver personas (`power_user.personas` + `persona_descriptions` via `/api/settings/get`; `getSettings()` now also returns `parsed`) with avatar thumbs (`/User%20Avatars/<id>`), name → Name, description → Persona, avatar → Portrait (downscaled ≤256px JPEG dataURL via canvas), all other bio fields left for in-game editing; writes into `kv.rpg.savedHeroes` (same 40-cap as HeroStore) with a `lwSource` link. Row status shows up-to-date / source-changed / not imported; Update overwrites ONLY the imported fields (Name/Persona/Portrait). Stats are never imported. **v2 (`9f7dcfe`, `5c5e0fc`): character cards → world NPCs + World Info → world lorebook.** A shared "Target world" dropdown (game worlds from `kv.worlds` index, remembered in `localStorage["rpge.importWorld"]`). Card import maps name → Name, description+personality → Persona, scenario → Extra, card image → avatar URL (`/thumbnail?type=avatar&file=…`); appends to the chosen world's raw `npcs[]` (name-collision suffix "(2)"). Book import maps keywords+secondary → triggers, constant → always-on, comment → title, disabled/empty entries skipped; appends to the world's raw `lorebook[]`. Source links live in a kv.rpg registry `lwImports = { cards: {avatar: {hash, at, worlds:[{worldId,npcName}]}}, books: {file_id: {hash, at, worlds:[{worldId,titles}]}} }` — NOT inside the world JSON (normalizeWorld strips unknown NPC fields). Update follows renames, never duplicates, and never blanks game-side fields (empty-string imported fields are skipped on update). Book change detection is identity-based (list endpoint has no content) — Update always re-fetches and replaces by title. ST macros ({{user}}/{{char}}) stay literal. A RUNNING adventure sees imported NPCs/lore on its next load. The shim gained a generic `LoreweaverBridge.api(path, body)` (POST + CSRF + one 403 retry) used for `/api/characters/{all,get}`, `/api/worldinfo/{list,get}`. Test: `node tools/check-imports.js` (mock Loreweaver with 2 personas + 2 cards + 1 WI book; covers both v1 and v2 flows). NEXT sub-feature (if wanted): hero template from a card, and/or AI field-splitting for card/persona descriptions.
4. **OP-MC / free-build features (user's main proposal)** — (A) free stat build toggle in hero wizard (ignore ccBudget/ccCeiling, raise stat max), (B) starting tracker value/max overrides in the wizard (reuse `applyTrackerStartOverrides` at `main.js ~L10654`), (C) per-tracker modes Normal/Locked/Unlimited (∞; GM sees "never depletes"), (D) "Powers & abilities" sheet text fed to GM, (E) mid-game edit of stats/trackers in Hero panel, (F) optional no-critical-failure setting. All player-facing settings, off by default. Files: `main.js` wizard (~L10116–10660), `trackers.js` clamp/update (~L769–860) + GM tracked-state text, `stats.js` check resolution, `rp-engine.js` character sheet.
5. **Cosmetic/cleanup** — remove dead community features (network stubs, stickers ~1.4MB, mock-seed) or leave hidden; flatten duplicate wrapper; cheap-model.html superseded by role matrix (keep as fallback); Nav: move launcher from floating ⚔ to main nav eventually.
6. **Context caps** — stop clamping to Perchance's 6976 input cap when the bridge profile is a real model; use model's real budget (configurable fallback).
7. S21 Ultra: pull the extension update in the app (it's behind `3766f9d`).

## 6. How to test / verify (commands)

```bash
# in rpg-engine-port/rpg-engine/ (dev copy):
npm run test:bridge      # mock Loreweaver backend + real config page -> BRIDGE OK
node tools/boot-test.js http://127.0.0.1:8765/index.html   # serve app/ first (python -m http.server 8765 --directory app)
node tools/check-tweaks.js http://127.0.0.1:8765/index.html
node tools/mock-llm.js "$TEMP/rpge-mock.log" &   # fake AI on :8766
node tools/e2e.js http://127.0.0.1:8765/index.html "$TEMP/rpge-mock.log" .
```

Live app: packaged app must be running (`dist/win-unpacked/Loreweaver.exe` — **unset ELECTRON_RUN_AS_NODE first** if launching from the agent shell!). Then in the agent browser (DeepAI preview tools):
- Bridge page: `http://127.0.0.1:8000/scripts/extensions/third-party/rpg-engine/rpg-engine-port/rpg-engine/app/loreweaver-bridge.html`
- Game: same path with `app/index.html` (or open via the drawer: Extensions panel → RPG Engine → Open RPG Engine)
- Deploy updates: push rpg-engine repo → `git -C "C:/Users/Gedeon/AppData/Local/SillyTavern/Data/data/default-user/extensions/rpg-engine" pull origin main` → reload page (Ctrl+R equivalent).

## 7. Tools used / that work here

- `bash`/`read`/`edit`/`write` for code + `python` heredocs for JSON inspection of settings/secrets (read-only, mask values).
- `git` in the rpg-engine clone (commit+push authorized by user; Loreweaver repo: ask before push).
- **Playwright** (devDependency of the port; installed chromium) for the port's own test suite.
- **DeepAI Code preview tools** (`preview_open/navigate/snapshot/click/evaluate`) — verified working against `127.0.0.1:8000`; the packaged app auto-logs-in (default user), so same-origin fetches from the preview browser carry the session. `preview_status` errored ("not found") — use `preview_open` directly.
- `tasklist`/`taskkill` for cleaning background test servers (python/node) — always clean up after tests.

## 8. User preferences / working agreements

- Small focused commits; **never push without asking** (rpg-engine repo push was explicitly authorized); ask before merging into `release`.
- User prefers copying files manually when it's their content; agent writes the code.
- User-found bugs that don't need code fixes → entry in `docs/FAQ.md`.
- User's priorities: OP-character support (free stats/trackers) is the personal motivation; keep engine upgradable; budget matters (Phase 4 lesson — prefer adapting over rebuilding).

## 9. Lessons learned (Problem → Cause → Solution — add new ones here)

- **Overlay pages invisible (buttons "do nothing", found via user recording, 2026-11-18).** *Problem:* "Open Loreweaver bridge" and "Import from Loreweaver" opened no overlay; the game button worked. *Cause:* overlay CSS still scoped to old ids (`#rpge-bridge-root`) while the generalized JS created new ids (`rpge-page-*`) → zero styles, invisible. *Solution:* scope overlay styles by CLASS (`.rpge-page-root`/`.rpge-page-frame`, `0993ab6`); after ANY root-extension `index.js`/`style.css` change run the visual check `node tools/shot-overlays.js` (clicks both buttons + screenshots) — the root extension has NO automated test (the fake-ST harness only exercises the port wrapper), so such regressions are otherwise invisible until the user hits them. FAQ entry added.
- **Nested-extension CSS never loads.** *Problem:* game overlay unstyled. *Cause:* ST/Loreweaver only auto-loads the manifest CSS of top-level extension folders; the port is nested. *Solution:* the port wrapper injects its own `<link>` (`ensureStyles`). Same rule for any nested page.
- **Fixed overlays collapse to height 0.** *Problem:* styled overlay still invisible. *Cause:* the `landing-page` extension sets `body { position: fixed }`, which breaks `top:0;bottom:0` inset-stretch for fixed children. *Solution:* size fixed full-screen overlays with explicit `100vw`/`100vh`, never inset-stretch.
- **Programmatic checks miss visual bugs.** *Problem:* DOM `isVisible`-style checks passed while the UI was visibly broken. *Cause:* the element existed with a bounding box but rendered invisible (zero height / styling / z-index). *Solution:* verify UI fixes with SCREENSHOTS — Playwright `tools/shot-*.js`, or extract frames from a user recording (`ffmpeg -i rec.mp4 -vf fps=2 f%03d.png`; user recordings are excellent evidence). Playwright against the live packaged app needs NO login (single-user mode, 127.0.0.1 whitelisted).
- **base64 padding breaks name round-trips.** *Problem:* server-saves reconcile skipped every entry and pushed stale values back. *Cause:* names like `...MQ==.json` (padding `=`) failed the client/server name regexes. *Solution:* strip padding in `b64url` everywhere; don't "simplify" it back.
