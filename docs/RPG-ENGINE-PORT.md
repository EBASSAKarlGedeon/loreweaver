# RPG Engine Port — Documentation

**Location in repo:** `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/`
**Read with:** `README.md` (port), `PORT-PLAN.md` (plan + test status), `app/src/README.md` (the engine's own 2,500-line single source of truth — the deep reference)

---

## 1. What this is

A local port of the **MNO RPG Engine** — a text-based AI roleplaying game originally built as a
Perchance generator ("by mnomno"). The player types freeform actions; an AI acts as **Game Master**
(narrator), voices every NPC, and keeps a persistent, evolving world. The port makes it run
**outside Perchance** (own AI provider, BYOK) and adds a **SillyTavern/Loreweaver extension wrapper**
that opens it as a full-screen overlay.

Three layers:

| Layer | Files | Role |
|---|---|---|
| **ST wrapper** | `manifest.json`, `index.js`, `style.css` | Extension glue. Full-screen overlay (`#rpge-root`, z-index 30000) hosting `app/index.html` in a same-origin iframe; wand-menu entry (`#extensionsMenu`, ⚄ icon) + floating ⚔ launcher button (bottom-left); close keeps the iframe alive so a streaming turn isn't interrupted. No ST internals imported — survives ST updates. `window.rpgEngine.{open,close,appUrl}` from the console. |
| **Platform shims** | `app/shims/perchance-shim.js`, `app/shims/tweaks.js`, `app/shims/loreweaver-bridge.js` | Stand-ins for the Perchance plugins the engine reads off `window.root` (`kv`, `generateText`, `generateImage`, `uploadPlugin`, `createServerSocket`, `commentsPlugin`, `copyTextPlugin`, `communityResLib`, `$meta`); tweaks hides platform-only UI (Explore, Tavern, Identity, Admin, view counters) via a MutationObserver; bridge rewrites AI provider calls through the Loreweaver server when enabled (see §5b). |
| **The engine (untouched)** | `app/src/**` | The generator's own code, copied verbatim into `app/src/` so `app/src/scripts/main.js` exists. Never edited, so a newer copy from the author can be dropped in later. |

`app/index.html` load order: `shims/loreweaver-bridge.js` → `shims/perchance-shim.js` → `src/scripts/boot.js` (copies `root.*`
onto `window.*`) → `src/scripts/main.js` (ES module) → `shims/tweaks.js` (deferred, optional).

**Status per PORT-PLAN.md:** engine boot, Worlds page, hero wizard, 2-turn e2e, NPC bubbles,
tracker bars, dual-model routing — **TESTED** (headless Chromium + mock AI server). SillyTavern
overlay wrapper — **TESTED only against `tools/fake-st.html`**; real-ST verification (milestone P3)
is the remaining VERIFY item.

## 2. Directory map

```
rpg-engine/                       <- SillyTavern extension folder (this whole thing)
  manifest.json  index.js  style.css        ST wrapper
  README.md  PORT-PLAN.md  package.json     docs + test tooling manifest (ST ignores package.json)
  app/
    index.html                              boot splash + script tags (replaces the platform shell)
    cheap-model.html                        settings page for the optional cheap second model
    loreweaver-bridge.html                  settings page for the Loreweaver bridge (§5b)
    shims/loreweaver-bridge.js              routes AI calls through the Loreweaver server (§5b)
    shims/loreweaver-storage.js             mirrors kv folders (rpg/worlds) to the server (§5c)
    shims/perchance-shim.js                 kv (IndexedDB), generateText (cheap-model slot), stubs
    shims/tweaks.js                         hides Explore/Tavern/Identity/Admin
    src/
      README.md  CHANGELOG.md               engine docs + dated release notes (changelog popup reads it)
      announcements.md                      editable notice bars for Worlds/Adventures/Explore
      styles.css                            all styling (~386 KB, commented; palette in §6.10)
      vendor/jsonrepair.mjs                 vendored ESM JSON-repair lib
      images/  (27 files, ~712 KB)          logo.svg, icon-512.png, icon-*.png white masks,
                                            backdrop-castle.webp, cover/backdrop/portrait art
      stickers/ (68 webp, ~1.4 MB)          community chat sticker pack
      game/
        worlds/   manifest.json + mno-grb.json (DEFAULT, "Goddess Reborn" isekai) + mno-chr.json
        templates/ manifest.json + blank/narrative/fantasy/space/cyberpunk/modern/horror/postapoc/drama
      scripts/                              ENGINE LAYER (logic + system prompt — not content)
        narrator-prompt.md                  GM system prompt (editable engine config)
        image-prompt.md                     🎨 Scene image prompt template (editable)
        main.js  (~700 KB)                  boot, home pages, chat flow, turn model, AI calls
        landing-shell.js  app-shell.js      #landing / #app shell markup, mounted at boot
        rp-engine.js                        context construction, GM output parsing, tracker calls, checks
        trackers.js  stats.js               AI-tracked state / player-owned attributes + skill checks
        memory-system.js  npc-system.js  npc-life.js   memory roll-up / NPC profiles / off-screen life
        lorebook.js  bm25.js  embeddings.js lore retrieval (BM25 + MiniLM RRF hybrid)
        map-system.js  trackers.js          POI minimap, travel, scale tiers (m→ly)
        world.js  world-editor.js  world-craft.js  world format, in-app editor, Craft-with-AI
        scenario-import.js  scenario-import-panel.js  third-party .scenario.json import
        ai-provider.js  image-provider.js   BYOK text/image providers + Settings sections
        storage.js  backup.js               SessionStore/HeroStore; full export/import (.mno-backup)
        community.js  discussion.js         Explore/publish/identity + Tavern/comments (lazy, offline here)
        mock-seed.js                        dev-only mock catalog seeder (refuses to run live)
        plus UI helpers: notify, info-tip, popups, rich-text, chip-input, color-picker, icons,
        ctx-meter, context-budget, search-bar, tag-row, world-folders, scene-images, scene-refs,
        lightbox, nav-history, back-close, breakpoints, perchance-limits, storage-info, ...
  PATCHES.md                                tracked deviations to app/src/ (currently patch 001)
  tools/                                    Playwright test scripts (dev-only)
```

## 3. How a turn works (engine pipeline)

Each turn: player action appended → `buildContext` → GM call (streamed prose) → `parseGmOutput`
→ **separate** tracker call(s) → optional referee check → memory-cadence check → map refresh on
location change → death scene on alive→dead. Everything user-visible is derived from the message
list, so edit/re-roll/delete/version-nav revert state automatically.

**GM output format** — tagged prose, not JSON:

```
Narration paragraph.

[Name] "spoken line"
[Name inner] private thought (optional)
[[NPC: Name | 1-3 sentence description]]   <- asks the engine to create a profile
[[CHOICE: an action]]                       <- choose-your-own-adventure option (opt-in per world)
```

The narrative GM never writes state values. A dedicated tracker call outputs a `[TRACKERS]` block of
`key: value` lines (a parallel `[NPC TRACKERS]` call does the same per character); a failed call
keeps the previous values. That separation is why cheap models work — each call has a narrow job.

**AI call table** (from Settings > AI Model > External AI calls; each route can be pinned to the
main provider or fall back to the Perchance slot = the cheap second model):

| Call | Cap (output tokens) | Route |
|---|---|---|
| GM narrative reply / death scene | uncapped | gm |
| Hero trackers (`[TRACKERS]`) | 48 + 28/tracker def | tracker |
| NPC trackers (`[NPC TRACKERS]`) | 48 + roster × (10 + 28/def) | tracker |
| Skill-check referee (`[CHECK]`/`[NO CHECK]`) | 120 | check |
| Scene manager (`[SCENE]`) | 120 | staging |
| Map POIs / single-POI line | 320 / 150 | other |
| Memory roll-up | 2200 | memory |
| NPC life tick | 900 (600 retry) | npclife |
| NPC profile / backdrop phrase | 350 / 24 | npc |
| Scene-image prompt | 220 | scene |
| Hero randomizer | 700 | other |
| World Craft stages / editor helpers | uncapped / 80–160 | other |
| Level-up backstop | no call — deterministic in-engine | — |

**What the GM sees (context order, prefix-cache friendly — static first):** GM instructions
(`narrator-prompt.md`) → narrative vibe → world premise → starting scenario (first 20 turns) →
character sheet + ATTRIBUTES → TRACKED STATE → world lore (relevant subset) → latest situation →
open threads → memories (owner-gated) → distant-past digest → NPC PROFILES (three tiers: Active /
Present / Others, dossiers+hooks ≤ 10/turn) → NPC tracked state → SURROUNDINGS (only when the map
matters) → RECENT EVENTS (last 10 turns; Perchance AI fits to its 6976-token input cap) → latest
action. Retrieval is hybrid BM25 + local MiniLM embeddings fused via RRF; the embedding model
(~23 MB, cached, kv `embvec`) degrades to BM25-only on failure and never blocks a turn.

**Memory:** auto roll-up every 10 turns (minus the last 2, so they stay editable) produces a
LATEST SITUATION line, event memories (owner + 3–6 triggers) and OPEN THREADS. `owner` gates
feeding (world = public, else exact names) so knowledge never bleeds. Manual notes are always fed
when enabled (cap 15). Rewind on edit/re-roll drops unpinned auto memories past the rewrite point.

**Hero stats vs trackers:** stats (STR/…) are **player-owned** — the AI never changes them; they
move only via level-up points. Skill checks: referee picks stat + DC band (d20 trivial 5–8 …
impossible 25–29); `die + mod` vs DC, criticals generalize via `critWindow`. Trackers are
**AI-tracked** (HP, gold, day/time, quest…) with `effects` (GM-facing meaning) and `rules`
(change conditions) split; `max`/`start` may be formulas (`= level*20+80`, `rand()`, other
trackers). Quest trackers rotate with ` [!completed]`/`[!failed]` outcome pips. `life` tracker =
death → death scene + game-over composer lock; `level`/`exp` get a deterministic level-up backstop.

**Map:** dedicated POI call per location change; seven scale tiers (indoor m → galactic ly) with
scale-appropriate units, spacing and travel guidance; travel is a normal action with
`kind:"travel"`; POIs cache per region (last 12).

**Worlds:** one JSON file per world (`format: "mno-world"`), loaded by `world.js`'s single choke
point. Key fields: `meta`, `narrativeVibe`, `scenario`, `starts[]` (openings, optional
`trackerOverrides`, verbatim mode), `lorebook[]` (`type`/`activation`/`keywords`/`content`),
`stats` (+`defs[]`), `trackers`, `npcTrackers` (per-NPC, incl. trigger-defaults), `npcs` (standing
cast, per-NPC tracker overrides + avatars), `imageStyleTags`/`imageNegativeTags`. `{{user}}` is
resolved to the hero's name in every prompt. Bundled: Goddess Reborn (default) + Cum Healer RPG;
8 genre templates + blank + narrative (story-only mode). Craft-with-AI builds a world in 6 staged
calls, each under the ~1024-token Perchance output cap, then `coerceWorldFile` guarantees the
core trackers. The in-app **World Editor** (Basics/Story/Lorebook/NPC/Images/Stats/Trackers/NPC
Trackers/Context/Raw JSON) authors all of it; the Context tab is a read-only token-budget meter.

**Data model:** sessions live in kv folder `rpg` (`sessions` index + `session_<id>` blob, version
2; message roles: action / direct / meta / image / narrator / npc / thought / check / choice).
Re-roll archives are **lazy** — a single-version turn stores nothing. HeroStore keeps 40 saved
heroes. Data & Backup exports one `<date>.mno-backup` JSON (adventures + worlds + identity +
prefs; contains the creator code — treat it as a secret), merge or replace import.

**UI:** dark fantasy flat theme (bg `#11100E`, accent sage `#8B9A6E`, warn `#9A4A4A`), two
collapsible side rails, landing home shell (Worlds / Adventures / Explore + Settings popup with
Identity / Content / Interface / Image Gen / AI Model / Data & Backup / Admin), single shared
rich-text renderer, one breakpoints module (PHONE 640 / PANEL 760 / SHELL 900 / WIDE 1024),
device-Back-closes-overlays module (`back-close.js`) and one navigation module (`nav-history.js`).

**Community layer (Explore/publishing/Tavern):** fully present in the code but **offline here** —
the shim's upload/socket/comments plugins reject with "offline", `tweaks.js` hides the UI, and the
app logs one harmless `offline` error. Identity, creator code, publishing, moderation, admin,
backup — all described in `src/README.md` §6.14; they'd need the real Perchance platform.

## 4. The shim contract (`perchance-shim.js`)

- **`kv`** — IndexedDB (`rpge-kv`) folders with `get set has delete keys values entries clear
  getMany setMany deleteMany update`. All saves live here (folders: `rpg`, `worlds`, `community`,
  `embvec`, …). Values are JSON-cloned; `update` is read-modify-write in one transaction.
- **`generateText`** — the "Perchance AI" slot. Streams from an OpenAI-compatible endpoint stored
  in `localStorage["rpge.cheapModel"]` (`{baseUrl, apiKey, model, temperature}`), configured on
  `app/cheap-model.html`. Supports `onChunk`/`onStart`/`onFinish`, `startWith`, `stopSequences`,
  `maxTokens`, `.stop()` abort; answers the engine's token-counter probe with a chars/4 estimate.
  **With no cheap model configured it throws a clear error** — keep every route on the main
  provider unless you set one up.
- **`generateImage`** — rejects; use Settings > Image Gen with your own provider.
- **`uploadPlugin` / `createServerSocket` / `commentsPlugin`** — offline stubs (quiet rejects).
- **`copyTextPlugin`** — clipboard; **`$meta`** — title only.

## 5. The cheap second model (`cheap-model.html`)

Standalone dark settings page (same origin) that saves Base URL / API key / model / optional
temperature to `localStorage["rpge.cheapModel"]` and can test-connection (POST
`/chat/completions`, 8 tokens). In-game: Settings > AI Model → switch the routes you want cheap
(Trackers, Scene manager, Skill checks, optionally Memories and NPC life sim) **OFF**; those calls
then ride this model while GM + map keep the main one. Malformed tracker output from a cheap model
just keeps stale values — worst case is stale numbers, watch the first turns.

## 5b. Loreweaver bridge (`shims/loreweaver-bridge.js` + `loreweaver-bridge.html`)

When enabled (config in `localStorage["rpge.loreweaverBridge"] = { enabled, profileId, usePreset, roles }`,
set from the bridge settings page), the shim wraps `window.fetch` and rewrites every engine call to
`<baseUrl>/chat/completions` (main model, connection test, cheap model — any call site) to the
Loreweaver server endpoint `/api/backends/chat-completions/generate`, parameterised by a
**Connection Manager profile** (same profiles the chat uses):

- `chat_completion_source` = profile `api` (e.g. `custom`)
- `custom_url` = profile `api-url` (overrides the engine's baseUrl)
- `model` = profile `model` (overrides the engine's model)
- `secret_id` = profile `secret-id` — the profile's own stored key, resolved **server-side** from
  Loreweaver's secrets store; **the key never enters the game page**
- `custom_prompt_post_processing` = profile `prompt-post-processing`
- `usePreset` (default on): the profile's chat-completion preset (from `openai_settings`, served by
  `/api/settings/get`) contributes its sampling params (temperature, top_p, top_k, top_a, min_p,
  frequency/presence/repetition penalty) **only for fields the engine did not set itself**
  (the engine sends temperature etc. only when its "Custom parameters" switch is on)

**Role matrix (bridge v3):** the engine tags every call with its job id (`gm`, `check`, `staging`,
`tracker`, `npc`, `scene`, `memory`, `npclife`, `other`) as an `X-RPGE-Route` request header — added
by the 2-line tracked `app/src/` patch documented in **`PATCHES.md`** ([rpge-patch 001]; re-apply if
`src/` is ever refreshed). The shim picks the profile from `cfg.roles[route]`, falling back to the
main profile (`profileId` → Loreweaver's selected profile → first). The `cheap-model.html` page is
wholesale the cheap slot, so it is auto-tagged role `cheap`. The bridge page has a "Per-job
profiles" section (10 dropdowns, default "(main profile)"); the engine's own per-route toggles
(Settings › AI Model › External AI calls) still decide whether a job calls the external provider
at all. The route header stays on the wire to Loreweaver (never forwarded upstream; shows the job
in server logs).

Profiles + presets are read from `/api/settings/get` (same origin, cached 5 min; **it is a POST with
`X-CSRF-Token`, and its `settings` field is a JSON string that must be parsed** — `connectionManager`
profiles at `parsed.extension_settings.connectionManager.{profiles, selectedProfile}`, presets at
`openai_setting_names` + `openai_settings` parallel arrays of JSON strings). Profile selection
defaults to Loreweaver's currently selected profile. Auth is the Loreweaver session cookie +
`X-CSRF-Token` (fetched from `/csrf-token`, refreshed once on a 403). The engine's key field becomes
a placeholder. Only works when the app is served by the Loreweaver backend (same origin); standalone
serving (python `http.server`) keeps working with the bridge OFF. Not yet supported: text-completion
profiles (mode `textgenerationwebui`), proxy presets, in-body `custom_exclude_body`/`custom_include_headers` handling.

- Loads FIRST in `index.html` and `cheap-model.html`, before anything captures `fetch`.
- Verified by `npm run test:bridge` (`tools/check-bridge.js`): mock Loreweaver server (two profiles +
  presets + session CSRF + SSE forward) + the real config page + a raw bridged stream; asserts
  per-role profile mapping (tracker → cheap profile with its own preset, gm/unrouted → main),
  Authorization stripping, and preset sampling application.

## 5c. Server-side saves (`shims/loreweaver-storage.js`)

The engine persists adventures, the hero library and the world library in browser IndexedDB kv
folders (`rpg`, `worlds` — see §4), which are device-bound and invisible to sync. This shim (wired
into `index.html` after `perchance-shim.js`, before `boot.js`) wraps those folders and mirrors every
write into **`data/<user>/rpg-engine/kv/`** on the Loreweaver server via `/api/rpg-engine-kv/
{list,get,put,delete}` (`src/endpoints/rpg-engine-kv.js` in the Loreweaver repo). The sync engine
(`SYNCED_DIRS` includes `rpg-engine`) carries that directory between devices.

- IndexedDB stays primary: reads/writes are local and instant; the game works offline and standalone
  (shim stays passive without the Loreweaver backend). Writes are debounced 400 ms per key and pushed;
  failed pushes stay local and are retried at the next boot.
- **Boot reconcile** (idle callback): pulls server-newer values into the browser, pushes local-only
  keys, honours tombstones, resolves conflicts (see below). Runs at page load only — saves synced
  mid-session appear at the next load.
- **Deletes** write a `<name>.tomb.json` marker server-side before unlinking, so a deletion made on
  one device isn't resurrected by another device's boot reconcile.
- **Conflicts** (both sides changed since the last known mtime): the server value wins in the
  browser; the local value is preserved server-side as `<name>.conflict-<ts>.json` (syncs too; not
  yet surfaced in the UI).
- Entry names: padding-stripped base64url of `folder\u0000key` + `.json` (base64 `=` would break both
  the client's name matcher and the server's allow-list — don't "simplify" it back).
- NOT mirrored: `embvec` (regenerable embedding vectors, megabytes) and `community` (deprecated).
- Config: `localStorage["rpge.serverSaves"] = { enabled: false }` disables (default on). Bookkeeping
  in `localStorage["rpge.kvMeta"]` (last pushed server mtime per key); debug API `window.LoreweaverSaves`.
- Verified by `node tools/check-storage.js` (mock Loreweaver kv backend): write-through,
  cross-device pull, conflict copy, tombstone delete, fresh push.

## 6. Text AI providers (`ai-provider.js`)

Perchance AI (the shim slot), OpenAI, DeepSeek, OpenRouter, Ollama (local) — or any
OpenAI-compatible Base URL under "OpenAI". Key in `localStorage["mno.aiProviderKey"]` (per
provider, never backed up); config in `mno.aiProvider` (rides Data & Backup). Per-call routing
toggles (see table §3); budgets follow the toggle, not the provider. Advanced: thinking toggle
(OpenRouter reasoning off by default — billed), and Temperature / Top-p / Top-k / Repeat-penalty
sliders behind a global "Custom parameters" switch, mapped per provider
(`repetition_penalty` vs `frequency_penalty`; top-k only to Ollama/OpenRouter). Safety nets: 90 s
without data, 5-minute absolute cap — keep partial text; the composer stop button aborts.

## 7. Running / testing

```bash
# serve the app (no ST) — file:// does NOT work (ES modules need http)
python3 -m http.server 8765 --bind 127.0.0.1 --directory app

# test tooling (needs `npm i -D playwright` in this folder)
node tools/mock-llm.js /tmp/rpge-mock.log          # OpenAI-compatible fake AI on :8766, logs calls
node tools/boot-test.js    http://127.0.0.1:8765/index.html          # boot + visible nav  -> BOOT OK
node tools/check-tweaks.js http://127.0.0.1:8765/index.html          # hidden UI asserts   -> TWEAKS OK
node tools/e2e.js          http://127.0.0.1:8765/index.html /tmp/rpge-mock.log .   # 2-turn game + dual-model routing -> E2E OK
python3 -m http.server 8767 --bind 127.0.0.1                        # serve extension ROOT
node tools/check-overlay.js http://127.0.0.1:8767/tools/fake-st.html # wrapper vs fake ST page -> OVERLAY OK
node tools/check-bridge.js                                          # Loreweaver bridge e2e   -> BRIDGE OK
node tools/check-storage.js                                         # server-side saves e2e   -> STORAGE OK
```

`mock-llm.js` classifies each logged request (gm / staging / hero-tracker / npc-tracker / check /
map / location-phrase) and streams a canned GM reply with a `[Dharra]` NPC line; `e2e.js` asserts
GM calls used `mock-main` and tracker/staging/check calls used `mock-cheap`.
`npm run serve|mock|test:boot|test:tweaks|test:e2e|test:bridge` shortcuts exist.

**Install in SillyTavern/Loreweaver:** copy the whole folder (with `app/src/` filled in) to
`public/scripts/extensions/third-party/rpg-engine/` (Loreweaver install location used:
`public/scripts/extensions/rpg-engine/`), restart, open via the wand menu "RPG Engine" or the ⚔
button. Storage belongs to SillyTavern's origin — `localhost` vs `127.0.0.1` vs LAN shows
different data; use Data & Backup to move saves. With the Loreweaver backend serving the page,
server-side saves (§5c) close most of that gap: saves mirror to `data/<user>/rpg-engine/kv/` and
sync between devices.

**Deploy loop for updates:** commit in the dev clone (`public/scripts/extensions/rpg-engine/`),
push to `origin` (rpg-engine repo), then `git pull origin main` inside the installed copy
(`%LOCALAPPDATA%\SillyTavern\Data\data\default-user\extensions\rpg-engine`) and reload the app
window (fully quit + relaunch if CSS/JS seems stale). Server-side (Loreweaver repo) changes need an
app rebuild (`npm run dist`) or a hot-copy into `dist/win-unpacked/resources/app/src/` + restart.

## 8. Gotchas & invariants (condensed from src/README §7)

- **Everything derives from the message list** (trackers, NPC trackers, death, map hero position);
  memory is the one thing needing explicit `rewindFromTurn`.
- **`turn` ≠ `messageCount`** — memory cadence uses `turn` (stable per anchored turn).
- **Static-first context** for prefix caching — keep `buildContext` ordered that way.
- **The AI never writes stats;** combat is fully narrative; knowledge gating is owner-based and
  exact-match only.
- **Content work happens in world JSON / the World Editor, never in `scripts/`.**
  `narrator-prompt.md` is engine config, not content.
- **No browser dialogs** — themed `TextPopup`/`ConfirmPopup` only.
- **Upgrading from the author:** replace `app/src/`, then re-run boot/tweaks/e2e tests; watch for
  new `root` globals, new `kv` methods, new platform-only menu items, renamed call routes.

## 9. Credit & licensing

The engine code is the author's work (credited "by mnomno" in its footer); no license text ships
with it. This port package contains only the port's own files (shims, wrapper, tests) and leaves
`app/src/` untouched and technically out of the package. Private use is one thing — **ask the
author before publishing any fork or modified copy**, and keep their credit. See PORT-PLAN.md §8.
