import { describe, test, expect, jest } from '@jest/globals';
import {
    IDLE_TTL_MS,
    VaultBrowser,
    VaultBrowserUnavailable,
    disposeVaultBrowser,
    findBrowserBinary,
    getVaultBrowser,
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
