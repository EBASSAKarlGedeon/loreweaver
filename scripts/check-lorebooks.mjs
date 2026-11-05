// End-to-end lorebook (SillyTavern World Info) injection check.
//
// Proves the wiring in the REAL running app, not a unit-test double: seed
// sample data, import a synthetic lorebook through the dev-only __lw hook,
// attach it to BOTH the global pool (settings.lorebookIds) and the character
// pool (character.lorebookIds), reload so the settings singleton re-reads the
// row, then assert on the exact prompt __lw.previewPrompt() would send next
// turn (src/routes/+layout.svelte).
//
// What the synthetic book asserts:
//   uid 0 constant, position 0  -> one system message BEFORE the character card
//   uid 1 keyword,  position 1  -> activates when a scanned message contains
//                                  "purple elephant" (scan depth = 4)
//   uid 2 keyword,  disable     -> never injects
//   uid 3 constant, position 4, depth 1, role 1 -> one `user` message spliced
//                                  near the end of history
// The book is attached to global + character at once, so every marker must
// appear EXACTLY once (SillyTavern dedup, precedence global > chat > persona
// > character). The keyword sits on the 4th-newest message, so it only
// activates once settings.lorebookDepth = 4 has loaded into the singleton —
// that also proves the global pool read the patched row.
//
// Usage: node scripts/check-lorebooks.mjs   (from the repo root; docs/TESTING.md §4)
import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, CDP_PORT, OUT_DIR, connect, wait } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Throwaway browser profile (docs/TESTING.md §4.2) — never the real one
const PROFILE = join(tmpdir(), 'lw-edge-profile');
const EDGE_PATHS = [
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
// seed-sample-data.mjs always writes one screenshot; delete it when done
const SEED_SHOT = join(OUT_DIR, 'lorebooks-seed.png');

// Exact strings the entries inject — asserted verbatim against the prompt
const CONSTANT = 'LW_CONSTANT_MARKER_7f3';
const KEYWORD = 'LW_KEYWORD_MARKER_7f3';
const DISABLED = 'LW_DISABLED_MARKER_7f3';
const DEPTH = 'LW_DEPTH_MARKER_7f3';
const KEY_PHRASE = 'purple elephant';

// Native SillyTavern world file: entries keyed by uid. Fields the importer
// (src/lib/lorebook-import.ts) does not get take template defaults.
const BOOK = {
	entries: {
		0: { content: CONSTANT, constant: true, position: 0 },
		1: { key: [KEY_PHRASE], content: KEYWORD, position: 1 },
		2: { key: [KEY_PHRASE], content: DISABLED, position: 1, disable: true },
		3: { content: DEPTH, constant: true, position: 4, depth: 1, role: 1 }
	}
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function httpOk(url, timeoutMs) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Polls fn() until it is truthy; returns that value, or null on timeout. */
async function until(fn, timeoutMs, intervalMs = 400) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let value = null;
		try {
			value = await fn();
		} catch {
			value = null; // page may be mid-navigation; keep polling
		}
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await wait(intervalMs);
	}
}

/** TESTING.md §4.6: stop Edge processes that use the throwaway profile. */
function killEdgeByProfile() {
	const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*lw-edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
	// -EncodedCommand sidesteps cmd.exe/PowerShell quoting for the filter string
	const encoded = Buffer.from(ps, 'utf16le').toString('base64');
	try {
		execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
			stdio: 'ignore'
		});
	} catch {
		// no matching process — nothing to stop
	}
}

/** Kills a process and its children (the npm -> vite tree we spawned). */
function killTree(pid) {
	if (!pid) return;
	try {
		execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
	} catch {
		// already gone
	}
}

// Opens `loreweaver` WITHOUT a version number: Dexie stores schema version 10,
// so passing one raises VersionError (docs/TESTING.md §4.4).
const OPEN_DB = `new Promise((resolve, reject) => {
	const request = indexedDB.open('loreweaver');
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
})`;

const readIdsExpr = `(async () => {
	const db = await ${OPEN_DB};
	const readAll = (store) => new Promise((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).getAll();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const read = (store, key) => new Promise((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).get(key);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const characters = (await readAll('characters')).sort((a, b) => a.id - b.id);
	const chats = (await readAll('chats')).sort((a, b) => a.id - b.id);
	const settingsRow = await read('settings', 1);
	db.close();
	const character = characters[0];
	const chat = character ? chats.find((c) => c.characterId === character.id) : null;
	if (!character || !chat) return JSON.stringify({ ready: false });
	return JSON.stringify({
		ready: true,
		settingsReady: Boolean(settingsRow),
		charId: character.id,
		chatId: chat.id,
		description: character.description || ''
	});
})()`;

// Four messages total, keyword phrase on the OLDEST one: activating it needs
// settings.lorebookDepth = 4 (the default 2 scans only the newest two). That
// makes the keyword assertion double as proof the patched settings row made it
// into the singleton the prompt actually reads.
const addMessagesExpr = (chatId) => `(async () => {
	const db = await ${OPEN_DB};
	const rows = [
		{ chatId: ${chatId}, role: 'user', content: 'A ${KEY_PHRASE} trumpets at the ruined door.', createdAt: Date.now() - 3000 },
		{ chatId: ${chatId}, role: 'user', content: 'Water drips somewhere deeper in the stacks.', createdAt: Date.now() - 2000 },
		{ chatId: ${chatId}, role: 'assistant', content: 'The archivist does not look up from the page.', createdAt: Date.now() - 1000 }
	];
	await new Promise((resolve, reject) => {
		const tx = db.transaction('messages', 'readwrite');
		for (const row of rows) tx.objectStore('messages').add(row);
		tx.oncomplete = () => resolve('ok');
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	db.close();
	return 'added 3 messages';
})()`;

const patchExpr = (bookId, charId) => `(async () => {
	const db = await ${OPEN_DB};
	await new Promise((resolve, reject) => {
		const tx = db.transaction(['settings', 'characters'], 'readwrite');
		const settingsReq = tx.objectStore('settings').get(1);
		settingsReq.onerror = () => tx.abort();
		settingsReq.onsuccess = () => {
			const row = settingsReq.result;
			if (!row) return tx.abort();
			tx.objectStore('settings').put({ ...row, lorebookIds: [${bookId}], lorebookDepth: 4 });
			const charReq = tx.objectStore('characters').get(${charId});
			charReq.onerror = () => tx.abort();
			charReq.onsuccess = () => {
				const character = charReq.result;
				if (!character) return tx.abort();
				tx.objectStore('characters').put({ ...character, lorebookIds: [${bookId}] });
			};
		};
		tx.oncomplete = () => resolve('ok');
		tx.onabort = () => reject(new Error('settings/character patch aborted'));
		tx.onerror = () => reject(tx.error);
	});
	db.close();
	return 'patched';
})()`;

const previewExpr = (charId, chatId) =>
	`(async () => JSON.stringify(await window.__lw.previewPrompt(${charId}, ${chatId})))()`;

// Collects the app's own failure signals (buildLoreInjection fails soft: it
// logs "[LW] Lorebook evaluation failed" and returns null, which surfaces as
// MISSING markers, not an exception).
const installErrorHook = (browser) =>
	browser.evaluate(`(() => {
		if (window.__lwErrors) return 'kept';
		window.__lwErrors = [];
		const record = (parts) => {
			try {
				window.__lwErrors.push(parts.map((part) => (part && part.stack) || String(part)).join(' '));
			} catch (err) {
				window.__lwErrors.push('unprintable error');
			}
		};
		const originalError = console.error.bind(console);
		console.error = function (...args) {
			record(args);
			originalError(...args);
		};
		window.addEventListener('error', (event) => record([event.message]));
		window.addEventListener('unhandledrejection', (event) =>
			record([String((event.reason && event.reason.message) || event.reason)])
		);
		return 'installed';
	})()`);

const readErrors = async (browser) => {
	try {
		const raw = await browser.evaluate(`JSON.stringify((window.__lwErrors || []).slice(0, 20))`);
		return JSON.parse(raw);
	} catch {
		return [];
	}
};

const reportPageErrors = async (browser, heading) => {
	const errors = await readErrors(browser);
	if (errors.length) console.error(`${heading}:\n  - ${errors.join('\n  - ')}`);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let browser = null;
let devProc = null;
let edgeProc = null;
let startedDev = false;

try {
	// --- 1. Dev server: only start one that is not already listening ---
	if (await httpOk(APP_URL, 5000)) {
		console.log(`using the dev server already listening at ${APP_URL}`);
	} else {
		startedDev = true;
		// One command string + shell (no args array) keeps Node from warning DEP0190
		devProc = spawn('npm run dev', {
			cwd: ROOT,
			detached: true,
			stdio: 'ignore',
			shell: true
		});
		devProc.on('error', (err) => console.error(`dev server spawn failed: ${err.message}`));
		devProc.unref();
		const ready = await until(() => httpOk(APP_URL, 3000), 60000, 500);
		if (!ready) throw new Error(`dev server never became ready at ${APP_URL}`);
		console.log(`started the dev server at ${APP_URL}`);
	}

	// --- 2. Headless Edge with a throwaway profile (TESTING.md §4.2) ---
	const cdpBase = `http://127.0.0.1:${CDP_PORT}`;
	if (await httpOk(`${cdpBase}/json/version`, 2000)) {
		console.log(`reusing the headless Edge already on CDP port ${CDP_PORT}`);
	} else {
		killEdgeByProfile(); // release a stale lock on the profile directory
		const edge = EDGE_PATHS.find(existsSync);
		if (!edge) throw new Error('msedge.exe not found in Program Files (x86) or Program Files');
		// No --virtual-time-budget: it starves IndexedDB (TESTING.md §4.2)
		edgeProc = spawn(
			edge,
			[
				'--headless=new',
				'--disable-gpu',
				'--no-sandbox',
				`--remote-debugging-port=${CDP_PORT}`,
				`--user-data-dir=${PROFILE}`,
				'--window-size=1400,900',
				`${APP_URL.replace(/\/+$/, '')}/`
			],
			{ cwd: ROOT, detached: true, stdio: 'ignore' }
		);
		edgeProc.on('error', (err) => console.error(`edge spawn failed: ${err.message}`));
		edgeProc.unref();
		const up = await until(() => httpOk(`${cdpBase}/json/version`, 2000), 30000, 500);
		if (!up) throw new Error(`Edge DevTools endpoint never came up on port ${CDP_PORT}`);
	}

	// connect() needs a page target already at APP_URL
	const pageReady = await until(async () => {
		const targets = await (
			await fetch(`${cdpBase}/json`, { signal: AbortSignal.timeout(2000) })
		).json();
		return targets.some((t) => t.type === 'page' && t.url.startsWith(APP_URL));
	}, 30000, 500);
	if (!pageReady) throw new Error(`no page target at ${APP_URL} on CDP port ${CDP_PORT}`);

	browser = await connect();

	// --- 3. The dev-only console hook attaches in onMount: poll for it ---
	const hooked = await until(() => browser.evaluate('!!window.__lw'), 60000, 500);
	if (!hooked) {
		throw new Error('window.__lw never appeared — needs a dev build (docs/TESTING.md §5)');
	}
	await installErrorHook(browser);

	// --- 4. Seed through the same script the other checks use ---
	console.log('seeding sample characters and chats...');
	const seeded = spawnSync(
		process.execPath,
		[join(ROOT, 'scripts', 'seed-sample-data.mjs'), 'lorebooks-seed'],
		{ cwd: ROOT, stdio: 'inherit' }
	);
	if (seeded.status !== 0) throw new Error(`seed-sample-data.mjs exited with ${seeded.status}`);
	// The seed script reloads the page, which re-creates the JS context
	if (!(await until(() => browser.evaluate('!!window.__lw'), 30000, 400))) {
		throw new Error('window.__lw disappeared after seeding');
	}
	await installErrorHook(browser);

	// --- 5. Read the seeded ids; poll until loadSettings created the row ---
	const ids = await until(async () => {
		const raw = await browser.evaluate(readIdsExpr);
		const data = JSON.parse(raw);
		return data.ready && data.settingsReady ? data : null;
	}, 15000, 400);
	if (!ids) throw new Error('seeded rows or the settings row never appeared in IndexedDB');
	console.log(`character ${ids.charId}, chat ${ids.chatId}, ${ids.description.length} char description`);

	// --- 6. Messages: four in history, keyword phrase on the oldest ---
	const added = await browser.evaluate(addMessagesExpr(ids.chatId));
	console.log(`history: ${added}`);

	// --- 7. Import the synthetic lorebook through the app's own importer ---
	const bookId = await browser.evaluate(
		`window.__lw.importLorebook(${JSON.stringify(BOOK)}, 'LW Check Book')`
	);
	browser.check('synthetic lorebook imports with a numeric id', typeof bookId, 'number');

	// --- 8. Attach it globally AND to the character, then reload ---
	// The settings singleton loads from the Dexie row once per page load, so
	// the row change only reaches previewPrompt after Page.reload. The
	// character pool is read fresh each call, but we patch it too — the double
	// attachment is what the dedup assertion exercises.
	const patched = await browser.evaluate(patchExpr(bookId, ids.charId));
	console.log(`attached book #${bookId} to settings + character: ${patched}`);
	await browser.send('Page.reload', { ignoreCache: true });
	if (!(await until(() => browser.evaluate('!!window.__lw'), 30000, 400))) {
		throw new Error('window.__lw did not return after the settings reload');
	}
	await installErrorHook(browser);

	// --- 9. The exact prompt for the next turn ---
	// Retry briefly: loadSettings() runs asynchronously in onMount, a tick
	// after __lw is attached. Whatever we hold when the window closes is what
	// gets asserted — a genuinely broken setup still fails below.
	let messages = null;
	const previewDeadline = Date.now() + 10000;
	for (;;) {
		try {
			const raw = await browser.evaluate(previewExpr(ids.charId, ids.chatId));
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) messages = parsed;
		} catch {
			messages = null;
		}
		if (messages && messages.some((m) => String(m.content ?? '').includes(KEYWORD))) break;
		if (Date.now() >= previewDeadline) break;
		await wait(500);
	}
	if (!messages || messages.length === 0) {
		throw new Error('previewPrompt never returned a non-empty message array');
	}

	// Occurrence counting across the whole prompt (not just "messages containing")
	const inMessages = (marker) =>
		messages.filter((m) => String(m.content ?? '').includes(marker)).length;
	const total = (marker) =>
		messages.reduce(
			(n, m) => n + String(m.content ?? '').split(marker).length - 1,
			0
		);

	browser.check('prompt has messages to inspect', messages.length > 0, true);

	// (a) constant entry: exactly once, in a system message ahead of the card
	browser.check('constant marker appears in exactly one message', inMessages(CONSTANT), 1);
	const constIdx = messages.findIndex((m) => String(m.content ?? '').includes(CONSTANT));
	const descIdxs =
		ids.description.length > 0
			? messages
					.map((m, i) => (String(m.content ?? '').includes(ids.description) ? i : -1))
					.filter((i) => i >= 0)
			: [];
	let beforeCard;
	if (descIdxs.length === 1) {
		// Normal case: the character card is one system message; the constant
		// must sit ahead of it (position 0 = "Before Char Defs")
		beforeCard =
			constIdx >= 0 && constIdx < descIdxs[0] && messages[constIdx].role === 'system';
	} else {
		// Description empty or ambiguous: fall back to "first system message"
		beforeCard = constIdx >= 0 && constIdx === messages.findIndex((m) => m.role === 'system');
	}
	browser.check(
		'constant marker sits in a system message before the character description',
		beforeCard,
		true
	);

	// (b) keyword entry activated against the scan (needs lorebookDepth = 4)
	browser.check('keyword marker appears in exactly one message', inMessages(KEYWORD), 1);

	// (c) disabled entry never injects — zero occurrences, total
	browser.check('disabled marker never appears in the prompt', total(DISABLED), 0);

	// (d) AT_DEPTH entry: exactly one, with the mapped role (entry.role 1)
	browser.check('depth marker appears in exactly one message', inMessages(DEPTH), 1);
	browser.check(
		'depth marker is injected as a user message',
		messages.filter((m) => m.role === 'user' && String(m.content ?? '').includes(DEPTH))
			.length,
		1
	);

	// (e) dedup: the book is attached to global + character, so no marker may
	// appear twice anywhere in the prompt
	const maxOccurrences = Math.max(
		total(CONSTANT),
		total(KEYWORD),
		total(DISABLED),
		total(DEPTH)
	);
	browser.check('no marker appears twice despite the double attachment', maxOccurrences <= 1, true);

	if (process.exitCode) await reportPageErrors(browser, 'page console errors');
	else console.log('RESULT: PASS — lorebook injection works end to end');
} catch (err) {
	process.exitCode = 1;
	console.error(`FAIL lorebook end-to-end check aborted: ${err && err.message}`);
	if (browser) await reportPageErrors(browser, 'page console errors');
} finally {
	try {
		browser?.close();
	} catch {
		// socket already gone
	}
	try {
		if (existsSync(SEED_SHOT)) unlinkSync(SEED_SHOT);
	} catch {
		// nothing to delete
	}
	killEdgeByProfile(); // throwaway profile only (TESTING.md §4.6)
	if (startedDev) killTree(devProc?.pid); // never kill a server we did not start
}
