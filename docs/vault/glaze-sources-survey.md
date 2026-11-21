# Weaver's Vault — Glaze source survey (sources & portability)

> Survey of `C:/Users/Gedeon/Documents/Coding/Glaze-stable` `lib/features/catalog/` provider layer
> (Dart/Flutter, AGPL-3.0). Produced by a research agent 2026-11-24. Feeds the Vault design tree.

## Shared infrastructure

- **`catalog_http.dart`** — single Dio client shared by all providers; every request carries a
  spoofed Chrome/136 User-Agent (dart:io's `Dart/x` UA gets 403 from CF-fronted hosts).
- **`cf_challenge_service.dart`** — janitorai.com-only Cloudflare coordinator: on 403 shows an
  interactive WebView to solve Turnstile, captures `cf_clearance` (cached 20 h) + persisted UA.

## 1. Chub (chub.ai)

- Transport: unofficial REST `https://api.chub.ai` — `GET /search` (query, page, sort modes:
  popular/trending week/24h/latest/rating/updated + timeline, topics/excludetopics, NSFW/NSFL,
  token bounds, quality flags), `POST /tags` (official tag index), `GET /api/characters/{path}?full=true`
  (detail), `GET /api/timeline/v1`, `GET /api/users/{username}`. Fakes Origin/Referer headers.
- Auth: none needed to browse; optional account API key (from site localStorage `URQL_TOKEN`/
  `USERNAME`) as `CH-API-KEY` header — only unlocks NSFL/personalized timeline.
- CF: none for data (webview only for login); can also just paste a key.
- Download: JSON metadata; field remap (`personality` = card body, `tavern_personality` = V2
  personality, `description` = storefront tagline → creatorNotes); embedded lorebook passes
  through as `characterBook`; ST V2 JSON assembled app-side.
- **Portable-to-JS: LOW** (plain HTTP + JSON mapping).

## 2. JanitorAI (janitorai.com)

- Transport: unofficial `/hampter/*` API, but ALL requests run inside an offscreen persistent
  InAppWebView (`JanitorWebViewProxy`, ~2k lines) calling the page's own `fetch()` with
  `credentials: "include"`. Endpoints: `/hampter/characters` (feed/search), `/hampter/characters/{id}`
  (detail, `showdefinition=true` gives real fields), `/hampter/tags`, `/hampter/tags/suggest`,
  `/hampter/reviews/{id}`, `/hampter/profiles/*`, `/hampter/script/{id}` (public lorebooks),
  `/hampter/api-settings(+proxy-configs)`, `/hampter/chats*`.
- Auth: Supabase JWT in cookies (`sb-<ref>-auth-token` chunks, `base64-` prefix); page's own
  Supabase client refreshes tokens; Glaze only reads the JWT via injected JS for expiry checks.
- CF: **mandatory** — `cf_clearance` is bound to the TLS/JA3 fingerprint, so cookies can't be
  replayed by a plain HTTP client; in-page fetch keeps fingerprint + cookie jar together.
- Search: query, ~34/page, `mode=sfw|all` (the NSFW toggle), sort trending24/latest, curated
  tags by numeric id, `custom_tags[]`, creator pages via `user_id[]`, profile search.
- Download: (a) public-definition path → ST card directly; (b) **closed-card capture flow** —
  installs a throwaway proxy preset (one-shot UUID client_id), creates a chat, sends `.` then
  trigger text in pieces under a lore budget, intercepts the `/generateAlpha` response (the
  assembled system prompt containing hidden card + lorebook entries), cleans up chats/persona/
  preset. `janitor_separate.dart` strips wrappers; `janitor_lorebook_rebuilder.dart` feeds lore
  text to the user's own LLM to rebuild keyed ST World-Info entries; `janitor_public_lorebook.dart`
  pulls `/hampter/script/{id}`; `greeting_normalizer.dart` dedupes greetings.
- **Portable-to-JS: HIGH** — session/separation/budget/rebuild logic is portable (low/med), but
  every data call needs a real browser fingerprint. Node proxy replay of cookies fails/fragile;
  viable port = drive a real browser (Playwright-style) or an Electron webview.

## 3. JannyAI (jannyai.com)

- Transport: split. Search = Meilisearch `https://search.jannyai.com/multi-search` (POST,
  `indexUid: janny-characters`, `x-meilisearch-client` header) over plain HTTP; anonymous bearer
  token scraped from the site's JS bundle (`client-config.*.js` → 64-hex regex), cached, with a
  hardcoded fallback. Character detail = HTML scraping of `https://jannyai.com/characters/{id}_{slug}`
  parsing Astro `astro-island props=` JSON (permissive hand-rolled parser).
- CF: search + image CDN unchallenged; site pages behind managed challenge → webview required
  for detail.
- Search: query, page, `isNsfw = false` clause mandatory, token/tag filter expressions, 4 sorts;
  graceful degradation (400 → retry without sort, then without filters).
- Download: HTML → Astro props → CharacterData (`personality` = definition body, `description`
  = blurb → creatorNotes, HTML-stripped). JSON only, no lorebooks.
- **Portable-to-JS: MED** — search trivial (low); detail fetch needs a CF-cleared browser (high).

## 4. DataCat (datacat.run)

- Transport: the ONLY official versioned API — `https://datacat.run/api/client/v1`:
  `/capabilities`, `/characters` (q, tagIds, blockedTagIds, sort, limit/offset), `/fresh`
  (trending windows), `/characters/{id}`, `/characters/{id}/card` (protected), `/characters/{id}/avatar`
  (protected bytes), `/tags`, `/creators/{ref}/bootstrap|/characters`, community kudos/comments,
  `/account-links(+token)` (OAuth-style device flow), `/verifications(+token)`, `/account/status`.
- Auth: public client id header `X-Datacat-Client-Id` (non-secret); optional user `dcv1_…`
  bearer via device flow (open hosted approval URL, poll, 409/428 = pending); short-lived
  transfer lease after a hosted Turnstile verification (~20 distinct characters budget).
- CF: none (the challenge is DataCat's own hosted page). **Designed for server-side use.**
- Download: protected transfer returns standard **Character Card V2 JSON** + avatar bytes.
- **Portable-to-JS: LOW** across the board.

## 5. Saucepan (saucepan.ai)

- Transport: unofficial plain REST — `POST /api/v1/auth/sign_in_password`,
  `GET /api/v1/companion/definition?companion_id=`, `GET /api/v2/companions/{id}`.
- Auth: bearer from password sign-in (or pasted token) + `x-saucepan-client-version: 1`.
- Search: NONE — URL-driven extraction only (`saucepan.ai/companion/<uuid>` regex).
- Download: definitions ship as **shuffled fragments padded with decoys**; `assembleFragments`
  validates each fragment's `proof` (FNV-1a hash of mask/key/text, 32-bit rotates), sorts
  survivors by `key ^ mask`, concatenates. Sections map to card fields (Companion Core →
  description, Example Dialogue → mesExample, `starting_scenarios_fragments` → greetings);
  closed definitions rejected.
- **Portable-to-JS: LOW** — deterministic 32-bit math maps 1:1 to JS (`>>> 0`, `Math.imul`).

## Summary

| Source | Transport | Auth | CF/webview | JS port difficulty |
|---|---|---|---|---|
| Chub | Unofficial REST api.chub.ai | Optional key (paste or site login) | No | **Low** |
| JanitorAI | Unofficial /hampter, all in-page fetch | Supabase JWT cookies | **Mandatory** | **High** |
| JannyAI | Meilisearch (search) + HTML (detail) | None (anonymous token) | Detail only | **Med** |
| DataCat | Official client v1 API | Public id + device-flow token + lease | No | **Low** |
| Saucepan | Unofficial REST, URL-driven | Password sign-in bearer | No | **Low** |

Porting mechanics for the webview-dependent layer: in-page `fetch()` with shared cookies
(Janitor/Janny), localStorage/cookie probing (Chub/Janitor), challenge escalation UI. A Node
server proxy can serve Chub, DataCat, Saucepan, Janny-search directly; Janitor (fully) and
Janny-detail need a real browser (Playwright-style) or an Electron webview.
