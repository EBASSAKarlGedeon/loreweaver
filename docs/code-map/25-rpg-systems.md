# 25 — RPG Engine: Game Systems (Code Map)

> The mechanics layer: stats, trackers, actions (incl. auto-invoke), NPCs, maps, scene images, dice.
> Engine app at `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/` (own git repo;
> patch log `PATCHES.md` at root). Paths from Loreweaver repo root. Line refs approximate,
> written 2026-11-24.

## Purpose & user-facing surface

- **Stats** — world-defined attributes with roll modifiers; hero panel rows show `base → effective (+buff)`; referee/roll decisions.
- **Trackers** — world-defined gauges/labels (supplies, suspicion, day/time, location, quests, XP/level) with formula-driven maxes/starts.
- **Actions/abilities** — passive (always on) & active (toggle) buffs; gained via story cards or the generator (patch 025); auto-invoked by the player's own words.
- **NPCs** — roster with persistent dossiers + between-turn "life" simulation (goals, memories, movement).
- **Maps** — location/POI system with scale inference and travel.
- **Scene images** — per-turn illustrations (scene modal, transcript thumbnails, gallery) with pluggable providers (incl. ComfyUI follow mode).
- **Dice** — inline dice notation rendering in story text.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `app/src/scripts/actions.js` | 211 | Pure action-card model: normalize, strip parsing, effective stats, auto-invoke detection, offer validation (patch 025) |
| `app/src/scripts/stats.js` | 244 | Stat config parsing, check math (modifiers, DCs, difficulty), tiers |
| `app/src/scripts/trackers.js` | 1650 | Tracker model: config parse, formulas, special trackers (life/level/exp/location/quest/day/time), extraction |
| `app/src/scripts/npc-system.js` | 970 | NPC link rule + persona merge (`npcLinkRuleFor` ~27, `mergePersona` ~42) |
| `app/src/scripts/npc-life.js` | 839 | Between-turn NPC life: goals, private memories, dossiers, snapshots |
| `app/src/scripts/map-system.js` | 580 | Locations & POIs: scale classification, matching, placement, travel (`normalizeLoc` ~396, `matchPoi` ~456, `clampToScale` ~496, `freeSpotNear` ~540) |
| `app/src/scripts/scene-images.js` | 1124 | Scene modal + background generation + gallery (`initSceneImages(deps)` ~24 state injection) |
| `app/src/scripts/image-provider.js` | 950 | Image provider registry/config (`getImageConfig` ~110, `saveImageConfig` ~136; bridges through the Loreweaver server) |
| `app/src/scripts/image-gen-prefs.js`, `image-style-presets.js`, `image-utils.js` | — | Provider prefs, style presets, aspect/format helpers |
| `app/src/scripts/scene-dice.js` | 36 | Inline dice notation → markup |
| `app/src/scripts/scene-refs.js` | 87 | Cross-reference rendering |
| `app/src/scripts/memory-system.js` + `memory-history.js` | 1367 | Memory roll-ups + retrieval (see map 23 for prompt feed; constants at ~55-80: `MEMORY_EVERY_TURNS` 10, feed caps 4/4/4+names 4) |

## Key functions — actions (patch 025)

- `normalizeAction(raw, statDefs)` — ~16 — canonical card `{id, name, icon, kind: passive|active, deltas, effect, active, source: hero|story}`; unknown stat keys dropped, icon ≤2 code points.
- `parseActionStrips(rawText)` — ~40 — extracts `[ACTION: Name | kind | stat +N, … | effect]` lines (GM-granted abilities ride the reply).
- `effectiveStats(character, statDefs)` — ~69 — base + passive + active-while-on; stacking can EXCEED world stat max (low side clamps to min only).
- `buffsFor(character, statKey)` — ~86 — which actions contribute to a stat.
- `actionsContext(character)` — ~94 — the ACTIONS block text the GM sees (+`ACTION_GAIN_RULE` ~108 area) telling it how to propose new abilities.
- `detectActionToggles(text, character)` — ~146 — per-SENTENCE matching of action name (word-boundary, case-insensitive) + cue: invoke → ON, dismiss → OFF, dismissal wins; bare mention inert; idempotent.
- `applyActionToggles(det)` — ~166 — applies and reports what changed (caller toasts + saves).
- `normalizeActionOffer(raw, statDefs, {maxDelta})` — ~179 — validates one AI offer (delta clamp, zeros dropped, name required).
- `actionGenRule(maxDelta)` — ~202 — prompt block demanding a strict JSON ARRAY of 2–4 offers (≤1 active, extras demote).
- Wire-up lives in main.js (map 22): `autoInvokeActions` before the GM call; `generateActionOffers`/`wireActionGen` shared by wizard + hero panel.

## Key functions — stats & trackers

- `parseStatsConfig(text)` — ~14 — world stat defs (`key: label; sides; starts…`).
- `statMod` ~61, `checkMod` ~84, `dcValueForBase` ~125, `dcForDifficulty` ~137, `resolveCheck(decision, stats, defs, cfg)` ~162 — the check pipeline (referee decides difficulty → roll vs DC).
- `clampStat` ~206, `ensureStats` ~222, `buildStatsContext` ~235 (GM block).
- Trackers: `parseTrackerConfig` ~250, formula engine `evalFormula` ~56 / `formulaScope` ~189, `effectiveMax/Start` ~202/215, special trackers `lifeTracker` ~319, `levelTracker` ~328, `expTracker` ~336, `locationTracker` ~359, `questTrackers` ~375, `dayTracker` ~394, `timeTracker` ~406.

## Key functions — NPCs

- `npc-life.js`: `dossierFor(entry, heroName)` ~144, `inventBriefFor` ~121, goal machinery `pastGoalsFor` ~162 / `goalOverlapScore` ~326 / `isNearDupGoal` ~337, `latestOwnedMemories` ~186 (NPC-private memory recall), `recentMentions` ~222, `snapshotAtTurn` ~254 (tracker snapshots for "at turn N" questions).
- `npc-system.js`: `npcLinkRuleFor(state, display)` ~27 — how NPC names link to portraits/roster.

## Key functions — scene images

- `runSceneCommand` ~78 / `quickSceneImage` ~87 — composer entry points.
- `genImagePrompt(focus)` ~137 — AI drafts the scene prompt (image-prompt.md template, map 23).
- `generateSceneImages(msg, base, amt, aspect)` ~488 — background generation with per-slot spinners, failed slots revert; `rerollSceneImages` ~856, `generateSingleSlot` ~915.
- `imageMsgEl(m)` ~667 — transcript thumbnails; `openGallery` ~1030 + `allGalleryImages` ~1016 (re-exported for the lightbox).

## Data structures & persistence

- Everything rides the session save (map 21 KV `rpg/session_<id>`): `character.stats`, `character.actions`, tracker state, npc roster with `goals`/`memories`, map POIs, scene prefs (`mno.scenePrefs`, machine-local).
- Action sources: `hero` (wizard/editor), `story` (GM strip card accepted).

## Interactions

- Turn loop (map 22): referee uses `effectiveStats`; strips parsed before tracker extraction; auto-invoke before the GM call so the roll already has the buff.
- AI plumbing (map 23): stats/trackers/actions/memory blocks in the system prompt.
- Worlds (map 24): stat/tracker/NPC definitions come from the world file.
- Storage (map 21): provider config persists in machine prefs; images via Loreweaver server bridges.

## Gotchas

- **The iron rule**: the AI never writes stats directly — it proposes cards/strips, the player accepts, code applies (patch 019 lesson).
- Active-action toggles persist through re-rolls of the same turn (documented behavior; the toggle happens on submit, not per-generation).
- `effectiveStats` deliberately exceeds world max while buffed — don't "fix" it by clamping high side.
- Auto-invoke is cue-based: rewriting cue words breaks it; `tools/check-actions-auto.js` (27 tests) guards the regexes.
- Scene images: failed slots revert (no partial replacement); deletion of a message cleans its images (`deleteMessageImages` ~812).
- NPC life caps: near-duplicate goals are rejected (`isNearDupGoal`); memory ownership folding rules at `memory-system.js` header are subtle — read before touching feeds.
