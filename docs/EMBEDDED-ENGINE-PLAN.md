# Embedded web engine for the vault (Electron) — plan

Status: PLANNED, not started. Written 2026-11-27 after the user asked "can we
embed the engine like Glaze does?" while the external-Chrome driver was still
fresh from three window-management bug reports (PITFALLS #35, #37 and the
taskbar reports).

## Why

Glaze never had the "Chrome window appears in the taskbar / on the desktop /
disappears after 30 s" family of bugs because it never spawned a browser: its
Flutter app embeds the platform engine (WebView2 on Windows) and runs site
automation in a `HeadlessInAppWebView`. Loreweaver's vault drives a real
headful Chrome over CDP (`src/endpoints/weavers-vault-browser.js`), which is
why the extension works from a plain web server — and why we own ~200 lines of
window-hiding, parking, restyling and profile-reclaim code that exists only to
make a browser we don't own look invisible.

The packaged app is Electron (`src/electron/index.js`, built into `dist/` by
electron-builder). **Electron ships Chromium.** Inside it, the vault can use an
embedded engine and delete that whole class of problem.

## Scope decision

- **Packaged app (`dist/Loreweaver.exe`) and the repo source launched through
  its Electron entry (`npm run start:electron`)** → embedded engine (Electron
  `BrowserWindow` hidden + `webContents.debugger` for CDP).
- **Repo source launched as a plain server (`node server.js`, localhost in your
  own browser), hub on `thinkpad-srv`, Android/Termux** → external Chrome,
  unchanged. Node has no engine to embed; this is permanent, not a TODO.

  Note on the boundary, because "repo app" is ambiguous: the deciding factor is
  not which checkout is running, it is whether the server process *is* an
  Electron main process. `src/electron/index.js:116` boots the server with
  `import('../server-global.js')` — in-process, same PID — so the Express server
  sees `process.versions.electron` there and the factory below picks the
  embedded backend. Run `node server.js` instead and that global is absent, so
  the same source falls back to external Chrome. What is *impossible* is
  embedding an engine inside a normal browser tab: a web page cannot host a
  browser engine (no `<webview>` for web content), so the browser-hosted repo
  app can never match Glaze's one-process setup.
- Both backends sit behind one interface; routes, classification, ledger and UI
  do not change.

## Architecture

```
routes / janitor code
        │  (unchanged API: hold, release, reveal, navigate,
        │   evaluateInPage, fetchText, screenshot, dispose, …)
        ▼
  VaultBrowser            ← orchestration: holds, idle teardown, adopt
        │ backend            (reused by both implementations)
        ├── ChromeBackend    ← today's code: spawn chrome.exe + CDP websocket,
        │                      window park/hide, profile reclaim
        └── ElectronBackend  ← hidden BrowserWindow (show:false, skipTaskbar),
                               partition session per source, CDP via
                               webContents.debugger
```

Key insight that keeps the change small: `VaultBrowser` is already the
orchestration class and `CdpPage` is already a thin CDP sender. An Electron
backend only has to provide the same two surfaces:

| VaultBrowser needs | ChromeBackend (today) | ElectronBackend |
|---|---|---|
| a CDP `send(method, params)` | `CdpPage` websocket to port from `DevToolsActivePort` | `webContents.debugger.sendCommand` |
| attach to the site page | `attachToPage(port)` | the webContents IS the page |
| window placement/taskbar | PowerShell restyle, `-32000` position, park() | `win.setBounds` / `show(false)` / `skipTaskbar: true` |
| end of life | `killProfileBrowsers`, exit-state repair | `webContents.destroy()`, `session.clearStorageData` |
| cookies/profile | `_vault-janitor-profile` dir | `session.fromPartition('vault-janitor')` |

Everything else — `hold`/`release`/`isHeld`, `enqueue`, idle teardown, the
fetch-token helpers, challenge waiting — is backend-independent and stays put.

## Phases

### Phase 1 — extract the backend interface (pure refactor, zero behavior change)
- Split `VaultBrowser`'s process/window/CDP-touching methods into
  `ChromeBackend` (same file or `weavers-vault-chrome-backend.js`); `VaultBrowser`
  keeps orchestration and calls the backend.
- `getVaultBrowser(key, options)` picks the backend via a small factory:
  `process.versions.electron ? 'electron' : 'chrome'`.
- **Acceptance:** all 311 vault tests pass; one live UI pass (search + card
  detail + a capture) behaves exactly as before; no window regressions. The
  user's retest of PITFALLS #35/#37 fixes is the baseline.

### Phase 2 — ElectronBackend
- New `src/electron/vault-driver.js` (Electron main process): creates hidden
  `BrowserWindow`s (`show: false`, `skipTaskbar: true`, one per source, session
  partition per source), exposes `send()`-shaped CDP through
  `webContents.debugger`.
- The Electron main process bridges it to the Node server: the driver module is
  imported conditionally — `weavers-vault.js` gets the same
  `janitorBrowserFor(req)` object regardless of backend.
- UA: strip the `Electron/x.y` token (the same measure Glaze applies to
  WebView2's `Edg/…` token; Google sign-in rejects foreign tokens there).
- **Acceptance (needs site go-ahead, ≤5 requests):** Cloudflare challenge
  passes without user interaction; sign-in works from the packaged app; a card
  + lorebook import lands in `data/` and is verified on disk.

### Phase 3 — in-app login/verification surfaces
- `reveal()` under Electron = `show()` on the same hidden window
  (`skipTaskbar: true` keeps it out of Alt-Tab/Taskbar natively — no
  PowerShell).
- Optional polish (only after Phase 2 is trusted): render the login/verification
  page inside a vault modal sheet, Glaze-style, instead of a separate window.
- Delete the now-dead paths: `hideProfileWindows`, `normalizeProfileWindows`,
  `raiseProfileWindows`, park/nudge dance — behind the Electron backend only
  (ChromeBackend keeps them).

### Phase 4 — packaging + rollout
- `electron-builder` config: no extra runtime needed (Electron includes
  Chromium); verify `dist/` build imports the driver.
- Docs: FAQ entry "which app uses which browser backend", and a note in the
  JANITOR-PLAN that the external-Chrome constraints (challenge window, profile
  copy for the sandbox) apply to server deployments only.
- Android/Termux and hub stay on ChromeBackend — document as deliberate.

## Risks / honest unknowns

- **Cloudflare on Electron's Chromium**: UA token stripped, but challenge
  behavior must be *measured* on the real site before we trust it (same rule as
  always: minimum requests, explicit go-ahead). Glaze's evidence (WebView2
  passes with the same hybrid-composition approach) is encouraging, not proof.
- **`webContents.debugger` coverage**: implements CDP, but a few domains
  (`Browser.getWindowForTarget`, offscreen screenshots) differ; the backend
  interface absorbs this, but Phase 2 starts with a probe script, not a port.
- **Session partition ≠ profile dir**: the janitor sign-in flow must be re-run
  once in the packaged app; the `_vault-janitor-profile` cookie-copy trick for
  the sandbox does not apply to partitions.
- **Two code paths forever**: ChromeBackend stays supported because three
  deployments genuinely need it; PITFALLS entries for window bugs must say
  which backend they apply to.

## What does NOT change

Routes, `janitorSearchUrl`, classification, ledger, capture drive, settings
merge, sync. The vault client never knows which backend answered.
