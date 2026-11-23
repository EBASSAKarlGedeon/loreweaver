/**
 * Weaver's Vault — JannyAI browser driver.
 *
 * The port of Glaze's `JannyWebViewProxy` (janny_webview_proxy.dart, AGPL-3.0).
 * jannyai.com sits behind a Cloudflare managed challenge, and `cf_clearance` is
 * bound to the TLS fingerprint of whoever solved it — so replaying cookies from
 * Node cannot work (`403 cf-mitigated: challenge`, measured 2026-11-23). A real
 * Chromium solves the challenge just by loading the page, and a `fetch()` run
 * inside that page keeps the same fingerprint and cookie jar, so it passes.
 *
 * Same lifecycle as Glaze's proxy: started on demand, parked on the origin,
 * serialized requests, torn down after an idle TTL. Implemented over CDP with
 * `ws` (already a dependency) so no browser-automation package is pulled in.
 *
 * Verified on this machine 2026-11-23: headless Chrome is rejected by the
 * challenge, headful Chrome with a persistent profile passes — hence the
 * offscreen window below. Chrome is used via `channel: chrome` semantics: the
 * installed browser, a dedicated profile dir, no user profile touched.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const ORIGIN = 'https://jannyai.com/';
const IDLE_TTL_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const CHALLENGE_TIMEOUT_MS = 45_000;

/** Candidate browser binaries, first existing wins. */
const BROWSER_CANDIDATES = [
    process.env.JANNY_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export class JannyBrowserUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'JannyBrowserUnavailable';
    }
}

/** @returns {string|null} Path of the browser this process will drive. */
export function findBrowserBinary() {
    for (const candidate of BROWSER_CANDIDATES) {
        try {
            if (candidate && fs.existsSync(candidate)) return candidate;
        } catch { /* keep looking */ }
    }
    return null;
}

/**
 * Minimal CDP session: one page target, Runtime.evaluate with awaitPromise.
 * Deliberately small — the only thing needed is "run this fetch inside the
 * page that already passed Cloudflare".
 */
class CdpPage {
    constructor(ws, sessionId) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.nextId = 1;
        this.pending = new Map();
    }

    static async attach(wsUrl) {
        const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const page = new CdpPage(ws, null);
        ws.on('message', raw => page.onMessage(raw));
        return page;
    }

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
            else resolve(msg.result);
        }
    }

    send(method, params = {}, timeoutMs = 30_000) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (this.sessionId) payload.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, timeoutMs);
        }).catch(error => {
            throw error;
        });
    }

    async evaluate(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        }, timeoutMs);
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || 'page exception');
        }
        return result.result?.value;
    }

    close() {
        try {
            this.ws.close();
        } catch { /* already closed */ }
    }
}

/**
 * One browser + one parked page, per Glaze's proxy:
 * `_ensureStarted` → `_waitForPage` → `_rawFetch` (reload + retry once on a
 * challenge) → idle shutdown.
 */
export class JannyBrowser {
    /**
     * @param {{profileDir: string, chromePath?: string|null, headless?: boolean, logger?: {info: Function, warn: Function}}} options
     */
    constructor({ profileDir, chromePath = null, headless = false, logger = console }) {
        this.profileDir = profileDir;
        this.chromePath = chromePath;
        this.headless = headless;
        this.logger = logger;
        this.child = null;
        this.page = null;
        this.starting = null;
        this.gate = Promise.resolve();
        this.pending = 0;
        this.idleTimer = null;
        this.targets = new Map();
    }

    /** Serialize every request, exactly like Glaze's `_gate`. */
    enqueue(task) {
        this.pending++;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const run = this.gate.then(task).finally(() => {
            this.pending--;
            this.scheduleIdleShutdown();
        });
        this.gate = run.catch(() => {});
        return run;
    }

    scheduleIdleShutdown() {
        if (this.pending > 0) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.pending === 0) this.dispose().catch(() => {});
        }, IDLE_TTL_MS);
        this.idleTimer.unref?.();
    }

    /**
     * GET a jannyai.com URL from inside the parked page.
     * @param {string} url
     * @returns {Promise<{status: number, body: string, challenged: boolean}>}
     */
    fetchText(url) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let result = await this.rawFetch(url);
            if (result.challenged) {
                this.logger.warn?.("[Weaver's Vault] JannyAI: challenge on fetch — reloading session");
                await this.reload();
                result = await this.rawFetch(url);
            }
            return result;
        });
    }

    async rawFetch(url) {
        const expression = `(() => {
            return fetch(${JSON.stringify(url)}, {
                headers: { "Accept": "text/html,application/xhtml+xml,*/*" },
                credentials: "include",
            }).then(async r => ({
                status: r.status,
                body: await r.text(),
                challenged: r.headers.get("cf-mitigated") === "challenge",
            })).catch(e => ({ status: -1, body: String(e), challenged: false }));
        })()`;
        try {
            const value = await this.page.evaluate(expression, { timeoutMs: 40_000 });
            const status = Number(value?.status ?? -1);
            const body = String(value?.body ?? '');
            const challenged = value?.challenged === true
                || ((status === 403 || status === 503) && body.includes('window._cf_chl_opt'));
            return { status, body, challenged };
        } catch (error) {
            this.logger.warn?.(`[Weaver's Vault] JannyAI fetch failed: ${error.message}`);
            return { status: -1, body: String(error.message ?? error), challenged: false };
        }
    }

    async ensureStarted() {
        if (this.page) return;
        if (this.starting) return this.starting;
        this.starting = this.start().catch(error => {
            this.starting = null;
            throw error;
        });
        return this.starting;
    }

    async start() {
        const binary = this.chromePath ?? findBrowserBinary();
        if (!binary) {
            throw new JannyBrowserUnavailable(
                'No Chrome/Edge binary was found. Set `vaultJannyBrowserPath` (or JANNY_BROWSER_PATH) to one.',
            );
        }
        fs.mkdirSync(this.profileDir, { recursive: true });

        // A previous run can leave the browser holding the profile lock (a crash
        // skips dispose()). Chrome then refuses to start a second instance on the
        // same profile and the remote-debugging file is stale, so adopt the live
        // session when it still answers — the profile is ours and single-owner.
        const adopted = await this.adoptExisting();
        if (adopted) return;

        // Nothing answered, so any lock file left in the profile is stale — a
        // killed or crashed run. Chrome refuses to start while it is present and
        // exits silently, which used to look like "challenge never cleared".
        for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
            try {
                fs.rmSync(path.join(this.profileDir, name), { force: true, recursive: true });
            } catch { /* best effort */ }
        }

        const args = [
            '--remote-debugging-port=0',
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            // Offscreen but *headful*: Cloudflare rejects headless Chrome
            // (measured), and a real window is what Glaze's WebView2 provides.
            '--window-position=-32000,-32000',
            '--window-size=1280,900',
            ORIGIN,
        ];
        if (this.headless) args.splice(args.length - 1, 0, '--headless=new');

        this.child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
        let stderrTail = '';
        this.child.stderr?.on('data', chunk => {
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
        });
        let exited = null;
        this.child.on('exit', code => {
            exited = code;
            this.page?.close();
            this.page = null;
            this.child = null;
            this.starting = null;
        });

        const portFile = path.join(this.profileDir, 'DevToolsActivePort');
        const deadline = Date.now() + START_TIMEOUT_MS;
        let port = null;
        while (Date.now() < deadline) {
            if (fs.existsSync(portFile)) {
                const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
                port = Number(rawPort);
                if (port > 0) break;
            }
            await new Promise(r => setTimeout(r, 150));
        }
        if (!port) {
            const detail = exited !== null ? ` (browser exited with code ${exited}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''})` : '';
            throw new JannyBrowserUnavailable(`The browser did not expose a debugging port in time${detail}.`);
        }

        this.page = await this.attachToPage(port);
        if (!this.page) {
            throw new JannyBrowserUnavailable('The browser page could not be attached.');
        }
        const cleared = await this.waitForPage();
        if (!cleared) {
            throw new JannyBrowserUnavailable(
                'The Cloudflare challenge did not clear. Open the browser window once and solve it, then retry.',
            );
        }
    }

    /**
     * Reuse a browser already running on this profile (crash recovery).
     * @returns {Promise<boolean>} true when a session was adopted
     */
    async adoptExisting() {
        const portFile = path.join(this.profileDir, 'DevToolsActivePort');
        if (!fs.existsSync(portFile)) return false;
        const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
        const port = Number(rawPort);
        if (!(port > 0)) return false;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
            if (!response.ok) return false;
        } catch {
            return false;
        }
        const page = await this.attachToPage(port);
        if (!page) return false;
        this.page = page;
        // The adopted instance may still be mid-challenge; waitForPage covers it.
        await this.waitForPage();
        this.logger.info?.("[Weaver's Vault] JannyAI: adopted the running browser session");
        return true;
    }

    /**
     * Transcode an image to PNG inside the browser.
     *
     * jannyai's CDN answers WebP regardless of Accept headers — measured
     * 2026-11-23 — while a character card must be a PNG, and no image library is
     * installed. The bytes are fetched by Node (the CDN sends no CORS headers, so
     * an in-page fetch is refused) and handed over as a data: URL, which does not
     * taint the canvas, so the decode costs one round trip and no dependency.
     * @param {string} dataUrl e.g. `data:image/webp;base64,...`
     * @param {{maxEdge?: number}} [options] Downscale cap; a 1024² WebP becomes a
     *   ~1.4 MB PNG, which is wasteful for a card that syncs between devices.
     * @returns {Promise<Buffer|null>}
     */
    convertImageToPng(dataUrl, { maxEdge = 768 } = {}) { 
        return this.enqueue(async () => {
            await this.ensureStarted();
            const expression = `(async () => {
                try {
                    const image = new Image();
                    image.src = ${JSON.stringify(dataUrl)};
                    await image.decode();
                    const cap = ${Number(maxEdge) || 0};
                    const scale = cap > 0 ? Math.min(1, cap / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
                    const width = Math.max(1, Math.round(image.naturalWidth * scale));
                    const height = Math.max(1, Math.round(image.naturalHeight * scale));
                    const canvas = new OffscreenCanvas(width, height);
                    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
                    const png = await canvas.convertToBlob({ type: 'image/png' });
                    const bytes = new Uint8Array(await png.arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                    }
                    return { width, height, base64: btoa(binary) };
                } catch (error) {
                    return { error: String(error && error.message || error) };
                }
            })()`;
            try {
                const result = await this.page.evaluate(expression, { timeoutMs: 30_000 });
                if (!result?.base64) {
                    this.logger.warn?.(`[Weaver's Vault] JannyAI avatar conversion failed: ${result?.error ?? 'no data'}`);
                    return null;
                }
                const buffer = Buffer.from(result.base64, 'base64');
                if (buffer.length < 8 || buffer.subarray(1, 4).toString() !== 'PNG') {
                    this.logger.warn?.("[Weaver's Vault] JannyAI avatar conversion produced a non-PNG");
                    return null;
                }
                return buffer;
            } catch (error) {
                this.logger.warn?.(`[Weaver's Vault] JannyAI avatar conversion error: ${error.message}`);
                return null;
            }
        });
    }

    /** Find the page target that sits on jannyai.com and attach to it. */
    async attachToPage(port) {
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`);
                const targets = await response.json();
                const page = targets.find(t => t.type === 'page' && String(t.url).includes('jannyai.com'))
                    ?? targets.find(t => t.type === 'page');
                if (page?.webSocketDebuggerUrl) {
                    const session = await CdpPage.attach(page.webSocketDebuggerUrl);
                    await session.send('Runtime.enable').catch(() => {});
                    return session;
                }
            } catch { /* browser still booting */ }
            await new Promise(r => setTimeout(r, 200));
        }
        return null;
    }

    /**
     * Glaze's `_waitForPage`: poll until the document is real, not the
     * "Just a moment…" interstitial. Checking `window._cf_chl_opt` rather than
     * the cookie also returns at once when Cloudflare never challenged us.
     */
    async waitForPage(timeoutMs = CHALLENGE_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const ready = await this.page.evaluate(
                    'document.readyState === "complete" && !window._cf_chl_opt && location.hostname === "jannyai.com"',
                    { awaitPromise: false, timeoutMs: 5_000 },
                );
                if (ready === true) {
                    this.logger.info?.("[Weaver's Vault] JannyAI: browser session ready");
                    return true;
                }
            } catch { /* mid-navigation */ }
            await new Promise(r => setTimeout(r, 400));
        }
        this.logger.warn?.("[Weaver's Vault] JannyAI: challenge not cleared in time");
        return false;
    }

    /** Re-run the managed challenge from the origin (Glaze's `_reload`). */
    async reload() {
        if (!this.page) return;
        try {
            await this.page.evaluate('location.href = "https://jannyai.com/"', { awaitPromise: false, timeoutMs: 10_000 });
        } catch { /* navigation destroys the context */ }
        await new Promise(r => setTimeout(r, 800));
        await this.waitForPage();
    }

    async dispose() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.page?.close();
        this.page = null;
        this.starting = null;
        const child = this.child;
        this.child = null;
        if (child && !child.killed) {
            try {
                child.kill();
            } catch { /* already gone */ }
        }
    }

    /** Whether a session is currently up (no start attempt). */
    isRunning() {
        return Boolean(this.child && this.page);
    }
}

/**
 * One shared browser for the whole server, created lazily with the caller's
 * profile directory (mirrors Glaze's singleton proxy).
 * @type {JannyBrowser|null}
 */
let shared = null;

/**
 * @param {{profileDir: string, chromePath?: string|null, logger?: object}} options
 * @returns {JannyBrowser}
 */
export function getJannyBrowser({ profileDir, chromePath = null, logger = console }) {
    if (!shared || shared.profileDir !== profileDir) {
        shared = new JannyBrowser({ profileDir, chromePath, logger });
    }
    return shared;
}

export async function disposeJannyBrowser() {
    if (!shared) return;
    const browser = shared;
    shared = null;
    await browser.dispose();
}
