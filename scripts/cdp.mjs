// Minimal Chrome DevTools Protocol client for the headless-browser checks.
// Requires a running dev server and a headless Edge with --remote-debugging-port
// (see docs/TESTING.md, section 4). Node 18+ (global fetch and WebSocket).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const APP_URL = process.env.LW_APP_URL ?? 'http://localhost:5173';
export const CDP_PORT = Number(process.env.LW_CDP_PORT ?? 9333);
// Screenshots and scratch files go to the OS temp folder, never into the repo
export const OUT_DIR = process.env.LW_OUT_DIR ?? join(tmpdir(), 'lw-check');

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connect() {
	const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
	const page = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL));
	if (!page) {
		throw new Error(
			`No page at ${APP_URL} on CDP port ${CDP_PORT}. Start the dev server and Edge first (docs/TESTING.md, section 4).`
		);
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	let nextId = 0;
	const pending = new Map();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	};
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ id, method, params }));
		});

	const evaluate = async (expression) => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (r.result?.exceptionDetails) {
			throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
		}
		return r.result?.result?.value;
	};

	const pressKey = async (key, code, keyCode) => {
		const params = { key, code, windowsVirtualKeyCode: keyCode };
		await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
	};

	const screenshot = async (name) => {
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		mkdirSync(OUT_DIR, { recursive: true });
		const file = join(OUT_DIR, `${name}.png`);
		writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
		return file;
	};

	// Prints PASS/FAIL and sets a non-zero exit code on failure, so runs can be trusted
	const check = (label, actual, expected) => {
		const ok = JSON.stringify(actual) === JSON.stringify(expected);
		const detail = ok
			? ''
			: `\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`;
		console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail}`);
		if (!ok) process.exitCode = 1;
		return ok;
	};

	return { send, evaluate, pressKey, screenshot, check, close: () => ws.close() };
}
