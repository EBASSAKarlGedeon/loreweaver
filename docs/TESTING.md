# Testing conventions

This is the guide for writing and running tests in LoreWeaver. Read it before you add a test, and
before you say a UI change works. If you are an AI model, follow it literally: it describes what
this repo actually has, not what a generic SvelteKit project would have.

## 1. Current state

- **No test runner is installed.** There is no Vitest, Jest or Playwright in `package.json`.
- **The gate is `npm run check`.** It runs `svelte-kit sync` and `svelte-check`. It must report
  `0 ERRORS 0 WARNINGS`. Run it after every change, before you commit.
- **UI work also needs a browser check.** Type checks do not prove that a page renders or that a
  click does the right thing. Use the browser recipe in section 4 for that.

Work in this order: type check first, then logic tests if the module is pure, then a browser check
for anything visual or interactive.

## 2. Test layers

| Layer | When to use it | How |
| --- | --- | --- |
| Type check | Every change | `npm run check` |
| Pure logic | Pure functions with no DOM and no IndexedDB (`src/lib/landing/format.ts`, `src/lib/landing/appearance.ts`, `src/lib/prompt.ts`) | Unit tests, once a runner exists (see section 3) |
| Database | Code that reads or writes Dexie tables (`src/lib/chats.ts`, `src/lib/state/settings.svelte.ts`) | Browser check (section 4), or fake-indexeddb once a runner exists |
| UI and flows | Routes and components | Browser check (section 4) |
| Network | `src/lib/llm.ts` streaming | Not automated yet. Check by hand against a local server, or mock `fetch` in a unit test |

Do not write a test that only mirrors the implementation. A useful test fails when the behaviour
it describes breaks.

## 3. Adding a unit-test runner (when the repo needs one)

No runner exists yet. If you add one, keep it minimal and say so in the commit message:

1. Use **Vitest**. It shares Vite's config, so it adds no second build setup.
2. Add `"test": "vitest run"` to `package.json` scripts, and keep `check` as the type gate.
3. Put unit tests next to the module as `name.test.ts`. Keep browser tests out of that glob.
4. Import from `$lib/...` only if the Vitest config includes the `$lib` alias. SvelteKit's Vite plugin
   usually provides it. Check before you rely on it.
5. Update section 1 and CLAUDE.md's Commands section when you add the runner.

## 4. Browser check recipe (Windows, Edge)

This is how the landing page was verified. It works without any test framework. It needs only
Node 18+ (for global `fetch` and `WebSocket`), Microsoft Edge, and the dev server.

### 4.1 Start the app

```bash
npm run dev          # http://localhost:5173
```

### 4.2 Start a headless Edge with the DevTools protocol

Use a throwaway profile directory so you never touch the user's real browser data.

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --disable-gpu --no-sandbox `
  --remote-debugging-port=9333 `
  --user-data-dir="$env:TEMP\lw-edge-profile" `
  --window-size=1400,900 http://localhost:5173/
```

Do **not** add `--virtual-time-budget`. It starves IndexedDB and leaves pages stuck on "Loading…",
which looks like an app bug and is not one.

### 4.3 Drive it from Node

Find the page target at `http://127.0.0.1:9333/json`, open its `webSocketDebuggerUrl`, and send
CDP commands with `Runtime.evaluate` (`awaitPromise: true`, `returnByValue: true`),
`Page.navigate`, `Page.reload` and `Page.captureScreenshot`. Keep the helper small:

```js
const target = (await (await fetch('http://127.0.0.1:9333/json')).json())
  .find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); };
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
```

Write screenshots with an **absolute Windows path**. `/tmp/...` in Node on Windows becomes `C:\tmp`,
which usually does not exist. Use `process.env.TEMP` and forward slashes.

### 4.4 Seed data without going through the UI

Dexie stores data in IndexedDB database `loreweaver`. The Dexie schema version is stored as 10
(Dexie multiplies by ten), so open the database **without a version number** or the open fails with
`VersionError`. Object stores:

- `characters`, `chats`, `messages`: `keyPath: 'id'`, `autoIncrement: true`
- `settings`: `keyPath: 'id'`, singleton row with `id: 1`

Seed with `Runtime.evaluate`, then `Page.reload`, then wait about 2 seconds for `liveQuery` to emit,
then capture. A sample seed that the team has used:

```js
(async () => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('loreweaver');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const tx = db.transaction(['characters', 'chats', 'messages'], 'readwrite');
  const now = Date.now();
  const characterId = await new Promise((res) => {
    const r = tx.objectStore('characters').add({
      name: 'Aria Vale', description: 'A wandering archivist.', personality: 'Curious',
      scenario: '', firstMessage: 'You found the stairs.', favorite: true,
      createdAt: now, updatedAt: now
    });
    r.onsuccess = () => res(r.result);
  });
  const chatId = await new Promise((res) => {
    const r = tx.objectStore('chats').add({ characterId, title: 'Aria Vale', createdAt: now, updatedAt: now });
    r.onsuccess = () => res(r.result);
  });
  tx.objectStore('messages').add({ chatId, role: 'assistant', content: 'Shall we go down?', createdAt: now });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return 'seeded';
})()
```

Seed data is shared by everyone who uses that browser profile. Only seed the throwaway profile in 4.2.

### 4.5 What to assert

- Route rendering: `evaluate` returns the expected text or element count. Example: `document.querySelector('.conv-header')?.textContent`.
- Navigation: `location.pathname` after the click. Example: clicking "Start New Chat" lands on `/chat/<id>`.
- Keyboard: send a key with `Input.dispatchKeyEvent`. Escape should close the modal.
- Missing data: an unknown id shows its message, not a crash.
- Visual: take a screenshot with `Page.captureScreenshot` and view the PNG. Store it in your temp
  folder and delete it when done. Never commit screenshots unless the user asks.

### 4.6 Clean up

Kill the dev server and the headless Edge process when you are done. On Windows:

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*lw-edge-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Leave no scratch files in the repo. Use `$env:TEMP` or the scratch directory.

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

## 6. Rules for every test

1. Test behaviour, not markup details that may change. Prefer `textContent` and `location.pathname`
   over long CSS paths.
2. Make each check independent. Reseed or reset the database at the start of a run, not in the
   middle of it.
3. Never send real API requests in a test. Point `baseUrl` at a dead local port or mock `fetch`.
4. Do not store real API keys in seed data or in the repo.
5. A failing check is a finding. Report it with the output. Do not weaken the check to make it pass.
6. Record what you tested and what you did not. The user needs both to trust the result.
