/**
 * Weaver's Vault — JanitorAI browser session.
 *
 * janitorai.com is an instance of the shared driver. Unlike jannyai.com there is
 * **no** Cloudflare managed challenge on `/hampter/*` (measured 2026-11-24: tags,
 * listing and detail all answered `200 application/json` anonymously), so this
 * session exists for two reasons only:
 *   1. sign-in — the account holds a cookie session (Google sign-in, no password
 *      ever touches us), and
 *   2. the `/generateAlpha` capture, which must run as the signed-in account in a
 *      real page.
 *
 * Signed-in state is read from `/hampter/profiles/mine` rather than from a
 * cookie name: the account is the thing the UI must report, and a stale cookie
 * proves nothing.
 */

import {
    disposeVaultBrowser,
    findBrowserBinary as findSharedBrowserBinary,
    getVaultBrowser,
    VaultBrowserUnavailable,
} from './weavers-vault-browser.js';
import { JANITOR_HOST, JANITOR_ORIGIN, janitorAccount } from './weavers-vault-janitor.js';

/** Everything that makes this source janitorai.com. */
const JANITOR = {
    host: JANITOR_HOST,
    origin: JANITOR_ORIGIN,
    label: 'JanitorAI',
    settingName: 'vaultJanitorBrowserPath',
    envName: 'JANITOR_BROWSER_PATH',
};

export { VaultBrowserUnavailable as JanitorBrowserUnavailable };

/**
 * @param {{envName?: string|null}} [options]
 * @returns {string|null}
 */
export function findBrowserBinary(options = {}) {
    return findSharedBrowserBinary({ envName: JANITOR.envName, ...options });
}

/**
 * @param {{profileDir: string, chromePath?: string|null, logger?: object}} options
 * @returns {import('./weavers-vault-browser.js').VaultBrowser}
 */
export function getJanitorBrowser({ profileDir, chromePath = null, logger = console }) {
    return getVaultBrowser('janitor', { ...JANITOR, profileDir, chromePath, logger });
}

export async function disposeJanitorBrowser() {
    await disposeVaultBrowser('janitor');
}

/**
 * Ask the signed-in account, from inside the page.
 *
 * Anonymous reads work on this site, so the *only* honest test of "signed in" is
 * the account endpoint: a 200 with an identity in it. Anything else — 401, a
 * challenge, a network failure — is reported as not signed in with the reason
 * attached, never guessed.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @returns {Promise<{signedIn: boolean, name: string, id: string, status: number, challenged: boolean}>}
 */
export async function readJanitorAccount(browser) {
    const result = await browser.fetchText(`${JANITOR_ORIGIN}hampter/profiles/mine`, {
        accept: 'application/json, text/plain, */*',
    });
    const signedOut = { signedIn: false, name: '', id: '', status: result.status, challenged: result.challenged };
    if (result.challenged || result.status !== 200) return signedOut;
    let payload = null;
    try {
        payload = JSON.parse(result.body);
    } catch {
        // A login wall that answers HTML with 200 is still a signed-out session.
        return signedOut;
    }
    const account = janitorAccount(payload);
    return { ...account, status: result.status, challenged: result.challenged };
}
