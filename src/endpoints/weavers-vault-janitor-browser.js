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
 *
 * Measured 2026-11-24, signed in as a real account: that endpoint answers 401 to
 * a cookie-only request from inside the page — the site ignores its cookies and
 * authenticates with the Supabase session's access token as
 * `Authorization: Bearer …`. Adding that header to the very same request returns
 * 200 with the profile. The token is not in `localStorage`; it lives in the
 * chunked `sb-<ref>-auth-token.0`, `.1`, … cookies, so it is decoded here.
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
 * The Supabase session the site keeps in its own cookies.
 *
 * Supabase splits a large session across `sb-<ref>-auth-token.N` cookies, and
 * writes either raw JSON or `base64-` + base64url JSON. Both forms occur in the
 * wild (this profile had the chunked raw form, 3 180 + 1 763 bytes), so both are
 * accepted rather than assuming one.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @returns {Promise<{token: string, expiresAt: number, name: string, problem: string}>}
 */
export async function readJanitorSession(browser) {
    const expression = `(() => {
        const chunks = [];
        for (const pair of document.cookie.split('; ')) {
            const index = pair.indexOf('=');
            if (index < 0) continue;
            const name = pair.slice(0, index);
            if (name.startsWith('sb-') && name.includes('-auth-token.')) {
                chunks.push([Number(name.split('.').pop()) || 0, pair.slice(index + 1)]);
            }
        }
        if (!chunks.length) return { problem: 'no sb-auth-token cookie' };
        chunks.sort((a, b) => a[0] - b[0]);
        const raw = chunks.map(c => decodeURIComponent(c[1])).join('');
        let json = raw;
        if (raw.startsWith('base64-')) {
            json = atob(raw.slice(7).replace(/-/g, '+').replace(/_/g, '/'));
        }
        try {
            const session = JSON.parse(json);
            const user = session.user || {};
            const meta = user.user_metadata || {};
            return {
                token: String(session.access_token || ''),
                expiresAt: Number(session.expires_at) || 0,
                name: String(meta.name || meta.full_name || user.email || ''),
            };
        } catch (error) {
            return { problem: 'session cookie unreadable: ' + String(error) };
        }
    })()`;
    let value = null;
    try {
        value = await browser.evaluateInPage(expression, { timeoutMs: 10_000 });
    } catch (error) {
        console.warn("[Weaver's Vault] janitor session read failed:", error.message);
        return { token: '', expiresAt: 0, name: '', problem: error.message };
    }
    if (value?.problem) console.warn("[Weaver's Vault] janitor session problem:", value.problem);
    if (!value || value.problem) {
        return { token: '', expiresAt: 0, name: '', problem: value?.problem ?? 'no session' };
    }
    if (!value.token) return { token: '', expiresAt: 0, name: value.name ?? '', problem: 'session has no access token' };
    return { token: value.token, expiresAt: value.expiresAt ?? 0, name: value.name ?? '', problem: '' };
}

/**
 * Headers that authenticate an API read, when a session exists.
 *
 * A parked page's token can expire while nobody refreshes it, so an expired
 * token is refreshed by reloading the app page once (the site's own client does
 * the refresh) rather than by trying to mint one ourselves.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {{allowReload?: boolean}} [options]
 * @returns {Promise<{headers: Record<string,string>, signedIn: boolean}>}
 */
export async function janitorAuthHeaders(browser, { allowReload = true } = {}) {
    let session = await readJanitorSession(browser);
    const expired = session.expiresAt && session.expiresAt * 1000 < Date.now();
    if (allowReload && !session.token && session.problem) {
        await browser.reload();
        session = await readJanitorSession(browser);
    } else if (allowReload && expired) {
        await browser.reload();
        session = await readJanitorSession(browser);
    }
    if (!session.token) return { headers: {}, signedIn: false };
    return { headers: { Authorization: `Bearer ${session.token}` }, signedIn: true };
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
    // Cookies alone are a hard 401 here (measured), so the bearer token is not
    // optional: without it a perfectly signed-in session reads as signed out.
    const auth = await janitorAuthHeaders(browser);
    const result = await browser.fetchText(`${JANITOR_ORIGIN}hampter/profiles/mine`, {
        accept: 'application/json, text/plain, */*',
        headers: auth.headers,
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
