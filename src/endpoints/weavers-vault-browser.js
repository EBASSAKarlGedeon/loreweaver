/**
 * Weaver's Vault — one session per source: the request queue, the holds a human
 * step takes, and the idle teardown.
 *
 * The engine lives behind a backend (`weavers-vault-chrome-backend.js`: a real
 * Chromium over CDP). None of the policy below depends on who owns the browser,
 * which is the point of the split — Phase 1 of docs/EMBEDDED-ENGINE-PLAN.md. The
 * packaged app is Electron and ships its own Chromium, so the same vault has to
 * run on an engine we own while the routes keep seeing one `VaultBrowser`.
 *
 * Why a real browser at all: janitorai.com and jannyai.com sit behind a Cloudflare
 * managed challenge, and `cf_clearance` is bound to the TLS fingerprint of
 * whoever solved it — so replaying cookies from Node cannot work
 * (`403 cf-mitigated: challenge`, measured 2026-11-23). A real browser solves it
 * by loading the page, and a `fetch()` run inside that page keeps the same
 * fingerprint and cookie jar, so it passes.
 *
 * Same lifecycle as Glaze's proxy: `_ensureStarted` → `_waitForPage` →
 * `_rawFetch` (reload + retry once on a challenge) → idle shutdown.
 */

import path from 'node:path';
import { ChromeBackend } from './weavers-vault-chrome-backend.js';
import { VaultBrowserUnavailable } from './weavers-vault-browser-error.js';
import { resolveHeadlessMode } from './weavers-vault-headless-identity.js';

export { VaultBrowserUnavailable };
export { findBrowserBinary } from './weavers-vault-chrome-backend.js';

/**
 * How long an idle session keeps its parked browser alive.
 *
 * Was 30 s, which made every pause longer than half a minute pay for a fresh
 * browser start — spawn, port, attach, page load: ~10 s of wall time, on a
 * profile that has signed in with a window that briefly carries a taskbar
 * button (measured 2026-11-26). Ten minutes keeps a signed-in session warm
 * across a browsing session and still tears it down when the machine goes idle.
 *
 * Override with `VAULT_BROWSER_IDLE_TTL_MS` (milliseconds) while debugging, or
 * per session with the `idleTtlMs` option.
 */
export const IDLE_TTL_MS = 10 * 60_000;

/**
 * The idle TTL in force for one session.
 * @param {number|string|null} [override] explicit value (option or env)
 * @param {Record<string,string|undefined>} [env]
 * @returns {number} milliseconds, always positive
 */
export function resolveIdleTtl(override = null, env = process.env) {
    for (const value of [override, env?.VAULT_BROWSER_IDLE_TTL_MS]) {
        const ms = Number(value);
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return IDLE_TTL_MS;
}

/**
 * Whether a fetch answer is a check only a human can pass.
 *
 * `cf-mitigated` is Cloudflare's own word for a challenge. The second form is
 * the firewall's block page ("Access Restricted … blocked by our firewall"),
 * which is what a headless browser earns when its identity is wrong: it carries
 * no `cf-mitigated` and no `_cf_chl_opt`, so without this test it looks like an
 * ordinary 403 and would be retried forever (measured 2026-11-25).
 * @param {{status?: number, body?: string, challenged?: boolean}|null} result
 * @returns {boolean}
 */
export function needsHuman(result) {
    if (!result) return false;
    if (result.challenged === true) return true;
    return Number(result.status) === 403
        && /Access Restricted|blocked by our firewall/i.test(String(result.body ?? ''));
}

/**
 * Which engine backend drives a session.
 *
 * Phase 1 of the embedded-engine plan has exactly one implementation. Phase 2
 * adds `ElectronBackend`, and this becomes `process.versions.electron ? 'electron'
 * : 'chrome'` — that flag is the only reliable signal, because
 * `src/electron/index.js` imports the server in-process, so the packaged app's
 * server *is* an Electron main process.
 *
 * It answers 'chrome' until then, deliberately: the packaged app is Electron, and
 * answering 'electron' today would leave the desktop build with a backend that
 * does not exist yet.
 * @returns {'chrome'}
 */
export function selectBrowserBackendKind() {
    return 'chrome';
}

/**
 * Build the backend for this session.
 * @param {object} options see ChromeBackend
 * @returns {ChromeBackend}
 */
function createBackend(options) {
    const kind = selectBrowserBackendKind();
    if (kind === 'chrome') return new ChromeBackend(options);
    // An error, not a silent fallback: a session that quietly used the wrong
    // engine would hide exactly the behaviour the plan is trying to change.
    throw new VaultBrowserUnavailable(
        `The ${kind} browser backend is not implemented yet (embedded-engine plan, Phase 2).`,
    );
}

/**
 * One browser + one parked page, per Glaze's proxy:
 * `_ensureStarted` → `_waitForPage` → `_rawFetch` (reload + retry once on a
 * challenge) → idle shutdown.
 */
export class VaultBrowser {
    /**
     * @param {{profileDir: string, host: string, origin: string, label?: string,
     *   chromePath?: string|null, settingName?: string, envName?: string,
     *   headless?: boolean, idleTtlMs?: number|null,
     *   logger?: {info: Function, warn: Function}}} options
     *   `host` matches page targets and is asserted by `waitForPage`; `origin`
     *   is the URL the browser is parked on. Everything else is per-source only
     *   for messages.
     */
    constructor({ profileDir, host, origin, label = 'Vault', chromePath = null,
        settingName = 'vaultBrowserPath', envName = 'VAULT_BROWSER_PATH',
        headless = null, idleTtlMs = null, logger = console }) {
        if (!host || !origin) throw new Error('VaultBrowser needs a host and an origin');
        this.host = host;
        this.origin = origin;
        this.label = label;
        this.settingName = settingName;
        this.envName = envName;
        this.logger = logger;
        // Absolute from the start: a relative --user-data-dir makes the browser's
        // own command line relative too, which defeats profile reclaiming.
        this.profileDir = path.resolve(profileDir);
        this.starting = null;
        /** Serializes requests, exactly like Glaze's `_gate`. */
        this.gate = Promise.resolve();
        this.pending = 0;
        this.idleTimer = null;
        /** How long an idle session survives; see `IDLE_TTL_MS`. */
        this.idleTtlMs = resolveIdleTtl(idleTtlMs);
        // Off unless asked for; `VAULT_BROWSER_HEADLESS=1` turns it on and an
        // explicit `0` always wins. Headless needs no window, so it needs none of
        // the window hygiene; a human step escalates to a plain window instead.
        this.headless = resolveHeadlessMode(headless);
        /** Set once a human has been asked for a check; see `escalateForHuman`. */
        this.escalated = false;
        /** Epoch ms until which the idle teardown must not fire. */
        this.holdUntil = 0;
        /** A hold that only its own deadline can end (a human mid-form). */
        this.stickyHold = false;
        /** Identifiers of document-start scripts currently installed. */
        this.initScripts = [];
        /**
         * The engine: process, CDP page and window. A Chrome backend today; the
         * packaged app will run an Electron one (EMBEDDED-ENGINE-PLAN, Phase 2)
         * without a route changing.
         */
        this.backend = createBackend({
            profileDir: this.profileDir,
            host,
            origin,
            label,
            chromePath,
            settingName,
            envName,
            headless: this.headless,
            logger,
            // The engine must ask the session who owns the window: adoption and
            // reveal park only what no human is looking at.
            isHeld: () => this.isHeld(),
            // A crashing browser must clear the start latch, or the next
            // ensureStarted() would await a promise for a page that is gone.
            onExit: () => { this.starting = null; },
        });
    }

    /** The page the backend is attached to; null until the first start. */
    get page() {
        return this.backend.page;
    }

    /**
     * Keep the session alive for a human step.
     *
     * A normal hold is cancelled by `release()`, which is what the sign-in flow
     * wants: hold while the login page is up, release once it worked. A *sticky*
     * hold lasts until its own deadline no matter what other requests say — a form
     * a human is filling must not close because a status poll called `release()`
     * (measured: `/janitor/account` did exactly that and killed the window 30 s
     * after the persona wall was shown).
     * @param {number} ttlMs
     * @param {{sticky?: boolean}} options
     */
    hold(ttlMs = 15 * 60_000, { sticky = false } = {}) {
        this.holdUntil = Date.now() + Math.max(1_000, Number(ttlMs) || 0);
        this.stickyHold = Boolean(sticky);
        this.scheduleIdleShutdown();
    }

    /** Give the session back to the idle teardown. */
    release() {
        // A sticky hold belongs to a human mid-task; only its deadline ends it.
        if (this.stickyHold && Date.now() < this.holdUntil) return;
        this.holdUntil = 0;
        this.stickyHold = false;
        // The human step is done, so the window goes back offscreen; otherwise a
        // signed-in session leaves a normal window on the desktop.
        this.backend.park().catch(() => {});
        this.scheduleIdleShutdown();
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
        const held = Math.max(0, this.holdUntil - Date.now());
        this.idleTimer = setTimeout(() => {
            if (this.pending !== 0) return;
            // A hold that expired while this timer ran is no hold at all.
            if (this.holdUntil > Date.now()) {
                this.scheduleIdleShutdown();
                return;
            }
            this.dispose().catch(() => {});
        }, this.idleTtlMs + held);
        this.idleTimer.unref?.();
    }

    /**
     * GET a URL from inside the parked page.
     * @param {string} url
     * @param {{accept?: string, timeoutMs?: number, headers?: Record<string,string>|null}} [options]
     *   `accept` must be the type the endpoint serves: JanitorAI's API is JSON;
     *   `headers` carries an Authorization bearer when the source needs one.
     * @returns {Promise<{status: number, body: string, challenged: boolean}>}
     */
    fetchText(url, { accept = 'text/html,application/xhtml+xml,*/*', timeoutMs = 40_000, headers = null } = {}) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let result = await this.rawFetch(url, { accept, timeoutMs, headers });
            if (result.challenged) {
                this.logger.warn?.(`[Weaver's Vault] ${this.label}: challenge on fetch — reloading session`);
                await this.reload();
                result = await this.rawFetch(url, { accept, timeoutMs, headers });
            }
            // A headless session cannot pass a check that wants a person, so ask
            // for one instead of failing the request: escalation opens a normal
            // window on the same profile, waits for it to close, and brings the
            // headless session back (see ChromeBackend#escalateToSignIn).
            if (this.headless && needsHuman(result) && await this.escalateForHuman()) {
                result = await this.rawFetch(url, { accept, timeoutMs, headers });
            }
            return result;
        });
    }

    /**
     * Install a script that runs before any page script, on every navigation.
     *
     * `Page.addScriptToEvaluateOnNewDocument` is the only way to hook `fetch`
     * before the site's own bundle keeps a reference to it — installing it after
     * load is too late for the JanitorAI capture, which wraps the network calls
     * that produce the assembled prompt.
     * @param {string} source
     * @returns {Promise<string|null>} the identifier to remove it again
     */
    async addInitScript(source) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            // `Page.enable` first, and this is not decoration: without it the call
            // below returns an identifier and the script is never applied, so the
            // page silently has none of our functions (measured — the same call
            // with Page.enable defined __glazeSend, without it nothing existed).
            await this.page.send('Page.enable', {}, 15_000);
            // `send` lives on the page connection; the session has no such method
            // (the same mistake as `browser.evaluate`, see PITFALLS #15).
            const result = await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source }, 15_000);
            const identifier = result?.identifier ?? null;
            if (!this.initScripts) this.initScripts = [];
            if (identifier) this.initScripts.push(identifier);
            return identifier;
        });
    }

    /** Remove every script installed by `addInitScript`. */
    async clearInitScripts() {
        const identifiers = Array.isArray(this.initScripts) ? [...this.initScripts] : [];
        this.initScripts = [];
        for (const identifier of identifiers) {
            try {
                await this.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, 10_000);
            } catch { /* the page may be gone */ }
        }
        return identifiers.length;
    }

    /**
     * Run an expression in the parked page.
     *
     * Queued like a fetch, so it never races a navigation, and it starts the
     * session if needed. `evaluate` itself lives on the page connection, not on
     * this class — reaching for `browser.evaluate` is a mistake this method
     * exists to prevent (it failed with "browser.evaluate is not a function").
     * @param {string} expression
     * @param {{timeoutMs?: number}} [options]
     * @returns {Promise<unknown>}
     */
    evaluateInPage(expression, { timeoutMs = 30_000 } = {}) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            return this.page.evaluate(expression, { timeoutMs });
        });
    }

    async rawFetch(url, { accept = 'text/html,application/xhtml+xml,*/*', timeoutMs = 40_000, headers = null } = {}) {
        // JanitorAI's API ignores cookies and wants the Supabase session as a
        // bearer token (measured: 401 with cookies, 200 with the same header), so
        // callers must be able to add headers.
        const extra = headers && typeof headers === 'object' ? headers : {};
        const expression = `(() => {
            return fetch(${JSON.stringify(url)}, {
                headers: Object.assign({ "Accept": ${JSON.stringify(accept)} }, ${JSON.stringify(extra)}),
                credentials: "include",
            }).then(async r => ({
                status: r.status,
                body: await r.text(),
                challenged: r.headers.get("cf-mitigated") === "challenge",
            })).catch(e => ({ status: -1, body: String(e), challenged: false }));
        })()`;
        try {
            const value = await this.page.evaluate(expression, { timeoutMs });
            const status = Number(value?.status ?? -1);
            const body = String(value?.body ?? '');
            const challenged = value?.challenged === true
                || ((status === 403 || status === 503) && body.includes('window._cf_chl_opt'));
            return { status, body, challenged };
        } catch (error) {
            this.logger.warn?.(`[Weaver's Vault] ${this.label} fetch failed: ${error.message}`);
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

    /**
     * Bring the browser to the screen so a human can finish a check by hand.
     * @returns {Promise<{revealed: number, running: boolean}>}
     */
    async reveal() {
        await this.ensureStarted();
        // A revealed window belongs to a human step, and an unheld window is
        // closed by the 30 s idle teardown — that is the "window appears and is
        // gone after about 30 seconds" report. Give the step its own budget:
        // `release()` ends it early when the step works, and the engine parks the
        // window again afterwards.
        if (!this.isHeld()) this.hold(3 * 60_000);
        return this.backend.reveal();
    }

    /**
     * Ask a human to pass whatever check blocks a headless session.
     *
     * Once per session: a second escalation inside the same session would put a
     * window in front of someone for a check they just passed, and a loop here
     * would be a window that never closes.
     * @returns {Promise<boolean>} whether a window was shown
     */
    async escalateForHuman() {
        if (!this.headless || this.escalated) return false;
        this.escalated = true;
        this.logger.warn?.(`[Weaver's Vault] ${this.label}: a check needs a person — opening a window for it`);
        try {
            await this.reveal();
            return true;
        } catch (error) {
            this.logger.warn?.(`[Weaver's Vault] ${this.label}: could not open the window: ${error.message}`);
            return false;
        }
    }

    /**
     * Transcode an image to PNG inside the browser.
     *
     * Some source CDNs answer WebP regardless of Accept headers (jannyai's did,
     * measured 2026-11-23) while a character card must be a PNG, and no image
     * library is
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
                    this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion failed: ${result?.error ?? 'no data'}`);
                    return null;
                }
                const buffer = Buffer.from(result.base64, 'base64');
                if (buffer.length < 8 || buffer.subarray(1, 4).toString() !== 'PNG') {
                    this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion produced a non-PNG`);
                    return null;
                }
                return buffer;
            } catch (error) {
                this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion error: ${error.message}`);
                return null;
            }
        });
    }

    /**
     * Move the parked page to another URL on the same origin and wait for it.
     * Used by the sign-in flow (the browser is parked on the origin, sign-in
     * lives at `/login`).
     * @param {string} url
     * @returns {Promise<boolean>} whether the page became ready
     */
    async navigate(url) {
        await this.enqueue(async () => {
            await this.ensureStarted();
            try {
                await this.page.evaluate(`location.href = ${JSON.stringify(url)}`, { awaitPromise: false, timeoutMs: 10_000 });
            } catch { /* navigation destroys the context */ }
            await new Promise(r => setTimeout(r, 800));
            await this.waitForPage();
        });
        return Boolean(this.page);
    }

    /**
     * A PNG of what the page currently shows, base64.
     *
     * Diagnostics only: when a capture fails, the page is the evidence. Screenshots
     * of the desktop are useless here (other windows cover ours), so this goes
     * through CDP.
     * @returns {Promise<string>}
     */
    screenshot() {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const result = await this.page.send('Page.captureScreenshot', { format: 'png' }, 30_000);
            return String(result?.data ?? '');
        });
    }

    /**
     * A real mouse click at viewport coordinates.
     *
     * `Input.dispatchMouseEvent` produces *trusted* events, which is the whole
     * point: the ported WebView script has to fake a click with `element.click()`
     * and type with a React setter trick, and JanitorAI's editor ignores both —
     * the composer kept the text and the Send button stayed disabled. CDP can do
     * what a WebView cannot.
     * @param {number} x
     * @param {number} y
     */
    clickPoint(x, y) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const point = { x: Math.round(Number(x)), y: Math.round(Number(y)), button: 'left', clickCount: 1 };
            await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, 15_000);
            await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, 15_000);
            return true;
        });
    }

    /**
     * Type text into the focused element as a trusted insertion.
     * @param {string} text
     */
    insertText(text) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            await this.page.send('Input.insertText', { text: String(text ?? '') }, 30_000);
            return true;
        });
    }

    /**
     * A trusted key press (Enter/Escape), with the key codes legacy handlers read.
     * @param {{key: string, code?: string, windowsVirtualKeyCode?: number, text?: string}} options
     */
    pressKey({ key, code = null, windowsVirtualKeyCode = null, text = '' }) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const base = {
                key,
                code: code ?? key,
                windowsVirtualKeyCode: windowsVirtualKeyCode ?? null,
                nativeVirtualKeyCode: windowsVirtualKeyCode ?? null,
            };
            await this.page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text }, 15_000);
            await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 15_000);
            return true;
        });
    }

    /**
     * Forget everything the site stored for one origin: cookies and web storage.
     *
     * Signing out of a site is not just "delete the cookie": JanitorAI keeps the
     * Supabase session in chunked cookies *and* a large persisted store in
     * `localStorage`, and a stale store survives a cookie wipe. Clearing the
     * origin's storage as well is what makes a genuine account switch possible
     * without throwing away the whole Chrome profile.
     * @param {string} origin e.g. `https://janitorai.com`
     * @returns {Promise<{cookies: boolean, storage: boolean}>}
     */
    async clearOriginSession(origin) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let cookies = false;
            let storage = false;
            try {
                await this.page.send('Network.clearBrowserCookies', {}, 15_000);
                cookies = true;
            } catch { /* reported below */ }
            try {
                await this.page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }, 15_000);
                storage = true;
            } catch { /* reported below */ }
            return { cookies, storage };
        });
    }

    /**
     * Reload the page that is currently loaded.
     *
     * Distinct from `reload()`, which navigates to the *origin* to re-run a Cloudflare
     * challenge. The capture needs this one: JanitorAI caches the selected proxy
     * preset in its client store, so a chat is loaded twice — and reloading it to
     * the origin instead silently replaced the chat with the home page, which is
     * how "composer never appeared" happened with a page that had no composer in
     * it at all.
     * @returns {Promise<boolean>}
     */
    async reloadPage() {
        await this.enqueue(async () => {
            await this.ensureStarted();
            try {
                await this.page.send('Page.reload', {}, 15_000);
            } catch { /* a reload destroys the context by design */ }
            await new Promise(r => setTimeout(r, 800));
            await this.waitForPage();
        });
        return Boolean(this.page);
    }

    /** Re-run the managed challenge from the origin (Glaze's `_reload`). */
    async reload() {
        if (!this.page) return;
        try {
            await this.page.evaluate(`location.href = ${JSON.stringify(this.origin)}`, { awaitPromise: false, timeoutMs: 10_000 });
        } catch { /* navigation destroys the context */ }
        await new Promise(r => setTimeout(r, 800));
        await this.waitForPage();
    }

    /** Whether a human step currently owns the window. */
    isHeld() {
        return Boolean(this.holdUntil) && Date.now() < this.holdUntil;
    }

    /**
     * Wait until the parked page is the real document, not Cloudflare's
     * interstitial. The engine owns the poll because it owns the profile's
     * warm/cold budget and the marker file that records a past solve.
     * @param {number|null} [timeoutMs]
     * @returns {Promise<boolean>}
     */
    async waitForPage(timeoutMs = null) {
        return this.backend.waitForPage(timeoutMs);
    }

    /**
     * Raise the page and tell it that it is focused. `waitForPage()` re-asserts
     * this while it waits; what "focused" costs is the backend's business.
     * @param {object} [session]
     */
    async focusPage(session = this.page) {
        return this.backend.focusPage(session);
    }

    /** Start the engine. `ensureStarted()` is what guards re-entry. */
    async start() {
        await this.backend.start();
    }

    /**
     * Tear the session down: the idle timer, the holds, then the engine itself.
     * A killed browser marks its profile as crashed, so the backend closes it
     * politely first and repairs the exit state (see ChromeBackend#dispose).
     */
    async dispose() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.starting = null;
        this.holdUntil = 0;
        this.stickyHold = false;
        await this.backend.dispose();
    }

    /** Whether a session is currently up (no start attempt). */
    isRunning() {
        return this.backend.isRunning();
    }
}

/**
 * One browser per source key, created lazily with the caller's profile directory
 * (mirrors Glaze's singleton proxy, but keyed so two sources cannot evict each
 * other).
 * @type {Map<string, VaultBrowser>}
 */
const sessions = new Map();

/**
 * @param {string} key source key, e.g. `'janny'`
 * @param {{profileDir: string, host: string, origin: string, label?: string,
 *   chromePath?: string|null, settingName?: string, envName?: string,
 *   logger?: object}} options
 * @returns {VaultBrowser}
 */
export function getVaultBrowser(key, options) {
    const existing = sessions.get(key);
    if (existing && existing.profileDir === options.profileDir) return existing;
    if (existing) {
        // A different profile means the old instance can never be reused; left
        // running it would hold the old profile's lock and keep a window alive.
        sessions.delete(key);
        existing.dispose().catch(() => {});
    }
    const browser = new VaultBrowser(options);
    sessions.set(key, browser);
    return browser;
}

/**
 * @param {string|null} key source key, or null to dispose every session
 */
export async function disposeVaultBrowser(key = null) {
    const keys = key ? [key] : [...sessions.keys()];
    const pending = [];
    for (const k of keys) {
        const browser = sessions.get(k);
        if (!browser) continue;
        sessions.delete(k);
        pending.push(browser.dispose());
    }
    await Promise.all(pending);
}
