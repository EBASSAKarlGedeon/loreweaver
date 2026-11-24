/**
 * Weaver's Vault — JannyAI browser session.
 *
 * jannyai.com is one instance of the shared driver in `weavers-vault-browser.js`.
 * Everything host-specific about it is the four values in `JANNY`; the CDP
 * session, the Cloudflare wait, taskbar hiding, exit-state repair and the idle
 * teardown are generic and shared with other sources.
 *
 * `JannyBrowserUnavailable` is the shared error class re-exported under its old
 * name: route code catches it by identity, so a second class here would silently
 * stop the "show the browser window" recovery from ever triggering.
 */

import {
    disposeVaultBrowser,
    findBrowserBinary as findSharedBrowserBinary,
    getVaultBrowser,
    VaultBrowserUnavailable,
} from './weavers-vault-browser.js';

/** Everything that makes this source jannyai.com. */
const JANNY = {
    host: 'jannyai.com',
    origin: 'https://jannyai.com/',
    label: 'JannyAI',
    settingName: 'vaultJannyBrowserPath',
    envName: 'JANNY_BROWSER_PATH',
};

export { VaultBrowserUnavailable as JannyBrowserUnavailable };

/**
 * @param {{envName?: string|null}} [options]
 * @returns {string|null}
 */
export function findBrowserBinary(options = {}) {
    return findSharedBrowserBinary({ envName: JANNY.envName, ...options });
}

/**
 * @param {{profileDir: string, chromePath?: string|null, logger?: object}} options
 * @returns {import('./weavers-vault-browser.js').VaultBrowser}
 */
export function getJannyBrowser({ profileDir, chromePath = null, logger = console }) {
    return getVaultBrowser('janny', { ...JANNY, profileDir, chromePath, logger });
}

export async function disposeJannyBrowser() {
    await disposeVaultBrowser('janny');
}
