# Testing conventions

This is the guide for writing and running tests in LoreWeaver. Read it before you add a test, and
before you say a UI change works. If you are an AI model, follow it literally: it describes what
this repo actually has, not what a generic SvelteKit project would have.

## 1. Current state

- **Unit tests: Vitest.** `npm test` runs `vitest run` over `src/**/*.test.ts` using the standalone
  `vitest.config.ts` (node environment, no SvelteKit plugin — details in section 3).
- **The type gate is `npm run check`.** It runs `svelte-kit sync` and `svelte-check`. It must report
  `0 ERRORS 0 WARNINGS`. Run it and `npm test` after every change, before you commit.
- **UI work also needs a browser check.** Type checks do not prove that a page renders or that a
  click does the right thing. Use the browser checks in `scripts/` (section 4).

Work in this order: type check first, then logic tests if the module is pure, then a browser check
for anything visual or interactive.

## 2. Test layers

| Layer | When to use it | How |
| --- | --- | --- |
| Type check | Every change | `npm run check` |
| Pure logic | Pure functions with no DOM and no IndexedDB (`src/lib/lorebook.ts`, `src/lib/lorebook-import.ts`, `src/lib/landing/format.ts`) | Unit tests (section 3) |
| Database | Code that reads or writes Dexie tables (`src/lib/chats.ts`, `src/lib/state/settings.svelte.ts`, `src/lib/lorebook-sources.ts`) | Browser check (section 4) |
| UI and flows | Routes and components | Browser check (section 4) |
| Network | `src/lib/llm.ts` streaming | Not automated yet. Check by hand against a local server, or mock `fetch` in a unit test |

Do not write a test that only mirrors the implementation. A useful test fails when the behaviour
it describes breaks.

## 3. Unit tests (Vitest)

The runner is installed: Vitest 3 (pinned to v3 because the project is on Vite 5 — Vitest 5 needs
Vite ≥ 6) with a standalone config.

1. `npm test` runs `vitest run`; `npm run check` stays the type gate and type-checks test files too.
2. Tests live next to the module as `name.test.ts`, matched by the `src/**/*.test.ts` glob in
   `vitest.config.ts`. Keep browser checks out of that glob (they are `.mjs` in `scripts/`).
3. `vitest.config.ts` intentionally ignores `vite.config.ts`: node environment, no SvelteKit plugin,
   no `$lib` alias. Import the module under test by relative path (`./prompt`, `./lorebook`).
4. Only pure modules qualify — no Dexie, no DOM, no runes (`$state` in `.svelte.ts` imports the
   compiler). Database and UI behaviour still go through browser checks (section 4).
5. Never send real API requests from a test, and never import from `reference/`.

## 4. Browser checks

Browser checks run the real app in headless Microsoft Edge and drive it over the Chrome DevTools
Protocol. They need no test framework. The reusable pieces live in `scripts/`:

| File | Purpose |
| --- | --- |
| `scripts/cdp.mjs` | Shared helper: connects to the page, evaluates JS, presses keys, takes screenshots, and records PASS/FAIL |
| `scripts/seed-sample-data.mjs` | Replaces the data in the throwaway profile with sample characters and chats, then reloads and takes a screenshot |
| `scripts/check-popups.mjs` | Checks the character details popup and the Appearance panel |
| `scripts/check-navigation.mjs` | Checks Start New Chat, Continue, and the unknown-chat message |

Run them in this order, from the repo root, after the setup in 4.1 and 4.2:

```bash
node scripts/seed-sample-data.mjs
node scripts/check-popups.mjs
node scripts/check-navigation.mjs
```

Each check prints `PASS` or `FAIL` and exits non-zero on failure. Screenshots are written to the OS
temp folder (`%TEMP%\lw-check` on Windows), never into the repo.

Environment variables, all optional:

- `LW_APP_URL`: default `http://localhost:5173`
- `LW_CDP_PORT`: default `9333`, must match the Edge flag
- `LW_OUT_DIR`: where screenshots go, default `<temp>/lw-check`

### 4.1 Start the app

```bash
npm run dev          # http://localhost:5173
```

### 4.2 Start a headless Edge with the DevTools protocol

Use a throwaway profile directory so you never touch the user's real browser data. The seed script
clears data in whatever profile is connected, so this profile must stay throwaway.

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --disable-gpu --no-sandbox `
  --remote-debugging-port=9333 `
  --user-data-dir="$env:TEMP\lw-edge-profile" `
  --window-size=1400,900 http://localhost:5173/
```

Do **not** add `--virtual-time-budget`. It starves IndexedDB and leaves pages stuck on "Loading…",
which looks like an app bug and is not one.

### 4.3 How the helper works

`scripts/cdp.mjs` exports `connect()`. It returns an object with:

- `evaluate(expression)`: runs JS in the page and returns the value. It awaits promises.
- `send(method, params)`: any raw CDP command, for example `Page.navigate` or `Page.reload`.
- `pressKey(key, code, keyCode)`: sends a key press, for example `pressKey('Escape', 'Escape', 27)`.
- `screenshot(name)`: saves a PNG and returns its path.
- `check(label, actual, expected)`: prints PASS or FAIL and sets the exit code on failure.
- `close()`: closes the socket.

To write a new check, copy an existing file in `scripts/`, name it `check-<thing>.mjs`, and use
`browser.check(...)` for every assertion. Do not `console.log` an assertion without `check`.

### 4.4 Seeding and storage facts

The app stores data in IndexedDB database `loreweaver`. Dexie stores the schema version as 10
(Dexie multiplies by ten). Opening the database **without a version number** is required, or the
open fails with `VersionError`. Stores:

- `characters`, `chats`, `messages`: `keyPath: 'id'`, `autoIncrement: true`
- `settings`: `keyPath: 'id'`, singleton row with `id: 1`

`seed-sample-data.mjs` runs inside the page, clears the three content stores, adds rows, and waits
for `liveQuery` to emit after a reload. To seed different data, edit that script. Do not seed from
a copy of real user data.

### 4.5 What to assert

- Route rendering: `evaluate` returns the expected text or element count. Example:
  `document.querySelector('.conv-header')?.textContent`.
- Navigation: `location.pathname` after the click. Example: Start New Chat lands on `/chat/<id>`.
- Keyboard: `pressKey` sends a key. Escape should close the modal.
- Missing data: an unknown id shows its message, not a crash.
- Visual: take a screenshot and view the PNG when a check cannot be expressed as text. Delete the
  PNG when you are done. Never commit screenshots unless the user asks.

### 4.6 Clean up

Stop the dev server and the headless Edge process when you are done. On Windows:

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*lw-edge-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Leave no scratch files in the repo.

## 5. Debugging a failing browser check

- **Page stuck on "Loading…":** check the console. Look for `Library query failed`. If none, rule
  out `--virtual-time-budget` first.
- **Server dies right after "ready":** a Dexie or browser-only call ran during SSR. See CLAUDE.md:
  Dexie calls belong in `onMount` or `$effect`.
- **`VersionError` when seeding:** you passed a version to `indexedDB.open`. Remove it.
- **`[object Object]` unhandled rejection in the dev server:** the message is a Dexie error object.
  Print `reason.name` and `reason.message` with a `process.on('unhandledRejection')` handler loaded
  via `NODE_OPTIONS="--import ./file.mjs"`. Delete that file when done.
- **A selector finds nothing:** check the class names in `src/lib/landing/*.svelte`. The landing CSS is
  scoped under `.landing`, so selectors must match exactly.
- **`connect()` throws "No page at ...":** the dev server or Edge is not running, or the Edge flag
  port does not match `LW_CDP_PORT`.

## 6. Rules for every test

1. Test behaviour, not markup details that may change. Prefer `textContent` and `location.pathname`
   over long CSS paths.
2. Make each check independent. Seed or reset the data at the start of a run, not in the middle.
3. Never send real API requests in a test. Point `baseUrl` at a dead local port or mock `fetch`.
4. Do not store real API keys in seed data or in the repo.
5. Reusable checks go in `scripts/` as `check-*.mjs`. One-off helpers stay in the temp folder.
6. A failing check is a finding. Report it with the output. Do not weaken the check to make it pass.
7. Record what you tested and what you did not. The user needs both to trust the result.
