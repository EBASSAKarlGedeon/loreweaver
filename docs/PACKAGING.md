# Packaging (Phase 3)

Loreweaver ships as a standalone desktop app that bundles its own Node backend.
Packaging uses [electron-builder](https://www.electron.build/), configured in the
`build` field of the root `package.json`.

## Layout

- `src/electron/index.js` — Electron main process (upstream shell). It starts the
  Loreweaver server **in-process** (`import '../server-global.js'`, which chdirs to
  the app root two levels up) and opens a BrowserWindow at the server URL.
- `build/icon.ico` — app icon, generated from `Loreweaver.png`.
- `scripts/build-icon.ps1` + `scripts/build-icon.mjs` — icon pipeline (see below).
- `webpack.config.js` — one small local change: `getWebpackCacheVersion()` falls back
  from SHAKE256 to SHA-256 because Electron's Node build does not provide SHAKE
  digests (plain Node does; dev/CLI behavior is unchanged).

The packaged app runs with **global mode** forced by `server-global.js`. Consequence
(`src/command-line.js`, `getDefaultConfig`):

| Setting | Git checkout (standalone mode) | Packaged app (global mode) |
|---|---|---|
| config.yaml | `<repo>/config.yaml` | `%LOCALAPPDATA%\SillyTavern\Data\config.yaml` |
| data root | `<repo>/data/` | `%LOCALAPPDATA%\SillyTavern\Data\data\` |

The two installs coexist with fully separate data, ports (both default 8000 — don't
run them at the same time), cookie secrets and sync state.

## Building

```
npm install        # includes devDeps: electron, electron-builder, png-to-ico
npm run dist       # electron-builder --win (zip + NSIS)
```

Output in `dist/`:

- `win-unpacked/` — the raw app (run `Loreweaver.exe` to test without installing)
- `Loreweaver-1.18.0-win.zip` — portable build
- `Loreweaver Setup 1.18.0.exe` — one-click NSIS installer (per-user)
- `latest.yml` — electron-updater metadata (not wired to auto-update yet)

Notes:

- The app is packaged with `asar: false` on purpose: the server copies default
  content, writes `config.yaml` and builds the webpack frontend cache inside its
  own tree on first start.
- electron-builder rebuilds native dependencies for Electron's ABI
  (`@electron/rebuild` runs automatically).
- No code signing (personal use). Windows SmartScreen may warn on first run.

## Icon

`build/icon.ico` is committed and needed by the build. To regenerate after changing
the logo:

```
powershell -File scripts/build-icon.ps1   # resizes Loreweaver.png -> build/pngs/
node scripts/build-icon.mjs               # assembles build/icon.ico
```

## Sync considerations

The packaged app is a **separate sync device** from the git-checkout client: it has
its own data root, therefore its own sync token, device identity and base table.
Onboard it like any new device (see `docs/SYNC-ONBOARDING.md`) — generate a token
with `sync-token.js` on the hub, add it in the app's sync settings.

To migrate existing data from the git checkout instead: copy the contents of
`<repo>/data/` into `%LOCALAPPDATA%\SillyTavern\Data\data\` while the app is not
running, then copy the sync settings from `<repo>/config.yaml` into the packaged
app's config. API keys are never synced and must be re-entered per device.

## Known limitations

- The packaged app passes `--browserLaunchEnabled=false`, so it only opens its
  own window (upstream's default config would also open a browser tab).

- Character/background **thumbnails fail to generate** under Electron (jimp's wasm
  codecs try to `fetch()` a `file://` URL, which Node refuses). This is an upstream
  behavior that also occurs on plain Node; the UI still works, images are shown
  unresized. Fixing it would mean patching the jimp wasm loading — deferred.
- Third-party extension auto-update logs "not a git repository" in the packaged app
  (no `.git` inside the package). Harmless.
- Auto-update (`latest.yml` / blockmap) is produced but not consumed yet.

## Platforms

- **Windows** — done (this document).
- **Linux** — add `"linux"` targets to the `build` config (AppImage + zip); the
  shell and data paths already resolve via env-paths on Linux.
- **Android** — deferred (Termux on the S21 Ultra covers it).
- **Hub** — the hub on `thinkpad-srv` stays on the git checkout; no package needed.
  To update it: `git fetch upstream && git pull` (or `git pull origin release`),
  `npm install`, restart the service.
