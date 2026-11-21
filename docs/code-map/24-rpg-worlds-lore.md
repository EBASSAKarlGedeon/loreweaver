# 24 — RPG Engine: Worlds & Lore (Code Map)

> The authoring surface: world creation, the World Editor, lorebooks, imports.
> Engine app lives at `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/`
> (its own git repo — patch log in `PATCHES.md` at its root; app source in `app/src/scripts/`).
> Paths below are from the Loreweaver repo root. Line refs approximate, written 2026-11-24.
> Companion deep-dive docs: `docs/RPG-ENGINE-PORT.md` (design), `docs/RPG-ENGINE-HANDOFF.md` (state/patches).

## Purpose & user-facing surface

- Landing page → **Worlds**: library grid (cover, tags, NSFW toggle, search), ＋ Create World
  (template picker / Craft with AI / duplicate), Import World, Import from Loreweaver.
- **World Editor**: everything an author edits about a world — cover, description, scenario,
  narrative vibe, lorebook, stats, trackers, NPC roster (+NPC trackers), world JSON import/export.
  AI "Generate" run buttons per tab.
- **Forge Your Hero** wizard (in game core, map 22) consumes this data at Begin.

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `app/src/scripts/world-editor.js` | 4521 | The World Editor modal: `openWorldEditor(fileForm, opts)` (~997) — tabbed editor (Details/Lore/Stats/Trackers/NPCs/NPC Trackers/JSON), cover studio (`openCoverStudio` ~202), all run buttons |
| `app/src/scripts/world-craft.js` | 874 | World creation: template picker, Craft with AI pipeline, duplicates. State injected via `initWorldCraft(deps)` (~23) |
| `app/src/scripts/lorebook.js` | 538 | The structured lorebook model + relevance selection (pure functions, no DOM) |
| `app/src/scripts/world-folders.js` | 362 | World library folders/collections UI |
| `app/src/scripts/loreweaver-import.js` | 793 | [patch 018] "Import from Loreweaver" — full page ported from the old floating `loreweaver-import.html` overlay; walks the Loreweaver server's characters/chats/worlds and mirrors writes through loreweaver-storage |
| `app/src/scripts/scenario-import.js` + `scenario-import-panel.js` | 430/409 | Scenario import flow + its landing panel (deps injected via `initScenarioImport`) |
| `app/src/scripts/def-presets.js` | 56 | Small definition presets for editor tabs |
| `app/src/scripts/index.js` (extension) | — | `public/scripts/extensions/rpg-engine/index.js` — mounts the app iframe + bridge into Loreweaver |

## Key functions

World Editor (`world-editor.js`):

- `openWorldEditor(fileForm, opts)` — ~997 — builds the editor for one world; `opts` selects entry tab.
- `runDefAi(kind, rawText, statusEl)` — bound at ~3156 (stats), ~3275 (trackers), ~3559 (NPC trackers) — AI generates definition text from the tab's instruction box; `keepRaw` preserves formulas; fallback parser accepts imperfect AI JSON.
- `runNpcAi(rawText, statusEl)` — ~3921 — generates an NPC (route "other"): world canon + lorebook + banned-names list, strict JSON; name-vs-request veto logic noted at ~3906.
- `genNpcAvatar(i, btn)` — via `.ce-av-gen` (~3721/3837) — avatar portrait from appearance + persona; requires an image provider (disabled button otherwise).
- `setBusy`/`clearBusy` — ~40/47 — shared busy-button pattern for every Generate run.

World craft (`world-craft.js`):

- `craftWorldWithAI(desc, onStage)` — ~632 — staged pipeline: spine → stats → trackers → lore (chunked `craftLoreTask` ~201) → NPC trackers → cast; each stage is an AI call parsed from markdown/JSON (`extractAiValue` ~404, `closeTruncatedJson` ~382 rescues cut-off replies).
- `duplicateWorld(fileForm)` — ~47; `newWorld()` — ~824; `showTemplatePicker()` — ~699.
- `coerceWorldFile(raw)` — ~250 — normalizes arbitrary JSON into the world file shape.

Lorebook (`lorebook.js` — pure model):

- `normalizeLorebook/normalizeLoreEntry` — ~106/~78 — entry shape: `{type, title, keywords, text, activation}`; activation `"always"` feeds every GM turn, `"keywords"` needs a hit.
- `keywordHits` / `nameHit` / `distinctiveNameTokens` — ~120/~140/~170 — matching with a veto so a longer distinctive name suppresses a shorter token-subset hit.
- `resolveNpcName(raw, candidates)` — ~243 — fuzzy NPC name resolution against the cast.
- `lorebookToText(entries, {types, capChars, activation})` — ~308 — renders the block the GM prompt eats (used by AI plumbing, map 23, and by editor/run buttons).

## Data structures & persistence

- World file (`worlds/<id>` in engine KV, map 21): `{id, name, cover, tags, description,
  scenario, narrativeVibe, lorebook: [entries], stats: <parseStatsConfig text>, trackers: <text>,
  npcs: [...], npcTrackers: <text>, nsfw, author, createdAt/updatedAt}`.
- World index: `worlds/index` (list of cards for the library grid).
- Editor changes stay UNSAVED in the modal until Save — the AI run buttons write into the
  editor's fields, not the store (user hand-tests showed this trips people up).

## Interactions

- Engine storage (map 21) persists everything via KV (`worlds/…`).
- Game core (map 22) reads the world at Begin/turn time; lorebook feeds GM prompts via map 23.
- Loreweaver server: `loreweaver-import.js` mirrors via the rpg-engine-kv endpoint (map 21).

## Gotchas

- Editor entries are lost if the modal closes without Save — deliberate (draft discipline), documented in FAQ.
- `runNpcAi` refuses names already used (banned list incl. existing NPCs + hero).
- Craft-with-AI makes MANY provider calls per world (staged) — on slow/local providers expect minutes.
- The lorebook veto (`extraHasVeto` ~196) means a short keyword list can hide a longer name's entry — check `resolveNpcName` before blaming retrieval.
- The engine repo is its own git repo — commit there, then `git pull` in the AppData deployed copy before testing (deploy gotcha, repeatedly hit).
