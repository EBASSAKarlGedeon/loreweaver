# Character Cells — design decisions (brainstorm doc)

Status: **slices 1-4 built** (state store + panel, witness-filtered injection, bookkeeper pass, tier auto-detection, perspective rebuild in Main Character mode). Last updated: 2026-11-11.
This doc is the continuation point: if the chat history is cleared, read this file and resume from "Open questions".

Origin: the FF 5.4 "Internal States" preset (`data/default-user/OpenAI Settings/Freaky Frankenstein 5.4 Internal States vers. Fiction Styles + Ground Prose Rules.json`) simulates app features with prompt gymnastics. This project moves that state into Loreweaver itself, as structured data, to fix two pains:

1. **Memory mixing** (the worse pain, breaks immersion): summarizer-based memory (Summaryception) gives every character knowledge of everything. After ~300 turns characters "witness" things they never saw.
2. **Cost**: with GLM 5.2 + heavy lorebook, a turn costs ~40k input / 6–12k output tokens. Much of the output is the model rewriting the internal-states block + a 10-task CoT every turn; the actual narration is capped at 200 words.

## Core principle

**The app owns the state; the model only proposes changes to it.**

- State lives as structured JSON per chat (in chat metadata → rides along with existing sync for free).
- The narrator model writes prose only. It never regurgitates state, never outputs internal-states HTML.
- A second, cheap "bookkeeper" model call reads the new scene and emits small change commands.
- The UI renders the panels natively from the data.

## Architecture

### 1. Character cell schema (per chat)

```json
{
  "id": "sylpha",
  "tier": "main",                  // main / secondary / minor / offstage
  "identity": "Gentle, maternal maid...",
  "archetype": "yandere-adjacent", // reserved for the personality model (below)
  "bonds": { "user": 8, "miyu": 3 },   // BOND / Sparks / Grudge as numbers
  "agenda": { "goal": "...", "step": 2, "max": 3, "location": "kitchen" },
  "status": "healthy",
  "memories": [
    { "id": "m123",
      "what": "Adam disarmed Daichi at the spar",
      "witnesses": ["sylpha", "daichi"],
      "importance": 2,
      "turn": 41 }
  ]
}
```

Plus `world.json`-style data (flags, threads = today's GM Notebook, time/location).

### 2. Access-controlled memory injection (the memory-mixing fix)

Before each generation, the context builder injects **only what each present character may know**:

- Present characters get their own memories + memories they witnessed.
- A character who wasn't in scene A never receives scene A's facts in the prompt → the model *cannot* leak them, because they were never in context.
- The old GM-Notebook `[R]` rules ("Mei Hua does NOT know Adam personally") become enforced by filtering instead of by instruction.
- This is a retrieval filter — no smarter model needed.

Placement rule for prompt caching: stable content (preset, card, lorebook) first; volatile state last, so the provider's cached prefix survives.

Perspective rebuild (the full hard wall) — DECIDED 2026-11-11: ships scoped to **Main Character mode** (`/cc-mode main`, requires exactly one main-tier cell; otherwise the omniscient block is used). The perspective block contains: YOU (the POV character's full cell), OTHERS AS YOU KNOW THEM (observable sketch only — no bonds/agendas/thoughts/inventories of others), WHAT YOU KNOW (witness-filtered ledger), USER titles/status only, plus world sections with faction intel/fibs, secret Chekhov plants and GM NOTES dropped entirely. Group narration keeps the omniscient block (one prompt voices several minds).

### 3. Bookkeeper pass (multi-model split)

- Narrator model (e.g. Gemma 4): writes the scene prose only.
- Bookkeeper model (cheap, e.g. a small GLM): reads only the new scene text + current state summary, emits change commands:

  ```
  witness(m123, daichi)
  bond(+1, miyu)
  agenda_step(sylpha)
  memory_add(who=daichi, what="...", importance=1)
  ```

- The app applies the commands to the JSON. Chosen over native function-calling on the narrator: narrators that also juggle tools write worse prose and forget calls; and this natively gives the "different models for different jobs" goal. One extra small call per turn.

### 4. Panel (UI)

- A SillyTavern-style extension **drawer panel** (in the Extensions menu area) is the panel's home.
- **One click from chat too**: a small state button/icon in the message actions row (next to edit/delete/regenerate) opens the same panel. One panel, two doors — the drawer is home; the chat button is the shortcut. (DECIDED 2026-11-10.)
- **Both doors open the same extension drawer** (DECIDED 2026-11-10): the drawer slides open below the top bar over the chat, like any ST extension drawer — one consistent place, room for hand-editing. The chat icon is just a shortcut that opens it. (A per-turn popover anchored to the message is a possible later addition.)
- The full internal-states block is NOT rendered inline in chat messages: once the app owns the state there is one live truth; inline copies would be stale snapshots. (Optional later: per-turn snapshots so old messages' state is viewable.)
- It renders the state JSON as the **same collapsible `<details>` HTML as the original internal states block, verbatim in appearance** — same sections (NPC Agendas, GM's Notebook, Internal Thoughts, DND sim, Combat, Physics/World, BONDS), same look — but generated from data, editable by hand.
- Manual editing matters: models drift, so the user must be able to fix any cell value directly.
- Slash commands: `/state`, `/promote <char>`, `/demote <char>` etc.

### 5. User cell (DECIDED 2026-11-10)

A **fixed "user" cell** always exists in the state (id `user`, pinned at the top of the panel). It holds the user's personal inventory / titles / status (FF5 `<internal_inv>` scope). It can never be promoted, demoted or deleted; NPCs keep their own per-cell inventories (feeds the off-screen Agenda system). Every NPC's `bonds.user` anchors to it.

### 6. Tier assignment (DECIDED)

**Automatic, with manual override.**

- The engine tracks who is on-screen, who spoke, who acted, and assigns tiers automatically (main / secondary / minor / offstage).
- The user can override any character via `/promote` / `/demote`.
- Promotion/demotion is just a tier field change: a promoted character gets a fuller cell, a demoted one gets compressed. This is the "characters can be promoted/demoted" idea, and later the basis for the "cells evolving deeper" visual-novel idea.

## Modes

Modes are **saved configurations of the same engine**, not separate codepaths:

| Mode | Meaning |
|---|---|
| Default ST mode | Extension off, plain SillyTavern |
| Main Character mode | One main-tier character; everyone else minor |
| RPG mode | Several main/secondary characters |
| Dungeon / turn-by-turn | Same engine + combat rules + Character Expressions (LAST, later) |

## Preset question (DECIDED)

**Yes, create a prose-only companion preset.** The extension and the FF 5.4 internal-states prompts would fight (double bookkeeping). Plan:

- Keep in the new preset: prose style, POV, NSFW toggle, anti-parrot, NPC voice/speech acts, banned words, colored dialogue, output length — everything that shapes *prose*.
- Remove/turn off: all internal-states prompts (DnD sim, Agenda, GM Notebook, Inventory, Bonds, Thoughts, master toggle), the `GFX_START` HTML protocol, and the parts of the BOLT CoT that reference state variables.
- The extension injects the state block itself (as data + a short instruction "this is the scene state; do not re-output it").

Both presets coexist: full FF 5.4 for use without the extension; the prose-only one for Loreweaver cells mode.

## Personality model (IDEA — parked, not urgent)

User idea: instead of dumping raw personality text, build a **personality vocabulary layer** — archetypes + dere types + personality descriptors — as structured tags per character, with a switch to make characters more immersive / more anime-like.

Fit: slots naturally into the cell schema as an `archetype`/`traits` field; a library of descriptor snippets gets injected per character tier. Decide later; nothing built now.

## Parked / non-goals for now

- Character Expressions (visual novel sprites), TTS, animations — they build on cells but add nothing to the skeleton. Later.
- Auto image gen, Twitter feed graphics etc. stay preset-side.
- No cloud anything; sync comes free via chat metadata.

## First slice (when user gives the go — do NOT start without it)

1. Cell schema + per-chat state file (chat metadata).
2. Context injection with witness filtering.
3. Bookkeeper pass updating cells.
4. Drawer panel rendering + hand-editing, styled like the original internal states.

Success test: a chat past turn 300 with zero knowledge leaks that the old setup produced, and visibly lower output tokens per turn.

## Open questions

- ~~Exact command syntax for the bookkeeper (natural-ish DSL vs strict JSON lines)~~ — DECIDED 2026-11-11: one command per line, small DSL (`memory_add`, `witness`, `bond`, `agenda_step`, `agenda_set`, `status`, `presence`, `chekhov`, `turn`); malformed lines are skipped, never crash the turn.
- ~~Single memory list vs per-character copies~~ — DECIDED 2026-11-11: ONE shared event ledger, each event stored once with a witness list (`[{ id, what, witnesses, importance, turn }]`); per-character knowledge is DERIVED at injection time by filtering on witnesses ("store shared, show filtered"). Never widen an existing witness list (Summaryception's rule). Rationale: copies drift, deletion orphans, and the witness-tagged event shape is proven by Summaryception's ledger.
- ~~Which cheap model to default the bookkeeper to~~ — DECIDED 2026-11-11: no hard-coded default; the user picks a **Connection Manager profile** in the Extensions panel ("Character Cells" drawer, dropdown at the top). ALL cheap calls (bookkeeper, backfill, digests) ride that profile via `ConnectionManagerRequestService.sendRequest()` — one-off requests that do NOT switch the narrator's active connection; profile-call failure or empty reply falls back to the active connection for that call. Empty selection = active connection (old behavior). Persisted in extension settings (`bookkeeperProfileId`).
- ~~How tier auto-detection weighs on-screen vs spoke vs acted~~ — DECIDED 2026-11-11: the bookkeeper emits `appear(<cellId>, spoke|acted|present)` for every participant each scene; a rolling 30-scene score (spoke=3, acted=2, present=1) maps to tier bands (≥18 main, ≥9 secondary, ≥3 minor, below → offstage), and ≥6 consecutive absent scenes force offstage. Hysteresis: a tier changes only after 2 consecutive turns agree. Manual override (/cc-promote, /cc-demote, panel dropdown) PINS the cell — auto stops touching it until /cc-autotier <name> releases the pin.
- ~~What happens to fired/pruned agenda bullets (the "Chekhov" lists) — probably become memories with importance decay.~~ — fired plants already land in the ledger via the bookkeeper's memory_add; under the landmark+digest memory scheme they age into digests unless tagged imp-3.

### Memory scheme (DECIDED 2026-11-11: Option C — "digests + landmarks")

The event ledger is **immutable** — nothing ever edits, merges or deletes an event. Only the injected view ages:

- **LANDMARKS**: importance-3 events injected verbatim forever (witness-filtered, cap 10). A turn-300 plot-critical event still reaches a turn-1000 generation.
- **Recent ring**: newest 12 witnessed events verbatim (~last 40 turns).
- **Digest**: everything older and non-landmark, summarized into one paragraph per cell by a cheap isolated call, cached per cell, rebuilt only when the cold set changes. `/cc-digest` forces a rebuild; a bad digest loses nothing.

Old FF5 chats convert via the panel's CC TOOLS: **Clean copy** (new chat file, all internal-states HTML stripped, original untouched) → **Backfill** (ledger rebuilt from turn 0 in 4-message batches, one cheap call each, cancelable/resumable, seeds tier detection from the full history). Fully automatic — no approval gates.

### FF5 mechanics port (DECIDED 2026-11-11: Option 3 — hybrid "prompt + code")

The FF5 internal-states prompts were NOT copied into the extension: they instructed the *narrator* to simulate game mechanics in its output, which is exactly what the extension replaces. Instead each FF5 system is split:

- **Mechanical part → code** (deterministic, free, unfudgeable): runs in a **pre-generation tick engine** (`tick.js`) hooked on `GENERATION_AFTER_COMMANDS` — awaited by Generate() BEFORE prompt assembly, so the tick's results are already in the injected block.
- **Judgment part → Bookkeeper prompt** (new commands): what deserves a memory/spark/grudge/plant/note/thought, detecting that a skilled action needs dice.

Split per system:

| FF5 system | Code | Bookkeeper judgment |
|---|---|---|
| DnD Task Sim | DC locked by band (Easy 1-5 / Mod 5-10 / Hard 10-15 / Impossible 15-20), real d20, bond→DC modifiers (≥+4 →−1, ≥+8 →−2, ≥+15 →−4, ≤−3 →+2, ≤−5 →+4), Δ and outcome bands (crit ≥+8 or nat20 / success +0..+7 / near-miss −1..−3 / failure −4..−7 / crit-fail ≤−8 or nat1) | `task(actor, action, easy\|mod\|hard\|impossible)` — detecting that a skilled action with a real failure condition happened |
| Bonds | Sparks check every 5th turn (≥7 → BOND+1, reset; else decay −1 if no spark gained since last check), Grudge check every 3rd turn (≥5 → BOND−1, reset; else −1), −10..+20 clamp (DECIDED 2026-11-11: widened from −5 so the cold ladder gains three deep rungs). **Direct positive BOND raises are banned** — `bond(x,user,+n)` is auto-redirected to Sparks | `bond(cell, sparks|grudge, ±n)` for acts the scene shows; negative `bond(x,user,−n)` still direct |
| Internal Agenda | Off-screen ticking (+1/turn for NPCs not in `present`), completion detection, completion effects (rest→heal+clear grudge, reconcile→BOND+1, research→plant W1 seed), refresh to mundane agenda (1-3 steps) | `agenda_set` for the *new logical* agenda text on exit/re-entry |
| GM's Notebook | Max 20 entries, prune oldest | `note_add(R\|T\|D, text)` — what's worth logging |
| Chekhov's Gun | Age +1/turn (locked stay frozen), prune ≥12, max 20 active, fire gate age ≥ 4, threshold = base(W1 18/W2 13/W3 8) − age − proximity (spoke −2 / present −1, from last scene's appear roles), up to 5 d20 checks/turn, nat-20 fire grants −4 threshold to the rest, nat-1 jams, fired bullets surfaced to the narrator ("weave in now") | `plant(text, weight, secret)` — loading 1-2 new bullets when the story plants something; `chekhov(id, fired)` only for story-driven resolutions |
| Inventory/Feats/Titles | (modifier application happens inside the task roll) | `inv(cell, +item\|−item)`, `title(cell, +name\|−name)` |
| Internal Thoughts | (nothing) | `thought(cell, text)` — max 3 NPCs per turn |
| World Sim (BOTH tables) | d20 roll each turn, table selection (DuoTable when ≤2 named NPCs or zero off-screen, else StandardTable), band → event category stored in `world.worldsim` | none — narrator improvises the specifics from the injected category; the bookkeeper captures consequences (e.g. an ENTER_CHECK arrival → `presence on`) |

Anti-Omniscient NPCs is already implemented by witness filtering; Spectacle Combat stays a narrator prose rule in the prose-only preset (the `combat` fields hold its current state).

World Sim ruling (user, 2026-11-11): **both tables**, always available; if faithful Agenda ticking later proves rich enough, dropping StandardTable can be revisited. Toggle: `/cc-worldsim on|off|now` (default on; `now` rerolls immediately).

### Slices for the mechanics port
1. **Tick engine + new commands + enriched bookkeeper prompt** (this slice).
2. (DnD sim is part of slice 1 — `task` command + dice live in the same pass.)
3. Chekhov firing engine tuning after live testing (thresholds/proximity feel).
4. World Sim tuning (category flavor, whether StandardTable stays).

Success test for the port: a fight scene rolls real dice and reports Task/DC/Roll/Delta/Outcome without the narrator ever writing numbers; off-screen NPCs visibly progress agendas between scenes; a planted bullet fires organically within a few turns of its age gate opening.

### Old-chat conversion, round 2 (DECIDED 2026-11-11: Import button + seeded-mode backfill)

The 300-turn FF5 chats already contain their **final internal-states block** in the last AI message — exact current values written by FF5 itself. Re-inferring those with a model would be strictly worse than parsing them. The backfill (existing) is the right tool ONLY for what FF5 never stored: the per-turn, witness-tagged event ledger. So conversion becomes two deterministic-or-targeted steps, not one inference job:

**New CC TOOLS button: "Import state from internal states"** — deterministic HTML parse of the **most recent** `<internal_states>` block in the open chat's message history. No model call, no message modification, instant.

- Creates NPC cells automatically (fixes the backfill's "no cell creation" gap for FF5 chats).
- Seeds exact current values per section, lenient per-section regexes (parse what matches, skip what doesn't, never fail): BONDS → bonds/sparks/grudge; NPC AGENDAS → agenda goal/step/max/aware/fibs/circle/body(+location from NPC LOCATIONS); INV & SKILLS → user cell inventory/titles/status/mods; CHEKHOV → bullets with weight/age/status/depends/secret; GM'S NOTEBOOK → [R]/[T]/[D] notes; INTERNAL THOUGHTS → per-cell thoughts; DND TASK SIM / COMBAT / PHYSICS → world.roll/combat/env/physics.
- **(b) seeds the turn counter** from the block's `TURN: N` header.
- Imported NPCs start tier `minor`, UNPINNED — the backfill's appear history + auto-tier settles real tiers afterward.
- Reports per-section counts in a toast (imported X bonds, Y bullets, Z notes…; sections not found skipped).

**Backfill gains a SEEDED MODE** (runs automatically when the state was imported): ledger work ONLY — `memory_add`, `witness`, `appear` (→ tier log) and `turn` markers. All accumulating commands (bond/status/agenda/inv/title/note/plant) are stripped from the grammar AND filtered as belt-and-braces, so the imported final values are never double-counted. Relationship *moments* still land in the ledger as memories — only the numeric double-counting is avoided.

**Turn accounting fix (applies to all backfills):** the backfill currently stamps every event with the same `turn0`. Seeded mode instead keeps a LOCAL virtual turn counter starting at 0 and incremented by `turn()` — so old events get historical turns (hot-window/aging math stays correct) and the imported `world.turn` (e.g. 300) is not pushed further.

**Order of operations for an old FF5 chat (documented in the button notes):**
1. Open the OLD chat → **Import** (seeds cells + exact values + turn counter into its state).
2. **Clean copy** — CHANGED: when the chat already has cell state, the copy CARRIES it over instead of resetting to fresh (otherwise the import would be lost — the HTML is stripped from the copy's text, so import must run before cleaning).
3. **Backfill** — runs in seeded mode (ledger only, local turn counter from 0).

Fresh chats (no FF5 blocks) are unaffected: no block found → Import reports "nothing to import", and a normal (non-seeded) backfill behaves as before — except it still cannot create cells, which remains acceptable there (users add NPCs as they appear in live play).

This flow is speculative-coded as slice 8; no coding started yet at time of writing.

### Relationship layer (DECIDED 2026-11-11: Pura's Relationship Tracker rules + card)

Source: `docs/PRESET-RECOMMENDATIONS.md` §4.1 — the behavioural rules of Pura's Relationship Tracker (from the full prompt text in `OpenAI Settings/Pura's Director Preset 16.0 (SillyTavern).json`), adopted onto cells. User picked: **rules + relationship card** and **heart/trust as two separate numbers**. Queued as slice 9, built only AFTER the hand-test round of slices 4–8 is confirmed.

**Schema — optional `rel` block per NPC cell** (auto-created minor cells may skip it; it describes the NPC's relationship toward the USER only — NPC↔NPC stays in the existing numeric `bonds`):

```json
"rel": {
  "stage": "Friendly",          // derived from BOND; tangled overrides possible
  "condition": "💛 SHIFTING",   // emotional weather — may shift while stage stays put
  "route": "🌱 Slow Burn",      // this pair's story genre; changes only on a true turn
  "trust": 4,                   // separate from BOND (heart). May disagree with it.
  "likes": [],                  // DISCOVERIES only — what the user saw win them over
  "dislikes": [],               // same rule; "still a mystery" while empty
  "keepsake": "m123",           // the landmark the NPC replays most (ledger id)
  "threshold": "a shared meal in silence",  // the named, concrete next gate
  "severed": false              // 💀 SEVERED: one final card, then retired
}
```

**Stage derives from BOND — no double bookkeeping.** Stage is a pure function of the existing BOND number, using the same band technique as `tiers.js`: warm ladder bands upward (Stranger → Noticed → Acquaintance → Familiar → Friendly → Close → Confidant → Intimate → Treasured → Devoted), cold ladder bands at BOND ≤ 0 (Wary → Guarded → Resentful → Hostile → Bitter → Vengeful → Archenemy → Nemesis). Bands: BOND −10..≤−10 Nemesis, −9..−8 Archenemy, −7..−6 Vengeful, −5 Bitter, −4 Hostile, −3 Resentful, −2 Guarded, −1 Wary; 0 Stranger, 1 Noticed, 2-3 Acquaintance, 4-5 Familiar, 6-8 Friendly, 9-11 Close, 12-14 Confidant, 15-16 Intimate, 17-18 Treasured, 19-20 Devoted. (DECIDED 2026-11-11, user pick: Treasured added on the warm side, the full four-rung cold extension adopted — Nemesis stays the absolute bottom, reserved for the truly absolute enemy; the origin call can land a demon king at Archenemy −6..−9.) Exact band edges are a build-time tuning matter. Because BOND only moves via Sparks checks (every 5th turn) and Grudge checks (every 3rd), the stage automatically obeys Pura's core rules: **most scenes move nothing**, and it can only move one rung at a time, and only when the ticks earned it — the discipline is enforced by the machine, not the prompt. Tangled stages (Complicated | Codependent | Estranged | Rivals | Frenemies | Unrequited | Forbidden) are the one judgment exception: the bookkeeper may PIN a tangled stage (like a tier pin); the pin releases when BOND crosses a band boundary.

**Trust is judgment-only.** Heart = existing BOND (Sparks/Grudge ticks, never rises directly — unchanged). Trust = new number, moved ONLY by the bookkeeper (`trust(cell, ±n)`) when the scene shows trustworthy or betraying conduct; no automatic tick. Clamp −5..+20 (unchanged even though the BOND floor widened to −10 — trust keeps its own tighter range). Sola's principle applies as prompt guidance: "trust returns by evidence across the next scenes, not one conversation." Heart ≠ trust is what makes longing/obsession (high heart, low trust) and quiet respect (low heart, solid trust) expressible as distinct states — the card renders the disagreement on purpose.

**Route emoji palette (DECIDED 2026-11-11: palette emoji + free name).** Pura's "invent a fitting route when none suit" is kept as free-text route NAMES (1–4 words, sanitized); only the emoji is constrained, to a generous curated palette (user ruled 12 + spares is too few) so a fitting signifier almost always exists:

- Warm & bloom: 🌱 🌸 💐 🌹 🕊️ 🪶 🧸 🏠
- Fated & patient: 🔮 🧵 🧲 🌙 ✨ ⏳ 🌅 🕰️
- Conflict & edge: ⚔️ 🔥 🗡️ 🩸 ⛓️ 🏹 ⚡ 🕸️
- Dark & tragic: 🕯️ 🥀 🌑 🕳️ 💀 🪞 🧨 🚪
- Cold & apart: ❄️ 🧊 🌊 🌫️ 🐦 🌉 🎭 🎲
- Roles & bonds: 🤝 🫂 🛡️ 🎓 🐉 🩹 💍 👑
- Odd flavours: 🎶 🧪 🍂 🍯 🗝️ 🐍 🌘 ⚓

The palette lives as a constant in the extension code and is echoed in the bookkeeper prompt (pick a fitting palette emoji; invent the name). An off-palette emoji is not rejected: the route is stored with a generic ❔ emoji and the name kept, surfaced for hand-editing. Route still changes only on a true turn of the story.

**Bookkeeper rules (Pura's, adapted, in P7 style — instruction + one-line reminder + audit line):**
- Bond/spark/grudge ops only on a moment the scene names as earned; most turns emit NO rel ops at all (silence is the default state).
- Relationships stall, cool and slide backwards: neglect, broken promises and small slights cost (negative ops stay direct).
- Likes/dislikes are append-only discoveries: record only when the scene shows the user learning it, ≤1 entry per list per scene.
- Keepsake replaced only when a new moment clearly outshines the old one.
- Threshold must be a concrete moment (a confession, a rescue, a kept secret, a shared meal in silence), never a vague feeling; rewrite it when the stage moves.
- Condition may change while the stage stays put. Route changes only when the story truly turns.
- `severed` ends the relationship: one final card, then no further rel updates.
- New shared-grammar ops: `trust(cell, ±n)` and `rel(cell, field, value)` for condition/route/likes/dislikes/keepsake/threshold/severed. Code belt-and-braces: cap rel field changes per cell per turn (≤1 likes entry, ≤1 dislikes entry, one condition/route/threshold write max).

**Drift is computed, not stored.** The card's drift label (💗 HEART EVENT when stage rises, 🥀 FALLING OUT when it drops, 🌫️ HOLDING otherwise) is derived at render time from what changed this turn.

**Panel — the route card.** Each NPC cell gains a Pura-style relationship card (app-rendered from JSON, so Pura's regex-fragility/format-law problem does not exist here): route emoji+name, ladder path with the current rung highlighted, condition chip, heart vs trust shown side by side, likes/dislikes lists, the keepsake line, the named threshold, and the drift label. Fully hand-editable like every other cell field. The old numeric BONDS section stays for all bond pairs.

**Old chats:** FF5 internal-states blocks carry no rel data — imported/backfilled chats start with derived stage from the imported BOND and everything else "still a mystery"; the layer fills in during live play. No special import work.

**Starting values for pre-existing relationships (DECIDED 2026-11-11: origin call at creation).** A fresh cell defaults to BOND 0 → Stranger, which is wrong for a maid who raised the user or a sworn arch-enemy. The fix runs at cell-CREATION time (not per turn):

- **Trigger:** every NEW NPC cell creation — bookkeeper `char_add`, `/cc-add`, and the panel's "＋" button. NOT on import (FF5 chats already carry exact BOND values) and never retroactively for existing cells.
- **One cheap one-off call** (through `llm.js` cheapCall, the same Connection Manager profile as the bookkeeper) reads: the character's CARD (description/personality/scenario/first message — fuzzy name match, the import's matcher), the SCENE that introduced them, and the current state summary. It emits the starting block: `bonds.user`, `trust`, `route`, `condition` (optionally a first `threshold`).
- **This is the ONLY place the card is ever read.** The per-turn bookkeeper stays strictly scene-only; card lore enters the state once, at birth, as plain numbers/labels like any other state.
- **No soft caps (CORRECTED 2026-11-11, user review):** the origin call sets BOND anywhere the engine allows (−10..+20; trust keeps its own −5..+20), judged from the card + establishing scene — a 5-year girlfriend legitimately enters at Intimate/Treasured with high trust, a demon-king arch-enemy around Vengeful/Archenemy (−6..−9). Pura's ladder discipline protects PER-SCENE movement (one rung per earned moment), not starting position; a pre-existing deep relationship starts where it already is. (The earlier ±8 / 0..+4 cap draft was rejected: it forced a 5-year girlfriend to read as "Friendly".)
- **Likes/dislikes/threshold MAY be seeded** when the card establishes them (1–3 entries) — a pre-existing relationship carries already-discovered knowledge ("you'd know her coffee order after five years"). Discovery-gating still governs everything learned DURING play, and the keepsake stays empty until a moment earns it on screen.
- **Never fatal, never blocking:** it runs after the reply (not pre-generation), a failed or empty call just means the cell starts at 0 as today. Route/condition reuse the same ❔ normalization. Values land via the same `ensureRel` machinery and show up in the panel for hand-fixing, like everything else.

**Success test:** in live play, an NPC the user was friendly to twice does NOT jump stages; a betrayal visibly drops trust faster than heart; a card's threshold names a concrete scene moment and the next stage move happens at (or near) that moment.
