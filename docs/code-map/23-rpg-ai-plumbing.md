# 23 — RPG AI Plumbing (Code Map)
> Paths relative to the Loreweaver repo root. The RPG engine is its own git repo nested at
> `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/` (PATCHES.md at its root logs
> the patches referenced below as `[rpge-patch NNN]`; app source at `app/src/scripts/`). Line
> refs are approximate (`file:~line`, written 2026-11-24). Trust function names over line
> numbers. Sibling docs: `00-INDEX.md`; stats/trackers detail is doc 25, game-core main.js is doc 22.

## Purpose & user-facing surface
How an AI call made anywhere in the game reaches the Loreweaver server, how the GM prompt is
assembled, how replies are parsed back into game state. User-facing surface: **Settings → AI
Model** (profile picker, per-route toggles, response tuning, Test button), the admin ctx-meter
pip, the World Editor's Context tab, the prompt-preset library, and the in-chat failure toasts.

There is exactly ONE text path: the Loreweaver bridge. The old five-provider layer (Perchance +
BYOK) is gone ([rpge-patch 018]); endpoint, model and API key are resolved SERVER-side from a
Connection Manager profile — the game only picks profiles and routes.

## Files overview
| File | ~Lines | Role |
|---|---|---|
| `…/app/src/scripts/ai-provider.js` | 827 | Provider routing (`routedGenText`), bridge HTTP/SSE, Settings → AI Model UI |
| `…/app/src/scripts/rp-engine.js` | 2456 | RPEngine: context build, GM/death/scene/check calls, reply parsing |
| `…/app/src/scripts/context-budget.js` | 620 | World Editor "Context" tab: measures a real turn's tokens (no AI calls) |
| `…/app/src/scripts/ctx-meter.js` | 449 | Admin-only in-chat token pip + "what the AI sees" popup |
| `…/app/src/scripts/presets.js` | 328 | ST prompt-preset schema: parse/macro-expand/assemble ([rpge-patch 022]) |
| `…/app/src/scripts/prose-rules.js` | 42 | Anti-slop prose pack, injected into the stable prompt prefix |
| `…/app/src/scripts/banned-words.js` | 22 | Banned AI title/name words (prompt-only filters for world crafting) |
| `…/app/src/scripts/bio-words.js` | 753 | Word pools + genre detection for the non-AI bio randomizer |
| `…/app/src/scripts/regex.js` | 306 | Port of Loreweaver's regex extension (scripts → string rewrites) |
| `…/app/src/scripts/memory-system.js` | 1367 | Memory entries, owner gating, roll-up summarizer + feeds |
| `…/app/src/scripts/memory-history.js` | 351 | Layered narrative-history spine (delta snippets, promotion, render) |
| `…/app/src/scripts/scene-refs.js` | 87 | NPC/hero reference images attached to external image calls |
| `…/app/src/scripts/narrator-prompt.md` | 81 | The GM system prompt (fetched at boot into `promptText`) |
| `…/app/src/scripts/image-prompt.md` | 21 | Default scene-image prompt template (`engineImagePrompt`) |

## Provider routing — how a call reaches the server
- `PROVIDERS` — ai-provider.js:~19 — a single entry `{id:"loreweaver", baseUrl: location.origin+"/v1", noKey:true}`.
  `bridgeDefaultOn()` (~28) force-writes `window.LoreweaverBridge` config `{enabled:true,
  usePreset:true, contextTokens:16384}` on first run so a fresh install works with zero config
  (the shim resolves an empty profileId to Loreweaver's selected profile).
- `window.genText = routedGenText` is set in main.js:~112; the engine's native root generateText
  is captured at module load as `rootGenText` (~17) — kept ONLY for the tokenizer meta probe
  (`genText({getMetaObject:true})` reaches the plugin's `countTokens`; used by context-budget.js
  and ctx-meter.js, never for generation).
- Routes — `AI_ROUTE_IDS` (~72): `gm, check, staging, tracker, npc, scene, memory, npclife, other`
  with labels/hints (`AI_ROUTE_LABELS/HINTS` ~73/84). Every text call carries `route`; Settings →
  AI Model toggles per route; **a job switched off DOESN'T RUN** (no fallback provider — callers
  already tolerate per-job failure; the GM turn toasts).
- `routedGenText(inputData, extraOpts)` — ai-provider.js:~449 — meta-probe passthrough → route
  extraction (from input object or extraOpts, unknown → "other") → `routeUsesExternal` gate →
  `bridgeGenText(normalizeInput(...), route)`.
- `bridgeGenText(norm, route)` — ai-provider.js:~311 — the one path: POST `<origin>/v1/chat/
  completions` with header `X-RPGE-Route: <route>` ([rpge-patch 001]). The bridge shim
  (`app/shims/loreweaver-bridge.js`, a fetch wrapper) rewrites this onto the Loreweaver server
  with the chosen profile; **the API key never touches the page**. Body: `{model:"loreweaver",
  messages:[{role:"user",content}, {role:"assistant",content:startWith}?], stream, max_tokens,
  stop, samplers…}`. Non-stream → JSON `choices[0].message.content`; stream → SSE parse
  (`data:` lines, `[DONE]`), 90s stall timeout, 300s absolute cap; `onChunk/onStart/onFinish`
  callbacks; `p.stop()` aborts the controller + cancels the reader. Errors carry human messages
  ("is the Loreweaver server running…", 404 ⇒ "bridge only works when served by the Loreweaver server").
- Response tuning ([rpge-patch 022 followup]): `getSamplerOverrides`/`getMaxReplyTokensOverride`
  (~124/130) — user-set `temperature/top_p/top_k/frequency_penalty/presence_penalty` are sent
  only when set (the shim fills only unset fields); the GM narration call may take a user reply
  cap, bookkeeping calls keep engine caps. `getStreamingOn()` (~135).
- Config persistence: localStorage `mno.aiProvider` (`readStore/writeStore` ~40/58; legacy stores
  collapse to loreweaver), `getAiConfig/saveAiConfig` (~188/200), `aiModelLabel` (~256),
  `testBridgeConnection` (~474, one real turn through the bridge; a 200-with-error-payload counts
  as failure), `aiModelSection` (~501) renders the Settings section.
- `bridgedInputCap()` (~239) exposes the shim's configured context budget to the fitting layer.

## How a GM prompt is assembled (RPEngine.buildContext — rp-engine.js:~786)
Ordered parts, stable-prefix-cluster first (prefix-cache friendly), volatile cluster after:
1. **GM INSTRUCTIONS** — `narrator-prompt.md` fetched at boot into `promptText` (main.js:~555);
   second person, `[Name]` dialogue blocks, `✦ ✦ ✦` scene breaks, duet `[A & B] x | y` speech,
   no speaking for the player.
2. **NARRATIVE VIBE** — world's `narrativeVibe` (tone; separate from the immutable system prompt).
3. **WORLD DESCRIPTION** — always-canon world text ([rpge-patch 004]).
4. **WRITING RULES** — `PROSE_RULES_TEXT` (prose-rules.js) when `world.proseRules !== false`
   ([rpge-patch 010]); `[bad] → [good]` anti-slop pack distilled from four community presets.
5. **PRESET DIRECTIVES** — `presetAssemble(hero)` (rp-engine.js:~678 → presets.js
   `assemblePresetPrompt`): the loaded ST preset's enabled non-marker blocks in `prompt_order`
   play order, ST macros expanded fresh per turn (markers are skipped — the engine fills those
   slots natively). Silent when no preset is on.
6. **WORLD PREMISE** — `scenarioText`, every turn. **STARTING SCENARIO** — `startText`, only the
   first turns (skip in verbatim mode, where the start already IS turn 0).
7. **CHARACTER SHEET** — character.js `characterSheet`: bio + stats + EFFECTIVE stats (buffs) +
   ACTIONS block + powers; plus `ACTION_GAIN_RULE` (how the GM awards abilities as `[ACTION: …]`
   strips). The ACTIONS block detail: doc 25.
8. **Hero tracked values** — `buildTrackerValuesContext` (values + effects, no mutation rules;
   the GM never outputs the machine block). Prefix cache breaks here by design.
9. **WORLD LORE** — `loreForTurn` (lorebook.js): always-entries + BM25 top-N keyword entries for
   recent chat/action/location, optional hybrid rerank. Volatile cluster on purpose.
10. **LATEST SITUATION** — one line + age stamp ("3 turns ago").
11. **OPEN THREADS** — rolled-up objectives/promises with planted-turn age + OVERDUE flags;
    **DIRECTION** injections: thread-dice resurface and scene-dice nudge, only when
    `targetTurn === state.turn` (re-rolls re-inject, never leak).
12. **MEMORIES** — `memoriesForTurn` (memory-system.js:~): player manual notes ALWAYS fed; auto
    entries in three 4-slot budgets — topical-gated (owner present), topical-open (relevance
    only, may bleed), name-only (needs a recent `[Name]` speaker); ranked BM25 0.6/0.4 +
    embeddings 0.75/0.25 fused RRF; entries still inside the verbatim transcript window are
    skipped (no double-feed). **STANDING COMMITMENTS** — pinned importance-3 memories always fed.
13. **NARRATIVE HISTORY** — `renderHistory(state)` (memory-history.js): the layered summary of
    everything before the recent window, ALWAYS fed, bounded by budget (default 10000 tokens).
14. **NPC PROFILES** — three tiers within `NPC_TOTAL_CAP`: full dossiers (secrets included) for
    Active speakers + scene-present roster; hooks (one-liners) for overflow/present-remainder/
    relevance/rotation faces; unmet world cast are hooks-only until met (opening-scene exception:
    cast named in the Start text get dossiers). **SURROUNDINGS** (map feed) when supplied.
- Fitting: `gmFitOpts` (~1549) + `fittedInstruction` (~1571) fit the whole instruction under the
  bridged input cap (`bridgedInputCap` − `GM_FIT_MARGIN`): drop surroundings first, then rotation
  hooks, then oldest baked turns (≤ `RECENT_TURNS`=10), finally truncate narration — but the
  newest `GM_MIN_FULL_TURNS`=5 turns are never dropped and the newest 3 never truncated.
- The player's action text is `{{user}}`-substituted everywhere via `subUser` (text-utils.js);
  the model never sees the raw token.

## How the provider call is made & streamed
- `generateGmReply(state, history, actionText, onStream, kind, opening, opts)` — rp-engine.js:~1602 —
  embeds the turn query (`hybridForTurn`), builds the fitted instruction, then streams with
  `stopSequences: TRACKER_LEAK_STOPS` + an `onChunk` backstop that aborts the stream the moment
  the model echoes tracker state (`findTrackerLeakStart`). On error: `lastError` set, returns `[]`
  (nothing saved — main.js toasts).
- Pre-reply calls run in PARALLEL in main.js `runGmTurn`: `determineCheck` (~2029, referee: one
  line `[CHECK] stat: agi | difficulty: medium` or `[NO CHECK]`, maxTokens 120, route "check";
  d20 math is client-side in stats.js `resolveCheck`) and `determineScene` (~2122, scene manager:
  `{in, out, next, change, present}` delta verdict against the stored cursor, roster packed by
  char budget, route "staging").
- Post-reply, also parallel (both take only the cleaned reply text): `updateTrackers` (~1813,
  route "tracker": outputs ONLY a `[TRACKERS]` block for the state AFTER the turn; previous
  values + already-applied changes are given so it doesn't re-apply; `applyTrackerModes` pins
  locked/unlimited trackers; `enforceLevelUp` backstop fixes a pinned-exp level-up arithmetically)
  and `updateNpcTrackers` (~1919, route "tracker": per-NPC `[NPC TRACKERS]` block; newcomers and
  actual speakers get roster priority; off-screen changes recorded as `afterNpcTrackersOffscreen`).
- Each parsed message carries `afterTrackers` / `afterNpcTrackers` / `afterScene` snapshots — the
  live state is always derivable from messages (deletes/re-rolls revert for free).
- `generateDeathScene` (~1730, kind "death") — one final GM call when the life tracker hits 0;
  deliberately NO tracker update after it.
- `parseGmOutput(text)` — rp-engine.js:~2311 — the reply grammar, extraction order matters:
  1. `stripThinkBlocks` (~25): closed `<think|thinking|thought|reasoning>` pairs cut; an unclosed
     opener cuts everything from the LAST opener (truncated-stream reasoning). Runs first.
  2. `stripTrackerLeak` (trackers.js): a leaked `TRACKED STATE` echo is cut header→end.
  3. `[[NPC: Name | excerpt]]` tags → `npcPromotes[]` + `npcNotes{}` (profile/portrait writers
     consume the excerpt; spaced `] ]` tolerated; half-typed fragments dropped).
  4. `[[CHOICE|OPTION: text]]` → CYOA options, emitted as ONE `choice` message appended LAST so
     buttons sit under the reply. Unknown `[[…]]` spans stripped (engine directives, never story).
  5. `[Name] line` → npc message; `[Name inner] line` → thought; `[A & B] x | y` → two `duet`
     npc messages (renderer pairs them via `duetEl`; downstream sees ordinary npc lines);
     `OOC/META/SYSTEM` lines dropped; separator-glyph lines (`✦ ✦ ✦`, `---`, …) → `meta` scene
     break; everything else accumulates into narrator paragraphs.
  6. Empty output falls back to one narrator message.
- `[ACTION: Name | kind | deltas | effect]` ability-gain strips: `parseActionStrips` (actions.js)
  run BEFORE the tracker extractor (so they can't be read as `key:` lines); gains ride the LAST
  parsed message as `actionGains` → the offer card the player accepts (doc 25).
- Hero tracker extraction `extractTrackers` (trackers.js) runs LAST; the authoritative state
  comes from the dedicated tracker calls, never from the GM narrative.

## Memory & history systems (what the GM "remembers")
- `memory-system.js` — entry shape `{text, turn, owner, triggers, pinned, importance}`; owner is
  WHO knows it ("world" = public; comma-joined names for shared secrets; "you/hero" aliases fold
  to the hero, "everyone" folds to world). Cadence: `MEMORY_EVERY_TURNS`=10 anchored turns, lag
  `MEMORY_LAG_TURNS`=2 (still-editable tail never baked). The roll-up feeds ONLY story transcript
  (narration + `[Name]` dialogue incl. thoughts + hero actions; OOC/commands/pips/trackers kept
  out). `MemorySystem.rollUp(state)` (class ~) writes memories + `latestSituation` + `openThreads`
  and a lastRollUpReport; main.js toasts and saves (see doc 22 `saveAndMaybeMemory`).
- `memory-history.js` ([rpge-patch 009]) — Summaryception-style recursive summary: snippets cover
  `HISTORY_SNIPPET_TURNS`=5 anchored turns, first run at turn `HISTORY_START_TURN`=10;
  `HISTORY_LAYER_CAP`=30 snippets/layer, merge 3 on promotion, 5 layers max; budget 10000 tokens
  (`setHistoryBudget`/`effectiveBudget`, device-level localStorage, clamped under the bridge
  budget). `runHistorySnippet` writes one delta snippet per trigger (route "memory");
  `invalidateFromTurn` kills snippets on edits/re-rolls; `migrateDigest` seeds layer 0 from the
  retired DISTANT PAST digest; `backlogEligible`/`pendingTurns` power the backlog offer.
- Context metering: `ctx-meter.js` — admin pip showing the EXACT last prompts (gm/check/staging/
  tracker/npc via `CALL_DEFS` ~43) + background calls (life tick, roll-up); persisted per
  adventure in kv key `ctxmeter_<id>` (NOT inside the save). `context-budget.js` — editor-only:
  reuses the real builders with a mock genText + the plugin tokenizer to estimate a worst-case
  turn; never calls the AI, off the play path.
- `presets.js` — ST preset model: `parsePresetJson` (~56), `assemblePresetPrompt` (~285), macro
  engine `expandMacros` (~196, ST family order, `{{trim}}` semantics, unknown macros stay
  literal), `rollFormula`/`{{roll:1d20}}` fix, `serializePresetExport` (~325). Pure data (no DOM)
  so `tools/check-presets.js` tests it in Node.
- `regex.js` ([rpge-patch 021]) — port of Loreweaver's regex extension: `getRegexedString`
  (~264), `regex_placement` (~47), `/pattern/flags` parsing, `{{match}}`/group refs, trimStrings,
  markdown/prompt-only + depth gates. Scripts are passed in as an array (no ST storage layer).
- `banned-words.js` — `WORLD_TITLE_BANNED` / `NPC_NAME_BANNED` lists, prompt-only filters used by
  world-craft/world-editor name generation; never filters the GM's runtime NPCs or typed names.
- `bio-words.js` — pools + `detectGenre`/`rollBio` for the wizard's non-AI randomizer (doc 22).
- `scene-refs.js` — for EXTERNAL image calls only: `findSceneNpcRefs` (name hits in the finished
  prompt → up to `MAX_SCENE_REFS`=4 avatars, first-mention order) + `scenePromptWithRefs`
  ("Image reference N is X… facial traits only"); `refsSupported` (~) gates by provider/model.
- **narrator-prompt.md** — the GM system prompt: second person, sensory detail, never control the
  player, `[Name]` dialogue blocks (mandatory, blank-line separated), duet `&` speech, `✦ ✦ ✦`
  scene breaks, pacing rules, NSFW clause. Fetched fresh per boot; worlds can't override it.
- **image-prompt.md** — the default scene-image prompt: parenthesized visual schema
  `(name, age appearance, race, body, clothing, condition/pose/expression)` + `(background, lighting/time, shot, composition)`;
  worlds override via `imagePrompt` in the world file, else this is the fallback (`engineImagePrompt`).

## Data structures & persistence
- AI config: localStorage `mno.aiProvider` — `{provider:"loreweaver", profileName,
  allowReasoning, thinkingBudget, useExternal{route:bool}, samplers{field|""}, maxReplyTokens,
  streaming}`; keys `mno.aiProviderKey` shared with image providers (BYOK image routes only —
  text needs no key). Bridge config itself lives in `window.LoreweaverBridge` (written by the shim).
- Prompt-preset library: kv `rpg.promptPresets` = `{presets:[{name, raw}], active, on}` — server-
  mirrored like sessions/worlds; legacy single-preset localStorage migrated once (main.js:~176).
- History config: localStorage (per device) — budget override from the History panel.
- Ctx meter: kv `ctxmeter_<adventureId>` (last turn's measured prompts).
- Everything AI produces (memories, history snippets, tracker snapshots, scene verdicts, thread/
  scene directives) is stored ON the session save and syncs like it (docs 21/22).

## Interactions
- **doc 22** (main.js): boot fetches the prompt templates, wires `genText`, owns `runGmTurn`'s
  call ordering (parallel referee+scene → GM → parallel trackers), `saveAndMaybeMemory` cadences.
- **doc 25**: stats.js (`resolveCheck`, `buildStatsContext`), trackers.js (context builders,
  extractors, leak stops, caps), actions.js (ACTIONS block, gain rule, strips), npc-life.js,
  lorebook.js (`loreForTurn`, trigger windows), scene-images (image routes).
- **doc 21**: `window.kv`/bridge shim provisioning; the shim's profile → Connection Manager
  mapping on the server side.
- Loreweaver core (docs 12/13): the `/v1/chat/completions` endpoint and profiles are the ST
  server's; `presets.js`/`regex.js` intentionally mirror ST's `public/scripts/macros.js` and
  `public/scripts/extensions/regex/engine.js` behavior — keep them in sync when changing either side.

## Gotchas
- There is NO fallback provider: disabling a route makes that job silently skip (per-job catch)
  or toast (GM turn). Don't add a fallback without redesigning the route toggles' contract.
- The route header `X-RPGE-Route` is the ONLY per-job signal; the shim maps routes → profiles
  server-side. Unmapped routes ride the main profile as "other".
- API keys never enter the page for text — anything asking for a text key is a BYOK-era leftover.
- Prefix-cache design is deliberate: static parts (narrator prompt, vibe, world description, prose
  pack, preset blocks) precede the volatile cluster (lore, memories, history, NPC profiles,
  trackers). Moving sections around re-banks nothing — keep the order.
- Extraction order in `generateGmReply`/`parseGmOutput` is load-bearing: think-blocks → leak cut →
  NPC tracker block → ACTION strips → hero tracker block → dialogue parsing. Reordering leaks
  blocks into narration or misparses names.
- `determineCheck`/`determineScene` take only PRE-reply inputs and run in parallel; the GM context
  is fed the check RESULT and the scene verdict — never ask them again inside the GM call.
- Verbatim starts skip ALL AI calls (no check, no scene, no generation); re-rolling a verbatim
  opening AI-generates a replacement instead ([rpge-patch] noted in runGmTurn).
- Stopped replies: `_aborted` keeps partial text but skips both tracker calls — the tracked state
  simply carries over; scene verdict is skipped too (the next turn's manager widens its window).
- The 90s/300s stream timeouts and the stall error exist because a hung bridge previously froze
  turns silently; a stall with zero generated text throws.
- `GM_REPLY_MAX_TOKENS`=2000 exists for OpenRouter's credit check on missing max_tokens; user
  tuning overrides it only for the "gm" route.
- `context-budget.js` must never call the AI: it hands the engine a mock genText; if you add an
  engine call that escapes the mock, the editor will start spending generations.
- Ctx meter persistence is per-adventure kv, deliberately NOT in the save — exports never carry it.
- Hybrid retrieval is best-effort: a cold embedding model nulls out and the turn runs pure BM25
  (embeddings.js warmup covers it in the background; see doc 22 `enterSession` warmup).
