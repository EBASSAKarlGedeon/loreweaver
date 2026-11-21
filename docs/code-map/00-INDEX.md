# Loreweaver Code Map — Index

> Per-area maps of the whole codebase: what each surface does, which files implement it,
> key functions with approximate line refs (`file:~line`, written 2026-11-24 — refs drift,
> names don't), data structures, cross-links, and gotchas.
>
> Companion docs (deep dives, kept outside this map):
> `docs/SYNC-SPEC.md` (offline sync design), `docs/RPG-ENGINE-PORT.md` + `docs/RPG-ENGINE-HANDOFF.md`
> (RPG engine design + patch log), `docs/PATCHES.md` inside the engine repo, `docs/FAQ.md`,
> `docs/PACKAGING.md`.

## Loreweaver core (the SillyTavern fork)

| Doc | Area |
|---|---|
| [10-server-core.md](10-server-core.md) | Server bootstrap & core: `server.js`, `src/server-*.js`, middleware, config, plugin loader |
| [11-server-endpoints.md](11-server-endpoints.md) | All `src/endpoints/*` modules — grouped routes (backends, content, config, media, misc) |
| [12-frontend-core.md](12-frontend-core.md) | `public/index.html` + `public/script.js` — chat UI controller, boot, events, chat/char management |
| [13-generation-pipeline.md](13-generation-pipeline.md) | `openai.js` & prompt assembly, world info, macros, filters, instruct/CFG, tokenizers |
| [14-extensions-subsystem.md](14-extensions-subsystem.md) | Extension loading + the built-in extensions (caption, vectors, TTS, SD, …) |
| [15-sync-system.md](15-sync-system.md) | Offline-capable two-way sync: `src/sync/*`, endpoints, token CLI (spec: SYNC-SPEC.md) |

## RPG engine (nested repo: `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/`)

| Doc | Area |
|---|---|
| [20-rpg-shell-landing.md](20-rpg-shell-landing.md) | App shell, landing page, view routing, nav chrome, popups/notify, update/community |
| [21-rpg-storage-bridge.md](21-rpg-storage-bridge.md) | KV persistence (browser + `rpg-engine-kv` endpoint), Loreweaver bridge, backup, search infra |
| [22-rpg-game-core.md](22-rpg-game-core.md) | `main.js` (14k lines): state model, views, the turn loop, GM pipeline, hero wizard, saves |
| [23-rpg-ai-plumbing.md](23-rpg-ai-plumbing.md) | AI provider routing, prompt assembly (canon/lorebook/actions/memory/budget), reply parsing |
| [24-rpg-worlds-lore.md](24-rpg-worlds-lore.md) | World Editor, world craft, lorebook model, Import from Loreweaver, scenario import |
| [25-rpg-systems.md](25-rpg-systems.md) | Stats, trackers, actions (incl. auto-invoke), NPCs, maps, scene images, dice |

## Conventions

- Paths are relative to the Loreweaver repo root. The RPG engine is its own git repo nested
  under `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/` — its internal paths
  are still given from the Loreweaver root, with the repo boundary noted.
- Line refs were accurate at writing time (engine `main` @ a48b04c, Loreweaver `release`).
  Trust function/file names over line numbers.
- Each doc ends with **Gotchas** — read those before touching the area.
