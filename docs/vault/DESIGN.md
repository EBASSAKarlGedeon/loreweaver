# Weaver's Vault — Design Spec

> Character Library extension for Loreweaver. Status: DESIGN AGREED 2026-11-24 (grilling session,
> 14 decisions). No code written yet. Attribution: source-adapter logic ported from **Glaze**
> (AGPL-3.0, github.com/hydall/Glaze) — surveys in `glaze-sources-survey.md` / `glaze-ui-survey.md`;
> DataCat fallback path studies `datacat-sillytavern-browser` (DataCat's own extension, AGPL-3.0).

## What it is

A pure drawer extension (top-bar, like other Loreweaver extensions; **zero core edits**) that
browses character-sharing sites, previews cards, and one-click imports into Loreweaver's NATIVE
systems (characters list, worldbooks). No duplicate library DB. Name: **Weaver's Vault**.

## v1 sources (decided Q5/Q13)

| Source | v1 | Mechanism | Auth |
|---|---|---|---|
| chub.ai | YES | REST `api.chub.ai` (search/tags/detail), field remap to ST V2 | optional key (secrets) |
| DataCat | YES, lights up when key arrives | Official `api/client/v1` REST; device-flow token; hosted verification lease | client id (settings field) + user token |
| DataCat fallback | if client-id path fails | Embed `datacat.run` in sandboxed iframe + postMessage bridge (PREPARE/CARD → PNG → `/api/characters/import`), like the official extension | client-link (hosted) |
| Saucepan | YES | URL-driven extraction (`/api/v1/companion/definition`), decoy-fragment reassembly (FNV-1a proof, `key ^ mask` sort, 32-bit math → `Math.imul`) | paste-only bearer token (Q14) |
| JannyAI | search-only if it ports in ~1 day, else dropped | Meilisearch `search.jannyai.com` (plain HTTP, anonymous token scraped from JS bundle + hardcoded fallback); detail pages need CF-cleared browser → skip in v1 | none |
| JanitorAI | **v2** | Mandatory webview (CF binds clearance to TLS fingerprint). v2 plan: Electron webview in packaged app (Q6a) | Supabase cookies |

## Architecture (Q7/Q8)

- **Server module** `src/endpoints/weavers-vault.js` (name TBD in code): all Tier-A HTTP
  (Chrome UA spoofing per Glaze's `catalog_http` pattern, brief response caching, rate-limit
  politeness, secrets read server-side). Browser extension code stays thin: UI + calls.
- **Extension** `public/scripts/extensions/weavers-vault/`: manifest, drawer UI, adapter client,
  import pipeline calling existing native import endpoints (reuse `content-manager.js` chub
  download helpers where they overlap).
- **Secrets**: ST secret store, per-device, NOT synced (chub key, datacat token, saucepan token).
- **Settings/ledger**: extension settings → auto-synced to phone via Phase 2 (NSFW toggle,
  filters, favorites, import ledger, open-after-import).

## UI (Q2/Q9/Q10, Loreweaver-native, steal Glaze mechanics)

- Drawer: search box (400 ms debounce), source picker chip, filter button with applicable-only
  badge, active-filter chips row, sort chip, NSFW toggle (own, default SFW, Q7-of-round-1),
  result grid (2:3 posters, tag chips, token/message badges, NSFW blur + reveal), infinite
  scroll, "End of results", result count hidden when source reports no total.
- **Search-epoch guard**: any filter/sort/source/query change bumps epoch; stale responses dropped.
- Detail popup (Vault-native, not core reuse): bio, creator note, tags, stats, prompt blocks,
  alternate greetings, embedded/attached lorebook inventory, sample messages, "open on source
  site" link, creator link.
- Paste-URL import (Saucepan/DataCat) with phase-labeled progress; "finished empty" ≠ timeout.
- Per-source persisted filter profiles.

## Import (Q3/Q11/Q12 + Q4)

- Modes (sheet shown when lorebook exists): **Character only / Character + lorebooks /
  Lorebooks only**. Lorebook failure NEVER blocks character import.
- Extras (all): a) all greetings imported, b) avatar images (bytes ride along when
  credential-bound), c) tags into Loreweaver tag system, d) import history + source link,
  e) batch import queue (background downloads) — *beyond Glaze*.
- Provenance: source URL stamped in character `extensions`; toast; setting "open after import"
  (default on).
- **Import ledger** (Q4): every import recorded (name, source, source id, date) in synced
  settings; duplicate warning before re-import; update-check later.
- Party-labeled errors (source / provider / Vault) with actionable escapes.

## Milestones (proposal, small focused commits)

1. **M1 — server module + chub**: `src/endpoints/weavers-vault.js` (UA spoof, cache, secrets),
   chub search/tags/detail port; curl tests.
2. **M2 — extension skeleton + browse UI**: manifest, drawer, chub search grid, filters, epoch
   guard, NSFW toggle. Screenshot-verified (rpge-heavy convention).
3. **M3 — detail popup + chub import**: preview, ST V2 assembly, native import (card PNG/JSON +
   embedded book), provenance, ledger, open-after-import.
4. **M4 — Saucepan**: paste-URL extraction + fragment reassembly port + URL import dialog.
5. **M5 — DataCat**: adapter behind settings key (device flow + verification lease); fallback
   iframe-bridge mode if the client-id path fails.
6. **M6 — extras**: batch queue, favorites, JannyAI-search decision (1-day timebox), polish.
7. **v2 (separate effort)**: JanitorAI + Janny-detail via Electron webview.

## Attribution & legal

- ATTRIBUTION note in extension README: ported from Glaze (AGPL-3.0); DataCat fallback informed
  by datacat-sillytavern-browser (AGPL-3.0). License headers preserved where code is translated.
- AGPL → AGPL is compatible; Loreweaver stays AGPL.
