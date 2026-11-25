/**
 * What a headless Chrome has to claim about the machine it is running on.
 *
 * A headless browser describes itself badly and is blocked for it: measured
 * 2026-11-25, a headless launch whose own UA was copied made the site answer
 * `403 Access Restricted / blocked by our firewall` — a firewall block, not a
 * challenge, so no challenge handling recovers from it. The identity therefore
 * comes from a real Chrome on this machine (measured once, cached) and is applied
 * to the headless page before it loads anything.
 *
 * Everything here is pure or uses only a page handle, so the decisions are
 * testable without spawning a browser.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the measured identity is cached, inside the vault's browser profile. */
export const IDENTITY_FILE = 'headless-identity.json';

/**
 * How long a measured identity is trusted.
 *
 * Chrome updates change the version the identity claims, and the cache is keyed
 * by that version; the age is the backstop for everything else (a monitor swap,
 * a DPI change). A stale identity is a fingerprint mismatch, so it is re-measured
 * rather than trusted forever.
 */
export const IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the vault browser runs headless.
 *
 * On by default: a window the user should never see is the point, and the
 * measured behaviour on the site is now the same headless as headful (probe 3).
 * An explicit `0`/`false` wins everywhere — an option, the environment, or both —
 * because that is the documented way back to a visible browser, and a switch that
 * can be overridden by the thing it is meant to override is not a switch.
 * @param {boolean|string|null} [override] explicit value (option)
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function resolveHeadlessMode(override = null, env = process.env) {
    let on = true;
    for (const value of [override, env?.VAULT_BROWSER_HEADLESS]) {
        if (value === null || value === undefined || value === '') continue;
        const text = String(value).trim().toLowerCase();
        // An explicit off anywhere wins, so `VAULT_BROWSER_HEADLESS=0` can undo an
        // option a config file passed down.
        if (['0', 'false', 'off', 'no'].includes(text)) return false;
        if (['1', 'true', 'on', 'yes'].includes(text)) on = true;
    }
    return on;
}

/** The Chrome major version the binary reports (`HeadlessChrome/158...` included). */
export function browserMajor(product) {
    const match = /(?:HeadlessChrome|Chrome|Chromium|Edg)\/(\d+)/.exec(String(product ?? ''));
    return match ? match[1] : '';
}

/** A product string that never says HeadlessChrome. */
export function sanitizeProduct(product) {
    return String(product ?? '').replace(/HeadlessChrome/g, 'Chrome');
}

/**
 * Whether a measured identity is safe to apply.
 *
 * `brands: []` is the trap: on `about:blank` `navigator.userAgentData` is not
 * populated, and an override built from that empties the brand list — something
 * no real Chrome ever reports (measured 2026-11-25).
 * @param {object|null} reference
 * @returns {boolean}
 */
export function identityIsUsable(reference) {
    if (!reference) return false;
    if (!String(reference.userAgent ?? '').includes('Chrome/')) return false;
    const brands = reference.uaData?.brands;
    if (!Array.isArray(brands) || brands.length === 0) return false;
    const inner = reference.window ?? {};
    const screen = reference.screen ?? {};
    if (!(Number(inner.innerWidth) > 0) || !(Number(inner.innerHeight) > 0)) return false;
    if (!(Number(screen.width) > 0) || !(Number(screen.height) > 0)) return false;
    return true;
}

/**
 * The `Emulation.setUserAgentOverride` payload for a measured identity.
 *
 * The UA string is copied verbatim: a desktop Chrome freezes it to
 * `Chrome/<major>.0.0.0` (measured), so rebuilding it only invents differences.
 * @param {object} reference
 * @param {string} product `Browser.getVersion().product`, sanitised
 * @returns {{userAgent: string, platform: string, userAgentMetadata: object}}
 */
export function userAgentOverride(reference, product) {
    const hev = reference.uaDataHighEntropy ?? {};
    const brands = (reference.uaData?.brands ?? []).map(entry => ({ ...entry }));
    const major = browserMajor(product) || brands[0]?.version || '0';
    const fullVersionList = (hev.fullVersionList ?? brands).map(entry => ({ ...entry }));
    return {
        userAgent: String(reference.userAgent),
        // No `acceptLanguage`: setting it moves the `accept-language` header ahead
        // of `accept`, and no real Chrome sends it there (measured).
        platform: String(reference.platform ?? 'Win32'),
        userAgentMetadata: {
            brands,
            fullVersionList,
            fullVersion: hev.fullVersion ?? fullVersionList[0]?.version ?? `${major}.0.0.0`,
            platform: reference.uaData?.platform ?? 'Windows',
            platformVersion: hev.platformVersion ?? '15.0.0',
            architecture: hev.architecture ?? 'x64',
            model: hev.model ?? '',
            mobile: false,
            bitness: hev.bitness ?? '64',
            wow64: hev.wow64 ?? false,
        },
    };
}

/**
 * The `Emulation.setDeviceMetricsOverride` payload: the real screen, not
 * headless's 800x600 default.
 * @param {object} reference
 * @returns {object}
 */
export function deviceMetrics(reference) {
    return {
        width: Math.round(reference.window.innerWidth),
        height: Math.round(reference.window.innerHeight),
        deviceScaleFactor: Number(reference.window.dpr) || 1,
        mobile: false,
        screenWidth: Math.round(reference.screen.width),
        screenHeight: Math.round(reference.screen.height),
    };
}

/**
 * The outer window size a real window of this inner size has.
 *
 * A parked window can report no outer size at all, and setting 0x0 leaves
 * headless at 800x600 — smaller than the viewport, which no real window is.
 * @param {object} reference
 * @returns {{width: number, height: number}}
 */
export function outerSize(reference) {
    const inner = reference.window ?? {};
    return {
        width: Math.max(Number(inner.outerWidth) || 0, Math.round(Number(inner.innerWidth) || 0) + 1),
        height: Math.max(Number(inner.outerHeight) || 0, Math.round(Number(inner.innerHeight) || 0) + 88),
    };
}

/**
 * Apply a measured identity to a headless page.
 * @param {{send: Function}} page a CDP page handle
 * @param {object} reference
 * @param {string} product
 * @returns {Promise<boolean>} whether the override was accepted
 */
export async function applyIdentity(page, reference, product) {
    if (!page || !identityIsUsable(reference)) return false;
    try {
        await page.send('Emulation.setDeviceMetricsOverride', deviceMetrics(reference));
        await page.send('Emulation.setUserAgentOverride', userAgentOverride(reference, product));
        const { windowId } = await page.send('Browser.getWindowForTarget', {});
        const { width, height } = outerSize(reference);
        await page.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: -32000, top: -32000, width, height, windowState: 'normal' },
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * The cached identity for this Chrome version, if it is still trusted.
 * @param {string} profileDir
 * @param {string} product
 * @param {{now?: number}} [options]
 * @returns {object|null}
 */
/**
 * The cached identity, if it is still trusted for this Chrome.
 * @param {string} profileDir
 * @param {{product?: string|null, now?: number}} [options] `product` pins the
 *   Chrome version; omit it when the version is not known yet (before launch).
 * @returns {{reference: object, major: string}|null}
 */
export function loadCachedIdentity(profileDir, { product = null, now = Date.now() } = {}) {
    try {
        const cached = JSON.parse(fs.readFileSync(path.join(profileDir, IDENTITY_FILE), 'utf8'));
        if (!cached || !identityIsUsable(cached.reference)) return null;
        const major = browserMajor(product);
        if (major && cached.major !== major) return null;
        if (!Number.isFinite(cached.measuredAt) || now - cached.measuredAt > IDENTITY_TTL_MS) return null;
        return { reference: cached.reference, major: String(cached.major ?? '') };
    } catch {
        return null;
    }
}

/**
 * Remember a measured identity.
 * @param {string} profileDir
 * @param {string} product
 * @param {object} reference
 * @param {{now?: number}} [options]
 * @returns {boolean} whether it was written
 */
export function saveCachedIdentity(profileDir, product, reference, { now = Date.now() } = {}) {
    if (!identityIsUsable(reference)) return false;
    try {
        fs.mkdirSync(profileDir, { recursive: true });
        const payload = { major: browserMajor(product), measuredAt: now, reference };
        fs.writeFileSync(path.join(profileDir, IDENTITY_FILE), `${JSON.stringify(payload, null, 2)}\n`);
        return true;
    } catch {
        return false;
    }
}

/**
 * The page the identity is measured on.
 *
 * Loaded from `file://`, measured 2026-11-25: a file document is a secure
 * context in Chrome, so `getHighEntropyValues()` answers in full, and it needs
 * no network — the measuring launch costs the site nothing. `about:blank` does
 * not work: it is not a secure context and reports `brands: []`.
 */
export const IDENTITY_PROBE_HTML = '<!doctype html><meta charset="utf-8"><title>identity probe</title><p>identity probe</p>';

/** Read the identity from a live page (must be a real document, not about:blank). */
export const IDENTITY_EXPRESSION = `(async () => {
    const cm = navigator.userAgentData;
    let hev = null;
    try { hev = cm ? await cm.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'wow64']) : null; } catch {}
    return {
        userAgent: navigator.userAgent, platform: navigator.platform, languages: navigator.languages,
        uaData: cm ? { brands: cm.brands, mobile: cm.mobile, platform: cm.platform } : null,
        uaDataHighEntropy: hev,
        screen: { width: screen.width, height: screen.height },
        window: { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio },
    };
})()`;
