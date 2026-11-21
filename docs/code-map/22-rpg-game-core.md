# 22 — RPG Game Core: `main.js` (Code Map)
> Paths relative to the Loreweaver repo root. The RPG engine is its own git repo nested at
> `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/` (its `PATCHES.md` at the repo
> root logs every patch; app source is `app/src/scripts/`). Line refs are approximate
> (`file:~line`, written 2026-11-24). Trust function names over line numbers.
> Sibling docs in this folder: see `00-INDEX.md` (in particular 20/21 shell+storage, 23 AI
> plumbing, 24 worlds/lore, 25 stats/trackers/actions/NPC systems).

## Purpose & user-facing surface
`main.js` is the game app's controller: it boots the UI, owns **the state** (one active session),
routes the landing pages and the in-game chat, drives **the turn loop** (player action → parallel
referee/scene calls → streamed GM reply → tracker updates → save → memory/roll-up ticks), and
mounts every panel (rails, wizard, settings, NPC, map). The engine's AI text lives in doc 23;
stat/tracker/action mechanics live in doc 25 — this doc covers the controller and the flows.

User-visible surface: landing pages (Worlds / Adventures / Import / Explore / User), the chat
screen (transcript, tracker bar, composer, ⋮ commands, map panel), the hero-creation wizard
("Forge Your Hero"), the Hero rail panel (Stats / Actions / Bio tabs), the Settings popup
(Tools / Preferences / AI Model / Image Gen / Backup / Identity / Content), the Memory/Session/
Menu left rail, and the NPC right rail (doc 25).

## Files overview
| File | ~Lines | Role |
|---|---|---|
| `…/app/src/scripts/main.js` | 14115 | The controller: boot, state, routing, turn loop, panels, wizard, saves |
| `…/app/src/scripts/character.js` | 78 | Hero data model (`defaultCharacter`) + GM-facing `characterSheet()` |
| `…/app/src/scripts/world.js` | 895 | `mno-world` single-file schema: `loadWorld`, `WorldStore`, export (detail: doc 24) |
| `…/app/src/scripts/notes.js` | 93 | Author's-notes upload blobs: id extraction, fetch+cache, panel shell |
| `…/app/src/scripts/user-profile.js` | 235 | Public profile page (`#user/<id>`): bio, avatar, published worlds |

## Boot & module state
- `init()` — main.js:~490 — the whole boot: mounts landing+app shells, creates `SessionStore` /
  `HeroStore` / `WorldStore` over `window.kv`, wires world-craft/scenario-import/scene-images/
  community hooks, fetches `narrator-prompt.md` + `image-prompt.md`, loads bundled worlds,
  applies the default world, loads the preset library async, binds events, then either resumes
  the active session (`chooseWorldForUnbound` → `enterSession`) or paints the landing.
  Storage failures everywhere degrade to toasts + in-memory play, never boot death.
- Module-level singletons (main.js:~105–112): `state` (active session, null on landing), `store`,
  `heroStore`, `memory` (MemorySystem), `npcLife`, `npcSys`, `engine` (RPEngine), `mapSys`,
  `worldStore`, `bundledWorlds`, `defaultWorld`.
- World-def globals set by `applyWorld()` (below): `trackerDefs`, `npcTrackerDefs`, `statDefs`,
  `statCfg`, `ccBudget/ccFloor/ccCeiling`, image-prompt prefs, thread/scene dice toggles.
- UI flags: `generating`, `activeStreamBubble`, `editing`, `homePage`, `leftSec/rightSec` (rails),
  `heroTab`, `memTab`, `renderWindowStart`/`renderFollowTail` (transcript windowing,
  `RENDER_INITIAL`/`RENDER_CHUNK` = 10/10 turns).
- Preset library (main.js:~143–208): blob `{presets:[{name,raw}], active, on}` in `kv.rpg`
  ("promptPresets", syncs via the server mirror); `loadPresetLib/savePresetLib/reparsePreset/
  applyPresetToEngine`; legacy single-preset localStorage key migrated once.
- `window.mnoApp` — main.js:~14030 — the tiny bridge lazily-imported feature modules
  (community/backup) use to reach app primitives (notify, popups, routing, worldStore, openWorldEditor…).
- `window.genText = routedGenText` — main.js:~112 — every module that calls `genText` goes through
  ai-provider's router (doc 23). Image calls route via `image-provider.js`.

## State model
- `newSession(id, worldId, startId)` — main.js:~341 — builds the session object:
  `{version:2, id, worldId, worldName (name snapshot), startId, customStartText, character,
  initialTrackers, messages:[], turn, messageCount, memories:{manual,auto,history},
  latestSituation(+Turn), openThreads[], threadDirective, sceneDirective, npcs{}, npcLinkRules,
  scene{present,next,change}, map, mapCache, surroundingsLoc/Pos, settings{…}, openingRerolls,
  lastAutoMemoryTurn, lastNpcLifeTurn, lastSceneDiceTurn, …}`.
- `initCharacterStats(c)` — main.js:~392 — load-time fix-up of the hero against the bound world's
  defs: fills `stats`, normalizes bio strings, `statPoints/statFloors/statCommitted/
  statsAwardedLevel`, free-build flags (`freeBuild/freeEdit/noCritFail/powers`), validates
  `trackerOverrides`/`trackerModes` keys against current defs, re-normalizes `actions[]`
  (stale stat keys dropped). Called from `normalize` — world binding MUST happen first (see Gotchas).
- `normalize(d, opts)` — main.js:~10431 — save-format fix-up on every load: messages, memories
  (`normalizeMemories`), layered history (`normalizeHistory` + one-time `migrateDigest`), NPC
  registry v1→v2 migration, npc link rules validation, `settings` defaults (deletes retired keys
  `autoMemoryEvery/sceneAmt/sceneAspect/worldSummary`), clamps cursors (`turn ≤ anchored actions`,
  `lastAutoMemoryTurn ≤ turn`, `lastNpcLifeTurn ≤ turn`), validates open threads/directives
  (turn-stamped `{text,from,lastFired}` shape), scene cursor, map cache. `opts.world:false`
  (storage-blind open) skips world-dependent clamping.
- `compactVersionArchives(d)` — main.js:~10407 — drops eager single-version re-roll archives
  from old saves (live reply + archive were stored twice).
- Level-up plumbing: `grantLevelUpPoints()` (~440, one level's worth per call, high-water
  `statsAwardedLevel`), `grantAndAnnounceLevelUp()` (~462), `levelUpWindowOpen()` (~473),
  `updateLvlIndicators()` (~484, gold dot on the Hero rail tab).
- `defaultCharacter()` — character.js:~5 — the hero model (see its comments): bio strings,
  player-owned `stats`, `statFloors`, OP-MC fields, `actions[]`. Live numbers (HP/level/exp/coins)
  are NOT here — they are AI-tracked world trackers (doc 25).
- `characterSheet(c, statDefs)` — character.js:~30 — the GM-facing hero text: bio lines, stats
  context, EFFECTIVE stats when ability buffs are on, ACTIONS block, powers.

## View routing (landing → worlds → adventures → game)
- `HOME_SECTIONS` — main.js:~1219 — config-driven landing nav (worlds/adventures/imports/explore/
  discussion(tavern, `opens:` popup)/user(hidden)/settings(`opens:`)). A new page = one entry +
  a mount fn. `HOME_PAGE_IDS` = routable pages only.
- Hash routing: `homeRouteFromHash()`/`applyHomeRoute()` (main.js:~1528/1542) mount `#worlds`,
  `#adventures`, `#imports`, `#explore(/<worldId>)`, `#user/<id>`; `setHomePage(id,{push})`
  (~1660), `unmountHomePage` (~1644), `applyForwardedHash` (~1627, external deep links).
- `enterSession(sess)` — main.js:~3954 — THE binding decision point: rebinds a missing world via
  `chooseWorldForUnbound` (~1052, dialog; empty v1 id → default silently), calls
  `ensureWorldBound` → `applyWorld`, `normalize`s the session (order matters, see Gotchas),
  purges dead NPC tracker keys, `setActive`, pushes a history entry (`pushSessionEntry`), repairs
  NPC sightings (`npcSys.rebuildSightings`), shows `#app`, renders, kicks `startNewSession()` when
  the transcript is empty, offers the history backlog build, warms embeddings.
- `goToLanding({forgetSession, keepSession})` — main.js:~3872 — autosaves, tears down state,
  clears the active pointer, pops/forgoes the session history entry, paints the landing.
  `sessionBackClose/releaseSessionBack` (~3921/3950) + `nav-history.js` implement the whole
  Back-button choreography (menu-grid bridge, profile bridge).
- Pages: `mountWorldsPage` (~2115, huge: cards, menus, detail panel), `mountAdventuresPage`
  (~2847), `mountExplorePage` (~3135, community module owns content), `goUser/mountUserPage`
  (~3068/3051), `loadAddedWorlds/refreshAddedWorlds` (~1470/1492), `worldCard` (~4436),
  `openWorldDetail` (~4612), `openWorldPanel` (~4811), `showWorldPicker` (~5256),
  `beginNewAdventure(preWorld)` (~5419 — creates the session, opens the wizard).
- In-game: `render()` (~7078) repaints the transcript (windowed), tracker bar, composer state;
  `loadOlderTurns`/`onTranscriptScroll` (~7261/7271) grow the window upward.

## The turn loop (the heart)
Flow: **`send()` → `submitAction()` → `runGmTurn()` → `saveAndMaybeMemory()`**.
- `send()` — main.js:~5674 — composer send. Non-empty → `submitAction(text)`. Empty send either
  retries the last unanswered action (its reply was deleted) or anchors an `idle` "Waiting" turn.
- `submitAction(rawText)` — main.js:~5716 — pushes `{role:"action", text}`, bumps `turn`, runs
  `autoInvokeActions(text)` ([rpge-patch 025] ability toggles flip BEFORE the GM call), then
  `runGmTurn` with the pre-turn history, then `saveAndMaybeMemory()`. CYOA choice buttons
  (`partEl`) call this too — a clicked option is indistinguishable from a typed action.
- `startNewSession()` — main.js:~5732 — the opening: `runGmTurn({opening:true})`, saves.
- `runGmTurn({history, actionText, opening, insertIndex, kind})` — main.js:~6521 — one turn:
  1. `generating=true`, stream bubble; `wasDead` snapshot.
  2. **Parallel pre-reply AI calls** (skipped for verbatim starts): `engine.determineCheck`
     (skill-check referee) and `engine.determineScene` (scene staging) — doc 23/25.
     A check decision becomes a client-side d20 (`resolveCheck`) → animated pip above the stream.
  3. `engine.generateGmReply(...)` — streams; `onStream` re-parses chunks live
     (`liveStreamMsgs` ~6686) into real bubbles. `registerReplyNpcs` pre-creates NPC entries
     before the tracker call.
  4. Failure → toast (`engine.lastError`), nothing saved; user stop keeps partial text.
  5. Messages appended (or spliced at `insertIndex` for re-rolls).
  6. **Death**: alive→dead transition runs `engine.generateDeathScene` and tags the messages
     `gameOver:true` (re-roll drops the badge; only the transition re-triggers).
  7. `generating=false` BEFORE final render (choice buttons otherwise stay invisible);
     `render()`, `grantAndAnnounceLevelUp()`, `noteNpcs()` (profiles/portraits for new NPCs),
     map refresh (`maybeRefreshMap`/`pendingMapRefresh`/`refreshHeroPos`), `refreshCtxMeter()`.
  8. Any throw → toast + re-throw; `finally` always releases the lock ([rpge-patch 016]).
- Commands: `runDirectCommand` (~6463, ⚡ Direct = kind "direct"), `runAdvanceCommand` (~6451,
  ⏩ scene conclusion + break), `runSceneCommand` (scene-images.js), `runPruneCommand` (~6486).
- `stopGmTurn()` — main.js:~6801 — engine.stop(); a stopped reply keeps partial text but skips
  the tracker calls.
- `rerollTurn` (~8821), `navReroll` (~8899), `deleteTurn/deleteGmReply` (~8769/8790) — all go
  through `runGmTurn` with `insertIndex`; version archives live on the action message
  (`rerolls[]` + `rerollIndex`), materialized only from the first re-roll.
- Editors: `editEl` (~8511) / `ed*` family (~7285–7693) — the GM-reply editor tabs (Narrative /
  Trackers / NPC) parse and rewrite turns; `deleteTurnWithConfirm` (~8746).

## Saves & storage flow
- `store = new SessionStore(window.kv)` (storage.js — detail in doc 21). `store.save(state)` is
  the only session persistence; `{touch:false}` variants save without bumping last-edit time.
- `saveAndMaybeMemory()` — main.js:~13897 — the post-turn pipeline, in strict order:
  1. `store.save(state)` (storage failure → toast, skip the rest; the turn stays playable in RAM).
  2. `historyDue(state)` → `runHistorySnippet` (layered narrative history tick, saved).
  3. Every `MEMORY_EVERY_TURNS` (10) turns: `memory.rollUp(state)` + save + report toast;
     then **thread dice**: clear stale directive, roll d20 against the oldest thread past
     cooldown (threshold scales with age 18/14/10/8) → set `state.threadDirective` for next turn.
  4. NPC-life tick every `NPC_LIFE_EVERY_TURNS` turns (`npcLife.tick`, silent, saves its cursor
     even on no-op).
  5. **Scene dice** ([rpge-patch 014], own cadence): d20 → `state.sceneDirective` nudge for the
     next turn; cursor persisted even on a calm roll.
- `saveCharacterQuiet()` — main.js:~11803 — fire-and-forget hero-panel save (toast on storage error).
- Settings toggles and the wizard also save quietly (see `mkToggle` in `renderSettingsPanel`).
- Session management: `renameSession` (~10279), `duplicateSession` (~10318),
  `switchSessionWorld` (~10350), `exitToHomePage` (~9181), `renderMenuPanel`/`renderSessionPanel`
  (~9187/9250).

## Character-creation wizard ("Forge Your Hero")
- `openCharacterCreation(s, onDone, onCancel)` — main.js:~11088 — overlay wizard, re-entrant
  (also used for "tweak hero" mid-adventure). Steps are dynamic:
  `["start"?, bio, avatar, stats, actions, "trackers"?, review]` — "start" appears only when the
  world has multiple openings; "trackers" only when the world has number trackers (~11787).
  Steps: Opening (start pick / custom text) → Bio (8 fields + 🎲 non-AI randomizer) → Avatar
  (upload or AI portrait) → Stats (spend `ccBudget` points, `ccFloor`–`ccCeiling`, "Free build"
  ignores budget) → Actions (starting abilities) → Trackers (starting values/maxes/modes) →
  Review → Begin.
- Bio randomizer: `randomizeBioWithAI` is only the AI alternative (main.js:~10953); the default
  🎲 is local — `rollBio(c, world, opts)` in bio-words.js:~735 with `detectGenre(world)` (~603)
  scoring the world's name/tags/description/vibe/lore against genre keyword pools
  (`GENRES`, `SHARED`, adult pool only for NSFW worlds).
- `promptSaveHero` (~10991) / `openSavedHeroesPopup` (~11013) — reusable hero presets via `HeroStore`.
- `applyEditedNpcTrackerBlock` etc. handle tracker edits from the reply editor; wizard-side
  tracker step writes `trackerOverrides`/`trackerModes` onto the character.

## Hero panel (right rail → "character")
- `renderCharacterPanel(body)` — main.js:~12139 — tabs **Stats / Actions / Bio** (`heroTab`).
  Stats tab: level/exp bar (resolved by key OR label), tracker strip, stat rows showing
  EFFECTIVE values (base + ability buffs, `effectiveStats`), −/+ editors gated to a level-up
  window (or ✎ free edit), stat-points banner, Save (locks allocation: re-baselines `statFloors`).
  `spendStat` (~12369) enforces floors/points.
- Actions tab ([rpge-patch 019]): `actionsTabHtml` (~11824) card list; `wireActionsTab` (~11885)
  wires toggle/delete/edit; inline editor via `actionEditing`; generatable actions
  ([rpge-patch 025]): `actionCtxFromWorld` (~11968), `inGameActionCtx` (~11994),
  `generateActionOffers` (~12025, an AI call → offer cards), `wireActionGen` (~12059),
  `paintActionOffers` (~12083). `autoInvokeActions` (~12116, called in `submitAction`) flips
  toggles when the player's words match an action's trigger; `acceptActionGain` (~12128) accepts
  a chat-side gain card.
- Bio tab: fields + `uploadAvatarTo` (~10876) + AI portrait `genHeroPortrait` (~10895).
- NPC trackers (per-NPC values): `npcTrackersFor/npcTrackerValuesHtml/npcTrackerStripHtml`
  (~10668–10712), `refreshNpcTrackerRow` (~10722), edit plumbing `turnNpcSnapshot …
  applyEditedNpcTrackerBlock` (~10734–10876).
- Trackers shared: `currentTrackers()` (~6901, derives live state from messages' `afterTrackers`),
  `renderTrackerBar` (~6961), `applyManualTrackerEdit` (~6910), `trackerDeltas` (~7806) — detail
  in doc 25.

## Settings
- `openSettingsPanel(section)` — main.js:~3660 — the popup; sections render into it:
  `presetSection()` (~3207, prompt-preset library import/export/toggle), `interfaceSection()`
  (~3491), `imageGenSection()` (~3640), plus community-owned Identity/Content and `backup`
  (backup.js) and `aimodel`/`imagegen` (ai-provider/image-provider, doc 23).
- `renderSettingsPanel(body)` — main.js:~12415 — the left-rail session settings: AI Provider /
  Image Gen buttons, Prune re-rolls, and toggles: `simNpcLife`, `rollChecks`,
  `showTrackerChanges`, `showInnerThoughts` (each saves immediately, several re-render with a
  transcript anchor).
- Misc panels: `renderRailSection` (~9496), memory panels (`renderMemoryPanel` ~9835,
  `renderHistoryPanel` ~9861, situation ~9728, threads ~9774, lazy rows ~9987+),
  `renderNpcPanel` (~12609), NPC detail popup `openNpcPopup` (~13554), NPC link picker
  (~13562+), `renderMapPanel`/map build (~6098/5999), gallery rail (`rightSec:"gallery"`).

## Small companions
- **character.js** — data model only (above). No DOM, no storage; the wizard/panel and
  `characterSheet` are its consumers.
- **world.js** — `loadWorld()` is the single choke point turning any world text (bundled,
  imported file, kv record) into the canonical runtime object: meta (nsfw/commentsOff/remix
  markers as FIELDS, reserved legacy tags stripped), `lorebook`, `trackerDefs`, `npcTrackerDefs`,
  `statDefs`+`statsCfg`, `starts[]` (incl. `custom:true` + `trackerOverrides`), `npcs`,
  image prefs, `proseRules` toggle. `WorldStore` = kv library of user worlds; `worldToFile/
  exportWorld/WORLD_EXTENSION(".mno-world")`. Detail: doc 24.
- **notes.js** — author's notes live as upload blobs (`user.uploads.dev/file/<32hex>.txt`);
  `notesIdFromValue`/`isNotesPointer` distinguish draft text from pointers,
  `fetchNotesText` fetches `<id>.txt` then bare `<id>` with cache + shared in-flight,
  `notesSectionShell`/`fillNotesSection` paint the detail-panel section.
- **user-profile.js** — mounts `#user/<id>`: reads the catalog via community.js, renders
  bio/avatar/socials (Reddit/Discord circles; bare Discord name copies on click) and published
  worlds as world cards; editing lives in Settings → Identity.

## Interactions
- **doc 20/21** (shell & storage): main.js mounts the shells, owns the kv stores, landing routing
  lives here; nav-history/back-close conventions are 20's topic.
- **doc 23**: `routedGenText`/route toggles, `RPEngine.buildContext` prompt assembly, streaming,
  reply parsing — main.js only drives and renders.
- **doc 24**: world editor/craft/import pages mount through `initWorldCraft`/`initScenarioImport`
  + `window.mnoApp`.
- **doc 25**: stats/tracker/action definitions and behaviors; main.js renders and stores, 25's
  modules compute.
- Loreweaver server: kv endpoint (sessions/worlds/presets mirror), `/v1/chat/completions` bridge.

## Gotchas
- **World binding before normalize**: `enterSession` binds the world BEFORE `normalize`, because
  `initCharacterStats` clamps stats to the bound world's defs — any other order bakes wrong caps
  into the save. A storage-blind open (`opts.world:false`) skips world-dependent clamping
  entirely rather than invent fallback caps.
- `applyWorld()` rebuilds `engine`, `npcSys`, `mapSys` and rewrites ~20 module globals; anything
  holding old references after a world switch is stale. Existing sessions keep the tracker values
  they started with (`trackerOverrides` apply only at session creation).
- `generating=false` is set BEFORE the final `render()` in `runGmTurn` — [[CHOICE]] buttons render
  hidden while generating; clearing early also lets the map refresh run immediately.
- A failed GM call must save NOTHING (`generateGmReply` returns `[]` on error, and runGmTurn
  toasts instead of writing a broken turn); an empty send afterwards retries the unanswered action.
- Tracker state is derived, not stored: `currentTrackers()` replays each message's
  `afterTrackers` snapshot, so deletes/re-rolls/nav revert state for free. Never write live
  tracker values directly (manual edits stamp snapshots onto messages).
- NPC tracker extraction must run BEFORE hero tracker extraction (per-`Name:` headers match the
  hero block's shape); action strips come out before both ([rpge-patch 019] ordering in
  generateGmReply).
- `turn` counts ANCHORED turns (player actions+directs), not messages; normalize re-clamps it.
  Roll-up/history/life cursors are all clamped on load so a deleted tail can't stall a cadence.
- Re-roll archives are lazy: a never-re-rolled turn stores no archive; the first re-roll
  materializes version 0. `compactVersionArchives` shrinks old saves.
- `enterSession` pushes exactly one history entry; the menu-grid "keep session" bridge
  (`keepSession`/`menuReturnSession`) re-enters the stashed chat on Back — reorder at your peril.
- Level-up points are granted one level per turn (never a burst for a tracker jump 1→3), and
  `statsAwardedLevel` never moves backwards — re-rolls/deletes can't double-pay or claw back.
- The wizard's step list is dynamic (start/trackers steps appear conditionally); step indexes are
  re-clamped when the list changes mid-wizard.
- Preset library lives in `kv.rpg` (server-mirrored); the legacy localStorage blob is migrated
  once, then removed — don't write to `rpge.promptPreset` anymore.
- `saveAndMaybeMemory` step order matters: history snippet runs BEFORE the memory roll-up so a
  fresh snippet's turns are summarized before the bake reads them.
