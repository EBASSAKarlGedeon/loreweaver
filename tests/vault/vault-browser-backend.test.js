import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    IDLE_TTL_MS,
    VaultBrowser,
    VaultBrowserUnavailable,
    disposeVaultBrowser,
    findBrowserBinary,
    getVaultBrowser,
    needsHuman,
    resolveIdleTtl,
    selectBrowserBackendKind,
} from '../../src/endpoints/weavers-vault-browser.js';
import { ChromeBackend } from '../../src/endpoints/weavers-vault-chrome-backend.js';

/**
 * Phase 1 of docs/EMBEDDED-ENGINE-PLAN.md split the vault browser in two: the
 * policy half (`VaultBrowser`: queue, holds, idle teardown) and the engine half
 * (`ChromeBackend`: process, page, window). The point of the split is that a
 * second engine can be dropped in without a route learning about it, so these
 * tests pin the seam rather than the Chrome internals:
 *
 *  - the module still exports exactly what the janitor/janny modules import;
 *  - a session is built with a backend but starts nothing on construction;
 *  - every route-visible method survives the split;
 *  - the policy methods still do their job through the backend.
 *
 * Nothing here spawns a browser: a backend is replaced with a stub, which is
 * only possible because the session talks to it and not to a child process.
 */

const OPTIONS = {
    profileDir: 'C:/tmp/loreweaver-vault-backend-test',
    host: 'janitorai.com',
    origin: 'https://janitorai.com/',
    label: 'Test',
};

/** Clear the idle timer a hold or release schedules. */
function disarm(browser) {
    if (browser.idleTimer) {
        clearTimeout(browser.idleTimer);
        browser.idleTimer = null;
    }
}

describe('backend selection', () => {
    test('stays on the external Chrome until the embedded backend exists', () => {
        // The packaged app is Electron, so `process.versions.electron` is truthy
        // there. Answering 'electron' before Phase 2 would leave the desktop build
        // with a backend that does not exist, i.e. no vault at all.
        expect(selectBrowserBackendKind()).toBe('chrome');
    });

    test('a session is built with a backend but starts nothing', () => {
        const browser = new VaultBrowser(OPTIONS);
        expect(browser.backend).toBeInstanceOf(ChromeBackend);
        expect(browser.page).toBeNull();
        expect(browser.isRunning()).toBe(false);
        expect(browser.backend.child).toBeNull();
        // The engine resolves the profile once, so reusing a session compares
        // like with like (a relative path would defeat profile reclaiming).
        expect(browser.profileDir).toBe(browser.backend.profileDir);
    });
});

describe('public surface', () => {
    test('keeps every method the routes call', () => {
        const browser = new VaultBrowser(OPTIONS);
        const methods = [
            'evaluateInPage', 'fetchText', 'navigate', 'convertImageToPng',
            'reload', 'reloadPage', 'clearOriginSession', 'addInitScript',
            'clearInitScripts', 'screenshot', 'clickPoint', 'insertText',
            'pressKey', 'hold', 'release', 'reveal', 'dispose', 'isRunning',
        ];
        for (const name of methods) expect(typeof browser[name]).toBe('function');
        expect(typeof browser.waitForPage).toBe('function');
        expect(typeof browser.focusPage).toBe('function');
        expect(typeof browser.start).toBe('function');
    });

    test('keeps the module exports the other sources import', () => {
        expect(typeof getVaultBrowser).toBe('function');
        expect(typeof disposeVaultBrowser).toBe('function');
        expect(typeof findBrowserBinary).toBe('function');
        expect(new VaultBrowserUnavailable('x')).toBeInstanceOf(Error);
        expect(new VaultBrowserUnavailable('x').name).toBe('VaultBrowserUnavailable');
    });

    test('resolves a browser binary outside a live session', () => {
        // Reads the module-level candidate list, so a binding left behind by a
        // future move fails here instead of at the first request (PITFALLS #39).
        const found = findBrowserBinary({ envName: 'VAULT_BROWSER_PATH_UNSET_IN_TEST' });
        expect(found === null || typeof found === 'string').toBe(true);
    });
});

describe('policy through the backend', () => {
    test('reveal takes a hold and hands the window to the engine', async () => {
        const browser = new VaultBrowser(OPTIONS);
        let asked = 0;
        browser.ensureStarted = async () => {};
        browser.backend = {
            reveal: async () => {
                asked += 1;
                return { revealed: 1, raised: true, running: true };
            },
        };
        const result = await browser.reveal();
        expect(result.revealed).toBe(1);
        expect(asked).toBe(1);
        // Without its own hold the 30 s idle teardown would close the window the
        // user is looking at (PITFALLS #35).
        expect(browser.isHeld()).toBe(true);
        disarm(browser);
    });

    test('release parks the engine window again', async () => {
        const browser = new VaultBrowser(OPTIONS);
        let parked = 0;
        browser.backend = { park: async () => { parked += 1; } };
        browser.hold(60_000);
        browser.release();
        expect(parked).toBe(1);
        expect(browser.isHeld()).toBe(false);
        disarm(browser);
    });

    test('a sticky hold survives a release from a status poll', () => {
        const browser = new VaultBrowser(OPTIONS);
        let parked = 0;
        browser.backend = { park: async () => { parked += 1; } };
        browser.hold(60_000, { sticky: true });
        browser.release();
        expect(parked).toBe(0);
        expect(browser.isHeld()).toBe(true);
        disarm(browser);
    });

    test('dispose clears the session and tears the engine down once', async () => {
        const browser = new VaultBrowser(OPTIONS);
        let disposed = 0;
        browser.backend = { dispose: async () => { disposed += 1; } };
        browser.hold(60_000, { sticky: true });
        await browser.dispose();
        expect(disposed).toBe(1);
        expect(browser.isHeld()).toBe(false);
        expect(browser.idleTimer).toBeNull();
    });
});

describe('idle teardown', () => {
    test('keeps a parked browser for ten minutes, not thirty seconds', () => {
        // Thirty seconds meant every pause paid for a fresh ~10 s start (and a
        // window that briefly carried a taskbar button) only to close the browser
        // again half a minute later.
        expect(IDLE_TTL_MS).toBe(10 * 60_000);
        expect(new VaultBrowser(OPTIONS).idleTtlMs).toBe(IDLE_TTL_MS);
    });

    test('accepts an explicit TTL or the environment override', () => {
        expect(new VaultBrowser({ ...OPTIONS, idleTtlMs: 1234 }).idleTtlMs).toBe(1234);
        expect(resolveIdleTtl(null, { VAULT_BROWSER_IDLE_TTL_MS: '2500' })).toBe(2500);
        expect(resolveIdleTtl('500', {})).toBe(500);
        // Junk and non-positive values must fall back, never schedule no teardown
        // (a 0 ms timer would close the browser while a request uses it).
        expect(resolveIdleTtl('nope', {})).toBe(IDLE_TTL_MS);
        expect(resolveIdleTtl(0, {})).toBe(IDLE_TTL_MS);
        expect(resolveIdleTtl(-1, {})).toBe(IDLE_TTL_MS);
    });

    test('the scheduled teardown uses the session TTL', () => {
        const browser = new VaultBrowser({ ...OPTIONS, idleTtlMs: 5_000 });
        const spy = jest.spyOn(global, 'setTimeout');
        browser.scheduleIdleShutdown();
        const delays = spy.mock.calls.map(call => call[1]);
        expect(delays).toContain(5_000);
        spy.mockRestore();
        disarm(browser);
    });
});

describe('window hygiene', () => {
    /** A backend whose only real step is the order of its own calls. */
    function stubBackend(overrides = {}) {
        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe' });
        const calls = [];
        backend.adoptExisting = async () => false;
        backend.prepareProfile = async () => { calls.push('prepare'); };
        backend.launch = async () => { calls.push('launch'); };
        backend.hideWindow = async () => { calls.push('hide'); };
        backend.park = async () => { calls.push('park'); };
        backend.waitForPage = async () => { calls.push('wait'); return true; };
        backend.dispose = async () => { calls.push('dispose'); };
        Object.assign(backend, overrides);
        return { backend, calls };
    }

    test('start parks the window before the challenge wait, and again after it', async () => {
        const { backend, calls } = stubBackend();
        await backend.start();
        // waitForPage() can spend the whole two-minute challenge budget; parking
        // after it left the window where Chrome restored its placement, on screen,
        // for the entire wait (measured 2026-11-26). The trailing hide+park is the
        // safety net for a window Chrome creates late.
        expect(calls).toEqual(['prepare', 'launch', 'hide', 'park', 'wait', 'hide', 'park']);
    });

    test('a challenge that never clears disposes instead of keeping the window', async () => {
        const { backend, calls } = stubBackend({ waitForPage: async () => false });
        await expect(backend.start()).rejects.toBeInstanceOf(VaultBrowserUnavailable);
        expect(calls).toContain('dispose');
        expect(calls[calls.length - 1]).toBe('dispose');
    });

    test('a headless reveal hands the profile to a plain window instead', async () => {
        // There is no window to place, so the only honest way to let a human sign
        // in is a separate browser on the same profile (`escalateToSignIn`).

        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe', headless: true });
        const calls = [];
        backend.escalateToSignIn = async () => { calls.push('escalate'); return { revealed: 1, escalated: true, running: true }; };
        backend.placeWindowOnScreen = async () => { calls.push('place'); return true; };
        backend.nudgeWindowSize = async () => { calls.push('nudge'); };

        const result = await backend.reveal();

        expect(calls).toEqual(['escalate']);
        expect(result.escalated).toBe(true);
    });

    test('the taskbar watcher is stopped before a human needs the window', () => {
        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe' });
        const killed = [];
        backend.taskbarWatch = { kill: () => killed.push('kill') };
        backend.stopTaskbarWatch();
        expect(killed).toEqual(['kill']);
        expect(backend.taskbarWatch).toBeNull();
        // Idempotent: dispose() and reveal() both call it.
        backend.stopTaskbarWatch();
        expect(killed).toEqual(['kill']);
    });
});

/** A session whose browser is faked: the point is what the policy does. */
function blockedSession({ headless = true, answers = [] } = {}) {
    const browser = new VaultBrowser({ ...OPTIONS, headless });
    const calls = [];
    const queue = [...answers];
    browser.backend = {
        page: {},
        start: async () => {},
        reveal: async () => { calls.push('reveal'); return { revealed: 1, escalated: true }; },
        isRunning: () => true,
    };
    browser.rawFetch = async () => queue.shift();
    browser.reload = async () => { calls.push('reload'); };
    return { browser, calls };
}

describe('a headless session that is blocked', () => {
    test('a firewall block page asks for a human, then retries once', async () => {
        // Measured 2026-11-25: the block carries no cf-mitigated and no
        // _cf_chl_opt, so it must be recognised from its body — otherwise it looks
        // like an ordinary 403 and the request just fails.
        const block = { status: 403, body: '<title>Access Restricted</title>This request was blocked by our firewall', challenged: false };
        const ok = { status: 200, body: 'fine', challenged: false };
        const { browser, calls } = blockedSession({ answers: [block, ok] });

        const result = await browser.fetchText('https://janitorai.com/');

        expect(calls).toEqual(['reveal']);
        expect(result).toEqual(ok);
        disarm(browser);
    });

    test('a challenge asks for a human after the reload fails to clear it', async () => {
        const challenge = { status: 403, body: 'window._cf_chl_opt', challenged: true };
        const ok = { status: 200, body: 'fine', challenged: false };
        const { browser, calls } = blockedSession({ answers: [challenge, challenge, ok] });

        const result = await browser.fetchText('https://janitorai.com/api');

        expect(calls).toEqual(['reload', 'reveal']);
        expect(result.status).toBe(200);
        disarm(browser);
    });

    test('the human is asked once per session, not once per request', async () => {
        const block = { status: 403, body: 'blocked by our firewall', challenged: false };
        const { browser, calls } = blockedSession({ answers: [block, block, block] });

        await browser.fetchText('https://janitorai.com/a');
        await browser.fetchText('https://janitorai.com/b');

        expect(calls).toEqual(['reveal']);
        disarm(browser);
    });

    test('a headful session never opens a window by itself', async () => {
        const block = { status: 403, body: 'blocked by our firewall', challenged: false };
        const { browser, calls } = blockedSession({ headless: false, answers: [block] });

        const result = await browser.fetchText('https://janitorai.com/');

        expect(calls).toEqual([]);
        expect(result.status).toBe(403);
        disarm(browser);
    });

    test('needsHuman separates a block page from an ordinary 403', () => {
        expect(needsHuman({ status: 403, body: 'Access Restricted', challenged: false })).toBe(true);
        expect(needsHuman({ status: 403, body: 'blocked by our firewall', challenged: false })).toBe(true);
        expect(needsHuman({ status: 403, body: 'not signed in', challenged: false })).toBe(false);
        expect(needsHuman({ status: 200, body: 'ok', challenged: false })).toBe(false);
        expect(needsHuman({ status: 403, body: '', challenged: true })).toBe(true);
        expect(needsHuman(null)).toBe(false);
    });
});

describe('headless mode', () => {
    test('a headless start has no window to style, place or park', async () => {
        // The measured identity comes first (it needs the profile), then the
        // launch, then the override — the override has to land before the page
        // loads anything from the site, or the firewall sees these very requests.
        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe', headless: true });
        const calls = [];
        backend.startTaskbarWatch = () => { calls.push('watch'); return null; };
        backend.ensureIdentity = async () => { calls.push('identity'); };
        backend.adoptExisting = async () => false;
        backend.prepareProfile = async () => { calls.push('prepare'); };
        backend.launch = async () => { calls.push('launch'); };
        backend.applyHeadlessIdentity = async () => { calls.push('apply'); return true; };
        backend.hideWindow = async () => { calls.push('hide'); };
        backend.park = async () => { calls.push('park'); };
        backend.waitForPage = async () => { calls.push('wait'); return true; };

        await backend.start();

        expect(calls).toEqual(['identity', 'prepare', 'launch', 'apply', 'wait']);
    });

    test('a headless challenge that never clears disposes and names the escape hatch', async () => {
        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe', headless: true });
        const calls = [];
        backend.ensureIdentity = async () => {};
        backend.adoptExisting = async () => false;
        backend.prepareProfile = async () => {};
        backend.launch = async () => { calls.push('launch'); };
        backend.applyHeadlessIdentity = async () => true;
        backend.waitForPage = async () => false;
        backend.dispose = async () => { calls.push('dispose'); };

        const attempt = backend.start();
        await expect(attempt).rejects.toBeInstanceOf(VaultBrowserUnavailable);
        await expect(attempt).rejects.toThrow('VAULT_BROWSER_HEADLESS=0');
        expect(calls).toEqual(['launch', 'dispose']);
    });

    test('a headless launch asks for headless and no window placement', () => {
        const headless = new ChromeBackend({ ...OPTIONS, headless: true });
        const args = headless.launchArgs();
        expect(args).toContain('--headless=new');
        expect(args.some(arg => arg.startsWith('--window-position'))).toBe(false);
        expect(args.some(arg => arg.startsWith('--window-size'))).toBe(false);
        expect(args).toContain('--remote-debugging-port=0');
        expect(args[args.length - 1]).toBe(OPTIONS.origin);

        const headful = new ChromeBackend({ ...OPTIONS });
        expect(headful.launchArgs()).toContain('--window-position=-32000,-32000');
        expect(headful.launchArgs()).not.toContain('--headless=new');
    });

    test('a debugging-port file that is still being written does not fail a start', async () => {
        // Measured 2026-11-25: Chrome creates DevToolsActivePort and keeps it locked
        // for a moment, and reading it then threw EBUSY straight out of start().
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-port-'));
        const backend = new ChromeBackend({ ...OPTIONS, profileDir: dir });
        fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/x');
        const real = fs.readFileSync;
        let calls = 0;
        const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
            if (String(file).endsWith('DevToolsActivePort') && calls++ === 0) {
                throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
            }
            return real(file, ...rest);
        });
        try {
            expect(await backend.waitForPort(dir, { timeoutMs: 3_000 })).toBe(9333);
        } finally {
            spy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('no usable identity means no headless start, not a guess', async () => {
        // The failure this prevents is measured: a self-describing headless UA got
        // a 403 firewall block that no challenge handling recovers from. A guess
        // about the screen size would be a different fingerprint, not a fix.
        const backend = new ChromeBackend({ ...OPTIONS, chromePath: 'C:/fake/chrome.exe', headless: true });
        backend.startTaskbarWatch = () => null;
        backend.waitForPort = async () => 9222;
        backend.attachToPage = async () => ({
            evaluate: async () => ({ userAgent: 'HeadlessChrome/158.0.0.0', uaData: { brands: [] } }),
            send: async () => ({ product: 'HeadlessChrome/158.0.0.0' }),
            close: () => {},
        });

        await expect(backend.measureIdentity('C:/fake/chrome.exe')).rejects.toBeInstanceOf(VaultBrowserUnavailable);
        // Nothing was cached, so the next attempt measures again instead of running
        // on a half-usable identity.
        expect(backend.identity).toBeNull();
        expect(backend.headless).toBe(true);
    });
});
