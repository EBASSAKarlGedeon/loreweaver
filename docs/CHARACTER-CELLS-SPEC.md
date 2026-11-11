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
- Which cheap model to default the bookkeeper to.
- ~~How tier auto-detection weighs on-screen vs spoke vs acted~~ — DECIDED 2026-11-11: the bookkeeper emits `appear(<cellId>, spoke|acted|present)` for every participant each scene; a rolling 30-scene score (spoke=3, acted=2, present=1) maps to tier bands (≥18 main, ≥9 secondary, ≥3 minor, below → offstage), and ≥6 consecutive absent scenes force offstage. Hysteresis: a tier changes only after 2 consecutive turns agree. Manual override (/cc-promote, /cc-demote, panel dropdown) PINS the cell — auto stops touching it until /cc-autotier <name> releases the pin.
- ~~What happens to fired/pruned agenda bullets (the "Chekhov" lists) — probably become memories with importance decay.~~ — fired plants already land in the ledger via the bookkeeper's memory_add; under the landmark+digest memory scheme they age into digests unless tagged imp-3.

### Memory scheme (DECIDED 2026-11-11: Option C — "digests + landmarks")

The event ledger is **immutable** — nothing ever edits, merges or deletes an event. Only the injected view ages:

- **LANDMARKS**: importance-3 events injected verbatim forever (witness-filtered, cap 10). A turn-300 plot-critical event still reaches a turn-1000 generation.
- **Recent ring**: newest 12 witnessed events verbatim (~last 40 turns).
- **Digest**: everything older and non-landmark, summarized into one paragraph per cell by a cheap isolated call, cached per cell, rebuilt only when the cold set changes. `/cc-digest` forces a rebuild; a bad digest loses nothing.

Old FF5 chats convert via the panel's CC TOOLS: **Clean copy** (new chat file, all internal-states HTML stripped, original untouched) → **Backfill** (ledger rebuilt from turn 0 in 4-message batches, one cheap call each, cancelable/resumable, seeds tier detection from the full history). Fully automatic — no approval gates.
