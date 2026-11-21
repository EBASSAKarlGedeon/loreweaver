# 20 — RPG Engine: Shell, Landing & Navigation (Code Map)

> ⚠️ **Nested repo boundary:** everything in `app/src/scripts/` below lives inside the RPG
> engine's own git repo at `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/`
> (patch log: `PATCHES.md` at that root; engine docs: `docs/RPG-ENGINE-PORT.md`). All paths in
> this doc are given from the **Loreweaver repo root** — e.g. "app-shell.js" means
> `public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/app/src/scripts/app-shell.js`.
> Paths relative to repo root. Line refs are approximate (`file:~line`). Written 2026-11-24.

## Purpose & user-facing surface

The engine's UI has exactly two top-level views, both mounted by `main.js` (14k lines — its game
logic is doc 22):

- **Landing** (home/menu view): a left nav rail (`#homeNav`, two-zone: primary pages + util
  cluster) plus a mount pane `#homeMain`. Pages: **Worlds**, **Adventures**, **Import from
  Loreweaver** (`#imports`, patch 018), **Explore**, hidden **User** profiles; **Tavern** and
  **Settings** are actions (popups), not pages. Footer shows fullscreen / Data-&-Backup /
  install-app buttons and a "Last edit | Views" colophon. A global `#updateBanner` sits above
  everything.
- **Session** (chat view): `#app` — collapsible left/right rail tabs (Menu / Session / Memories /
  Story | Hero / Map / NPCs / Gallery), topbar, trackerbar, transcript, composer.

Shared chrome that both views use: toasts (`notify`), themed popups (`popups.js`), the
Back-button overlay stack (`back-close.js`), URL/history routing (`nav-history.js`), responsive
breakpoints (`breakpoints.js`), rich-text/info-tip/tag-row/chip-input/color-picker widget kits.

Mounting into Loreweaver: `public/scripts/extensions/rpg-engine/index.js` adds an Extensions
settings panel (enable checkbox + **Launch / AI Bridge / Import** buttons) and dynamic-imports
the inner wrapper `rpg-engine-port/rpg-engine/index.js`. That wrapper injects its own `style.css`
(Loreweaver only links top-level extension CSS, not nested folders), adds the ⚔ floating launcher
and a wand-menu entry, preloads a same-origin iframe of `app/index.html` on idle, and exposes
`window.rpgEngine = { open(target), close, appUrl }` — `open("imports")` /
`open("settings/aimodel")` postMessage `{rpgeOpen:true, target}` deep links (the app re-enters
the landing from a chat first, session kept).

## Files overview

| File | ~Lines | Role |
|---|---|---|
| `app/index.html` + `boot.js` | 32 | `boot.js` is a classic script run at parse time: copies Perchance-plugin globals off `root` onto `window` (`genText`, `genImage`, `kv`, `uploadPlugin`, `createServerSocket`, `commentsPlugin`), captures `beforeinstallprompt` EARLY (`window.__mnoInstallEvent` — the platform re-dispatches it once and the shim drops repeats), fills the boot-splash title from `$meta` |
| `app/src/scripts/landing-shell.js` | 364 | Landing DOM (`#landing`, `#updateBanner`), boot-splash dismissal, nav chrome wiring, footer buttons |
| `app/src/scripts/app-shell.js` | 240 | Session DOM (`#app`, `#railScrim`), rail-tab descriptors, Tavern FAB, brand, mobile hints |
| `app/src/scripts/main.js` | 14115 | Drives both shells: `init()` ~490, `HOME_SECTIONS` ~1219, `setHomePage` ~1663, `renderLanding` ~1735 (game logic → doc 22) |
| `app/src/scripts/nav-history.js` | 221 | The ONE module for landing/session/profile history & hash routing |
| `app/src/scripts/back-close.js` | 119 | History-backed overlay stack: device Back closes the topmost overlay |
| `app/src/scripts/breakpoints.js` | 28 | Canonical width breakpoints + matchMedia helpers |
| `app/src/scripts/page-helpers.js` | 140 | Shared builders for the card-collection pages |
| `app/src/scripts/popups.js` | 174 | `TextPopup` / `ConfirmPopup` (no `prompt()/confirm()/alert()`) |
| `app/src/scripts/notify.js` | 67 | Toast, level-up toast, busy-button helpers |
| `app/src/scripts/search-bar.js` | 358 | The toolbar both card pages wear (search, filters, sort, NSFW switch) |
| `app/src/scripts/changelog.js` | 71 | Changelog popup parsing `src/CHANGELOG.md` |
| `app/src/scripts/update-check.js` | 52 | `#updateBanner` wiring + new-version polling |
| `app/src/scripts/announcements.js` | 250 | Dev-editable notice bars (`src/announcements.md`) on Worlds/Adventures/Explore |
| `app/src/scripts/view-count.js` | 38 | Landing footer view counter |
| `app/src/scripts/last-edit.js` | 37 | Landing footer "last edit X ago" line |
| `app/src/scripts/share-external.js` | 212 | ⋮ → Share (External): world `.gz` handoff to third-party libraries |
| `app/src/scripts/community.js` | 7463 | Community layer: Explore catalog, publishing, library (loaded on demand; deep dive in its own header comment + doc 22) |
| `app/src/scripts/discussion.js` | 8477 | Tavern: threaded community chat over a headless comments-plugin transport |
| `app/src/scripts/user-profile.js` | 235 | Public profile page `#user/<username>` (read-only; editing lives in Settings → Identity) |
| `app/src/scripts/server-bans.js` | 221 | Runtime ban-list cache (publish/comment gates) |
| `app/src/scripts/lightbox.js` | 341 | Fullscreen scene-image viewer with phone-gallery gestures |
| `app/src/scripts/info-tip.js` | 232 | Tap-friendly ⓘ tooltip (hover desktop / tap-pinned touch) |
| `app/src/scripts/chip-input.js` | 114 | Tag chip field (world tags, lorebook trigger words, Blocked tags) |
| `app/src/scripts/tag-row.js` | 190 | World tag chips + one-line fit pass (`…` overflow chip) |
| `app/src/scripts/color-picker.js` | 309 | Themed hex color field + popover swatch picker (tracker colors) |
| `app/src/scripts/icons.js` | 140 | Every SVG string in the app in one module |
| `app/src/scripts/rich-text.js` | 332 | One escape-first inline-MD renderer for transcript/descriptions/changelog |
| `app/src/scripts/text-utils.js` | 57 | `{{user}}` resolution + blank-detail/ellipsize helpers for prompts |
| wrapper `index.js` (engine root) | ~160 | SillyTavern glue: iframe overlay + launcher + `window.rpgEngine` |
| Loreweaver `index.js` (extension) | 90 | Extension settings panel + buttons that deep-link the app |

## Key functions

- `ensureLandingShell()` — landing-shell.js:~52 — idempotent creation of `#updateBanner` +
  `#landing` (nav frame, `#homeMain`, `#homeNavScrim`); markup is byte-identical to the old
  index.html so `styles.css` applies unchanged. Called by `main.js init()` ~492 before any view
  shows; `index.html` itself stays shell-free so a cold load never paints half-styled chrome.
- `dismissBootSplash()` — landing-shell.js:~78 — removes `#bootSplash` only after every
  stylesheet has loaded (polls `link.sheet`, 4s cap) + double-rAF, so the styled first frame
  paints underneath; called at the end of `renderLanding()`.
- `bindHomeNav()` / `applyHomeNavPref()` / `openHomeNav()` / `closeHomeNav()` /
  `applyRailTips()` — landing-shell.js:~154/257/208/217/247 — collapse toggle (persisted to
  `mno.homeNav`, drawer state never persisted), phone drawer (≤SHELL breakpoint) with scrim,
  focus trap and Escape, arrow-key nav walking, tooltips shown only while labels are hidden.
- `bindHnFootActions({ onBackup })` — landing-shell.js:~284 — fullscreen toggle, Data & Backup
  button (opens Settings → Backup via injected callback or `mno:open-settings` event), and the
  always-visible install button (uses boot.js's stashed `beforeinstallprompt`, else explains the
  browser menu route — the iframe never receives the event itself).
- `ensureAppShell()` — app-shell.js:~74 — idempotent `#app` + `#railScrim` creation (topbar,
  trackerbar, transcript, composer, both rails).
- `renderRailTabs()` / `RAIL_SECTIONS` / `VALID_SECS` — app-shell.js:~206/196/231 — rail tabs
  (left: menu, session, memory, settings; right: character, map, npc, gallery); retired
  `sessions` prefs fall through `validSec` to the default so updates never break a rail.
- `ensureTavernFab()` / `tavernFabEnabled()` / `setTavernFabEnabled()` — app-shell.js:~108/99/102
  — draggable floating Tavern button on `document.body` (survives landing↔session switches);
  position persisted per browser (`tavernFabPos`), on/off pref `tavernFabOn`; a moved press is a
  drag, never a click (capture-phase click swallow).
- `setAppBrand(title)` / `setLandingBrand(title)` — app-shell.js:~177 / landing-shell.js:~122 —
  fill brand text from the generator title (rename-safe, no hard-coded copy).
- `HOME_SECTIONS` / `HOME_MOUNTS` / `setHomePage(id, {force, push})` — main.js:~1219/1249/1663 —
  config-driven page routing: each entry has id/label/icon/zone/accent; sections with `opens`
  (Tavern, Settings) run an action and never become `homePage`. `setHomePage` pushes a landing
  history entry (unless mount-from-history), guards two racing callers with `homeMountSeq`,
  unmounts the previous page (saving its scroll offset into `homeUI`), syncs the hash (forced),
  builds the `.hm-bar` header (emblem via `secIconInner`, title, ⓘ subtitle, action slot), fires
  `maybeShowAnnouncement`, then calls the page's `mount(pane, ctx)`.
- `renderLanding(sessions)` — main.js:~1735 — hides `#app`, shows `#landing`, loads the session
  index + world index + community links (each read tolerant of storage failure), renders the
  nav, resolves the hash route BEFORE mounting (deep-link payloads survive), applies
  `#discussion` / `#settings/...` deep links, then `dismissBootSplash()`.
- `pushBackClose(close, opts)` — back-close.js:~78 — registers an overlay's close and pushes a
  history entry tagged with a unique token; returns `release()` (every programmatic close path
  MUST call it) with a `release.forget()` variant for entry handovers. `opts.adopt` reuses the
  entry a reload landed on; `opts.reuse` takes over the current overlay entry (panel→panel
  swaps); `opts.closeOnPop` lets URL-encoded views survive stray popstates.
- `onPop()` — back-close.js:~32 — popstate handler: honors `suppress` counter (self-initiated
  backs), ignores popstates that did not actually pop our entry, awaits `close()`, re-pushes the
  entry when close is declined (World Editor's "discard changes?" confirm), splices stale
  entries so the next Back can't misfire as a session return ("reload twice" bug).
- `syncHomeHash(id, target, {force})` / `homeRouteFromHash()` / `hashChangeTraversed()` /
  `pushLandingHistory(bridged)` / `pushSessionEntry` / `pushUserEntry` — nav-history.js:~91/113/
  131/148/160/166 — the only sanctioned way to touch the address bar: the platform (Perchance
  preview iframe, now also Loreweaver) mirrors `replaceState` to the host bar but not
  `location.hash =` or `pushState`, so the app writes hashes via push-then-replace, logs its own
  writes to detect stale platform echoes within 15 s (`noteHomeHash` / `isStaleHomeHashEcho`),
  and distinguishes real traversals (popstate within 250 ms) from bare echo fragment writes.
  Bridge-return guards (`shouldDeferToUserBridge` ~196, `shouldDeferToMenuBridge` ~204) make the
  hashchange router stand down while popstate re-enters the chat — without them Back from a
  chat double-mounts.
- `renderIncremental(scroller, ctn, builders, opts)` — page-helpers.js:~19 — chunked (24-item)
  list rendering with scroll+near-bottom or "Show more" fallback; deliberately a plain scroll
  listener (IntersectionObserver is unreliable in the preview iframe). Shared by Worlds and
  Adventures pages.
- `flipFilter(list, other, v)` / `emptyStateEl()` — page-helpers.js:~55/63 — three-valued filter
  toggle (require / exclude / neutral) and the page's "nothing here" block.
- `TextPopup.open(...)` / `ConfirmPopup` — popups.js:~33/174 — themed prompt/confirm replacements;
  `password:true` gives a masked single-line input; UTF-8 byte caps (`utf8ByteLen` ~16,
  `utf8ByteTrunc` ~19) with char-boundary-safe truncation; both Back-close via `pushBackClose`.
- `notify(msg)` / `notifyLevelUp` / `setBusy(btn)` — notify.js:~28/45/59 — fire-and-forget toast
  (created lazily on first use so it never animates on load), gold level-up celebration, spinner
  label swap for async buttons.
- `showNsfw()` / `setShowNsfw()` / `adoptStoredNsfw()` — search-bar.js:~38/45/55 — the ONE
  per-browser NSFW answer (localStorage `mno.showNsfw`, read synchronously at build time);
  every card page (Worlds, Explore, world picker) reads it, Tavern repaints on `mno:nsfw`.
- `initUpdateCheck()` — update-check.js:~1 — polls `/api/getGeneratorStats` for
  `lastEditTime` every 15 min + on focus/online/visible; a changed stamp is confirmed twice
  (double-read) before `#updateBanner` shows Reload / dismiss.
- `maybeShowAnnouncement(pageEl, pageId)` — announcements.js:~220 — fetches `src/announcements.md`
  once per load; `[pages: worlds]` scoping, inline-MD text where `[label](settings/aimodel)`,
  `[label](explore)`, `[label](changelog)`, `[label](tavern/<channel>)` are internal deep links;
  ✕ dismissals persist 24 h keyed by content hash (`mno.announce.dismissed`).
- `initViewCount()` / `initLastEdit()` — view-count.js:~28 / last-edit.js:~13 — fill the landing
  footer placeholders from `/api/getGeneratorStats` (compact `123.4k` counts / "x days ago").
- `openSharePanel(meta, loadFile)` — share-external.js:~116 — uploads a fresh gzip of the world
  file (short 1 h expiry for Unseen Scribe, which buys the bigger quota) and builds the partner
  handoff URL `perchance.org/unseen-scribe-library?data=<name>~<32hex>.gz&sourceTool=mnoengine`;
  token must match `/^[0-9a-f]{32}\.gz$/` and the blob must be typed `application/gzip`.
- `initLightbox({getItems})` / `openLightbox` — lightbox.js:~44/321 — 3-slide drag track,
  axis-locked gestures with fling thresholds, vertical drag-to-dismiss with scale/fade, Back-close
  integrated; main.js owns the browse set.
- `initInfoTips()` / `infoTipHtml()` / `infoTipLabelHtml()` — info-tip.js:~232 — one shared
  bubble, delegated listeners (re-render-proof), pinned-on-tap on touch, `data-tip` plain text by
  default (html opt-in only for trusted markup).
- `createChipInput(opts)` — chip-input.js:~14 — caller owns the data (`list/commit/remove/split`);
  world editor refuses the reserved `nsfw`/`remix` markers via `commit() → false`.
- `tagChipsHtml(tags)` / `fitTagRow(row)` / `scheduleTagFit()` — tag-row.js:~68/104/148 — special
  chips (`nsfw` dark red, `remix` dark purple) always lead so clipping can never hide them; the
  fit pass rewrites rows that wrap and appends a `…` chip whose tooltip lists the hidden tags
  (rAF-coalesced + MutationObserver, since cards are emitted as HTML strings).
- `ColorPicker` class — color-picker.js:~24 — swatch button + hex input (`#rgb`/`#rrggbb`) +
  themed popover; blank/unparseable renders a checkerboard ("no color" is visible, not broken).
- `inlineMd(s)` / `richText(s)` / `chatMd(s)` — rich-text.js:~77/193/275 — escape-FIRST renderer;
  code spans lifted before bold/italic so `*` inside backticks survives; [rpge-patch 020] adds
  sanitized `GFX:` panels and inline `![alt](src)` images with safe-src checks.
- `subUser(text, heroName)` / `heroNameOf(state)` / `blankDetail(v)` — text-utils.js:~14/9/22 —
  the single `{{user}}` resolution every prompt consumer shares (GM context, NPC calls, mapmaker,
  bio generator); `blankDetail` filters dash/"none notable" filler identically everywhere.
- `loadServerBans(force)` / `isCommentIdBanned` / `isAppIdBanned` — server-bans.js:~63/116/120 —
  runtime replacement of the old hardcoded ban-list.js; fetched from the server `state` (socket
  RPC) once per page load before the first comments embed mounts; 5-min cache, 60-s negative
  cache, 4-s per-stage timeout, fail-open; memory-only except a `pageshow` bfcache invalidate.

## Data structures & persistence

- **localStorage keys (machine-local chrome):** `mno.homeNav` (nav collapsed), `mno.showNsfw`,
  `mno.announce.dismissed` (24-h snoozes, deliberately excluded from backups),
  `tavernFabPos`/`tavernFabOn`, `mno.railPref`/`mno.scenePrefs`/`mno.worlds.*` (the last three
  via backup.js's LS_KEYS — doc 21). `mno.homeNav`-style prefs are per-browser by design.
- **History state:** entries carry `{__bid: token, __overlay:true}` (back-close) and/or
  `__mno: "landing"|"session"|"user"` (nav-history markers). Bridge returns rewrite the session
  entry's URL while keeping its marker; `isDeadSessionHash()` heals a stale `#session` bar.
- **Announcements/dismiss state:** `{<noticeId: hash of pages+text>: dismissedAtMs}`, pruned on read.
- **In-memory page state:** `homeUI` in main.js (per-page search/filters/sort/scroll) survives
  page switches within a visit, never a reload; Explore scroll has a 15-min TTL.

## Interactions

- **Doc 21 (storage/bridge):** the landing's Data & Backup footer button and Settings open
  `backup.js`; search-bar's NSFW pref is also a backup LS_KEY; update-check/last-edit/view-count
  talk to the Perchance/loreweaver stats endpoint, not the KV mirror.
- **Doc 22 (main.js):** owns `HOME_SECTIONS` routing, all five page mounts, the session view's
  panels, and the `mnoApp` window facade that notify/popups/user-profile reach through.
- **Doc 23 (AI):** text-utils feeds every prompt builder; rich-text renders GM replies.
- **Doc 25 (systems):** color-picker/chip-input/info-tip are consumed by world-editor and hero
  panel; lightbox shows scene images.
- **Loreweaver core (docs 11–12):** the extension entry calls Loreweaver's
  `extension_settings` + `saveSettingsDebounced`; the bridge deep links (`imports`,
  `settings/aimodel`) come from `public/scripts/extensions/rpg-engine/index.js` buttons.

## Gotchas

- `back-close.js` is a global contract: **every** programmatic close path must call `release()`
  or a stale history entry makes the next Back a silent no-op (or worse, yanks the session back).
  Self-initiated backs are only safe via the `suppress` counter; releases check
  `history.state.__bid` because `history.back()` is async.
- Only `replaceState` reaches the host address bar inside the preview iframe — never write
  `location.hash` or `pushState` for a home route; that is what nav-history.js exists for, and
  same-URL replaceState breaks the previous history link (hence the `force` flag).
- `boot.js` must stay a **classic** script loaded before `main.js`: ES modules can't see the
  engine's bare `root` globals, and the one-shot re-dispatched `beforeinstallprompt` is lost if
  no listener exists at parse time.
- The rail drawer (≤900px) is transient: never persist its state, and a saved desktop "collapsed"
  pref must not leak into it (`applyHomeNavPref`).
- Storage-failure empty lists: page code that reads indexes must tolerate the fallback-`[]`
  tagging from storage-errors.js (doc 21) before writing anything back.
- `perchance-limits.js` constants (`PERCHANCE_INPUT_CAP` 6976) are dead-but-importable leftovers
  of patch 018 — kept only for fit-measure fallback paths.
- Tavern/discussion.js mounts hidden plugin-controller hosts in a body-level div (never inside a
  page pane) so switching landing pages doesn't destroy the iframes; `display:none` would kill
  the plugin's IntersectionObserver lazy-load.
- `#homeNav`'s items use stylesheet-relative `iconImg` paths (`images/…` not `src/images/…`)
  because the path rides through a CSS custom property into styles.css.
