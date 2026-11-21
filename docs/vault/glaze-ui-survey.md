# Weaver's Vault — Glaze survey (catalog UI, data model, import pipeline)

> Survey of `C:/Users/Gedeon/Documents/Coding/Glaze-stable` `lib/features/catalog/` UI/model/import
> layer (Dart/Flutter, AGPL-3.0). Produced by a research agent 2026-11-24. Companion to
> `glaze-sources-survey.md`.

## Data model (`catalog_models.dart`)

- **`CatalogItem`** (grid row): id, name, avatarUrl, description (raw HTML, stripped for display),
  tags, tokens, chatCount, messageCount (mail-icon badge), creator, creatorId, nsfw, nsfl (Chub
  only; blurred like NSFW), slug, source, fullPath, creatorRef (per-source creator addressing;
  Saucepan refs carry a `saucepan:` prefix), sourceKind (ids only unique per source).
- **`CatalogFilters`**: sort, nsfw, nsfl, tagIds/tagNames/excludeTagNames, minTokens (29)/maxTokens
  (100000), ~11 Chub-only flags mapped 1:1 to chub `/search` params (requireImages/requireLore/
  requireCustomPrompt/requireExampleDialogues/requireAlternateGreetings/recommendedVerified/
  excludeMine/inclusiveOr/minAiRating/minTags/nsfwOnly), window (all/week/24h — DataCat only).
- **`CatalogTag`** (id/name/slug), **`CatalogSearchResult`** (items + total + hasMore +
  `nextOffset` server cursor — DataCat filters *after* paging).
- **`CatalogImportMode`**: character / lorebooks / characterAndLorebooks — separate jobs by design.
- **`DownloadedCharacter`/`CharacterData`**: full V1/V2 card fields (name, description,
  personality, scenario, firstMes, mesExample, creatorNotes, systemPrompt,
  postHistoryInstructions, alternateGreetings[], tags, creator, characterBook) + avatarUrl and
  avatarBytes (credential-bound images ride along, never re-fetched).
- **`CatalogComment`**: normalized reviews/kudos+comments (content, author, avatar, likeCount,
  replyCount, isPinned, isVerified, hasPlus, createdAt).

## UI flow

- **Placement**: a **"Discover" tab inside the character-list screen** (tab 0 My Characters,
  tab 1 Discover), sharing the search bar (400 ms debounce). All providers disabled → tab
  collapses. Folder view replaces the tab bar.
- **Browse grid**: controls row → active-filter chips row → (Janitor) inline Cloudflare challenge
  WebView (72% height) → error / session-expired states → result count (hidden when the provider
  reports no total) → infinite grid (loadMore at 600 px from end) → "End of results".
  One-time onboarding sheet (welcome → sources intro → provider toggles).
- **Controls**: provider chip w/ logo + gear jump to providers screen; filter button with
  active-count badge (only counts filters that provider can apply); sort chip; DataCat gets one
  combined sort+window chip. **Per-provider filter profiles persist independently**
  (`gz_catalog_filters_<provider>`) with legacy fallback + sort-key migration.
- **Cards**: 2:3 poster, bottom fade, message-count badge, hover lift/press scale, first-letter
  placeholder, NSFW blur with per-view reveal override, HTML-stripped 3-line description, tag
  chips, "12.3k tokens" formatting. Grid picks columns from width (extent/212, clamp 1–10),
  row-aligned (deliberate: rows over masonry).
- **Detail = the owned-character screen in preview mode**: bottom sheet, tabs — Info (bio +
  creator note + comments folded under), Prompt Blocks (system prompt/description/personality/
  scenario/examples/alternate greetings, lorebooks folded under), Images (gallery). Janitor
  previews add a read-only Lorebooks inventory tab; download actions live ONLY in the import
  flow ("a lorebook is only ever pulled as part of an import the user asked for"). Closed
  Janitor definitions show a display-only hint, never written on import. Import FAB opens an
  options sheet when lorebooks exist: Character + lorebooks / Character only / Lorebooks only.
  Three-dots menu: open on source site; blur-reveal toggle. Creator name taps through to a
  **creator screen** (profile header: avatar, about, verified badge, counts, paged character feed).
- **Accounts per source** (separate providers): Janitor = WebView login sheet, session-expiry is
  a dedicated inline state that resumes the interrupted import after re-login; Chub = API key
  entry (+ account-level nsfl opt-in re-searching live); DataCat = device-link flow with three
  states (unlinked/linked_anonymous/logged_in); Saucepan = bearer token.
- **Providers screen**: 5 providers, toggle on/off (Janitor default on; Saucepan always on);
  catalog falls back to first enabled provider.
- **Paste-URL import dialog**: Saucepan/DataCat extraction with phase text + error block.
- No queue/batch import, no favorites/history in Glaze at all.

## Import pipeline

1. **Fetch at detail-open, not import**. Janitor decision tree: read metadata via headless
   webview proxy → public definition → card; restricted-but-not-logged-in → try **DataCat's
   scraped copy** (extraction submitted + polled; "finished empty" is a distinct conclusion); or
   `_JanitorLoginRequired` state with inline re-login. DataCat needs a **human-verification
   lease obtained BEFORE import** (one lease ≈ 20 characters). Closed + Local → local capture:
   hijack the proxy to assemble the prompt, then **LLM lorebook rebuild** via the user's provider.
2. **Persist**: fresh timestamp id (no dedupe — re-import = duplicate); tags/greetings
   JSON-encoded; token estimate; `extensions: {catalogUrl}` provenance; own variantGroupId.
3. **Avatar**: carried bytes saved directly; else fetched from avatarUrl; failure swallowed.
4. **Lorebooks**: embedded `characterBook` → scoped to the character; attached books saved only
   from the dedicated capture sheet (nothing lands twice); a lorebook failure never blocks the
   character import; reuses the in-flight extraction.
5. **Error taxonomy by party** — JANITOR / PROVIDER / GLAZE (different fixes: "log in again" vs
   "check connection"); refusal sheets with "import the public part anyway" escape hatch;
   Janitor policy refusal pre-checked at Import tap.
6. **Post-import**: toast; route to the new character (setting, default on) or stay browsing.

## Top mechanics worth porting

1. Preview-before-import reusing the owned-character detail screen.
2. Import-mode options sheet, only when lorebooks exist; lorebooks never block character import.
3. Per-provider persisted filter profiles + applicable-only filter badge + chips row.
4. Search-epoch/request-ownership pattern (stale responses discarded on any reset).
5. Phase-labeled loading; "finished empty" ≠ timeout; no false "0 results".
6. Party-labeled errors + refusal escape hatches; inline re-login that resumes the action.
7. Creator pages from detail; "open on source site" fallback.
8. Import provenance (`extensions.catalogUrl`) + auto-open-after-import setting.
