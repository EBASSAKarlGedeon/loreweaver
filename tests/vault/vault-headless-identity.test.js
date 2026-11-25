import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    IDENTITY_FILE,
    IDENTITY_TTL_MS,
    browserMajor,
    deviceMetrics,
    identityIsUsable,
    loadCachedIdentity,
    outerSize,
    resolveHeadlessMode,
    sanitizeProduct,
    saveCachedIdentity,
    userAgentOverride,
} from '../../src/endpoints/weavers-vault-headless-identity.js';

/**
 * A headless browser is only allowed to run if it can claim to be the real
 * Chrome on this machine. These tests pin the decisions that makes — never a
 * browser launch — because the failure they guard against (measured 2026-11-25)
 * is a `403 Access Restricted` block that no challenge handling recovers from.
 */

/** What a real headful Chrome on this machine reports, abbreviated. */
const REFERENCE = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
    platform: 'Win32',
    uaData: {
        brands: [
            { brand: 'Chromium', version: '158' },
            { brand: 'Not.A/Brand', version: '24' },
            { brand: 'Google Chrome', version: '158' },
        ],
        mobile: false,
        platform: 'Windows',
    },
    uaDataHighEntropy: {
        fullVersionList: [
            { brand: 'Chromium', version: '158.0.8127.37' },
            { brand: 'Not.A/Brand', version: '24.0.0.0' },
            { brand: 'Google Chrome', version: '158.0.8127.37' },
        ],
        platformVersion: '19.0.0',
        architecture: 'x64',
        bitness: '64',
        model: '',
        wow64: false,
    },
    screen: { width: 1536, height: 864 },
    window: { innerWidth: 1280, innerHeight: 795, outerWidth: 1281, outerHeight: 883, dpr: 1.25 },
};

/** A profile directory that cleans itself up. */
function tempProfile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-identity-'));
    return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveHeadlessMode', () => {
    test('is on by default', () => {
        // Flipped 2026-11-25, after probe 3: the site answers a headless browser
        // whose first navigation carries the measured UA exactly as it answers a
        // headful one. A window the user should never see is the point.
        expect(resolveHeadlessMode(null, {})).toBe(true);
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: undefined })).toBe(true);
    });

    test('still turns on from the option or the environment', () => {
        expect(resolveHeadlessMode(true, {})).toBe(true);
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: '1' })).toBe(true);
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: 'true' })).toBe(true);
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: ' ON ' })).toBe(true);
    });

    test('an explicit off always wins', () => {
        // A config file must be able to disable it without deleting the env var
        // that a shell profile set.
        expect(resolveHeadlessMode(false, { VAULT_BROWSER_HEADLESS: '1' })).toBe(false);
        expect(resolveHeadlessMode(true, { VAULT_BROWSER_HEADLESS: '0' })).toBe(false);
        expect(resolveHeadlessMode('off', {})).toBe(false);
    });

    test('only the off spellings turn it off, junk changes nothing', () => {
        // A value we do not understand is ignored rather than guessed at; the
        // documented off spellings are the switch.
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: 'maybe' })).toBe(true);
        expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: '2' })).toBe(true);
        for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
            expect(resolveHeadlessMode(null, { VAULT_BROWSER_HEADLESS: off })).toBe(false);
        }
    });
});

describe('identityIsUsable', () => {
    test('accepts what a real Chrome reports', () => {
        expect(identityIsUsable(REFERENCE)).toBe(true);
    });

    test('rejects the empty brand list of an about:blank page', () => {
        // Measured 2026-11-25: on about:blank navigator.userAgentData is not
        // populated, so an override built there reports brands: [] — something no
        // real Chrome ever does. It is a fingerprint, not a cosmetic difference.
        const blank = { ...REFERENCE, uaData: { brands: [], mobile: false, platform: '' } };
        expect(identityIsUsable(blank)).toBe(false);
        expect(identityIsUsable({ ...REFERENCE, uaData: null })).toBe(false);
    });

    test('rejects a reference with no screen or no viewport', () => {
        expect(identityIsUsable({ ...REFERENCE, screen: { width: 0, height: 0 } })).toBe(false);
        expect(identityIsUsable({ ...REFERENCE, window: { innerWidth: 0, innerHeight: 0 } })).toBe(false);
        expect(identityIsUsable(null)).toBe(false);
    });
});

describe('the override payloads', () => {
    test('copies the UA verbatim and never sends acceptLanguage', () => {
        // Desktop Chrome freezes the UA to Chrome/<major>.0.0.0; rebuilding it only
        // invents differences. Setting acceptLanguage moves the accept-language
        // header ahead of accept, which no real Chrome does (measured).
        const override = userAgentOverride(REFERENCE, 'Chrome/158.0.8127.37');
        expect(override.userAgent).toBe(REFERENCE.userAgent);
        expect(override.platform).toBe('Win32');
        expect('acceptLanguage' in override).toBe(false);
        expect(override.userAgentMetadata.brands).toEqual(REFERENCE.uaData.brands);
        expect(override.userAgentMetadata.platformVersion).toBe('19.0.0');
        expect(override.userAgentMetadata.fullVersion).toBe('158.0.8127.37');
    });

    test('a headless product never reaches the page as HeadlessChrome', () => {
        const product = sanitizeProduct('HeadlessChrome/158.0.8127.37');
        expect(product).toBe('Chrome/158.0.8127.37');
        expect(browserMajor(product)).toBe('158');
        const override = userAgentOverride(REFERENCE, product);
        expect(JSON.stringify(override)).not.toContain('Headless');
    });

    test('the metrics describe the real screen, not 800x600', () => {
        expect(deviceMetrics(REFERENCE)).toEqual({
            width: 1280,
            height: 795,
            deviceScaleFactor: 1.25,
            mobile: false,
            screenWidth: 1536,
            screenHeight: 864,
        });
    });

    test('the outer size is never smaller than the viewport', () => {
        // Headless reports outer 800x600 whatever the window bounds say, so
        // outer < inner — impossible for a real window (measured 2026-11-25).
        const collapsed = { window: { innerWidth: 1280, innerHeight: 795, outerWidth: 800, outerHeight: 600 } };
        const size = outerSize(collapsed);
        expect(size.width).toBeGreaterThan(1280);
        expect(size.height).toBeGreaterThan(795);
        // A measured outer size is kept as-is when it is the larger one.
        expect(outerSize(REFERENCE)).toEqual({ width: 1281, height: 883 });
    });
});

describe('the identity cache', () => {
    test('round-trips a measured identity', () => {
        const { dir, done } = tempProfile();
        try {
            expect(saveCachedIdentity(dir, 'HeadlessChrome/158.0.8127.37', REFERENCE)).toBe(true);
            expect(fs.existsSync(path.join(dir, IDENTITY_FILE))).toBe(true);
            const loaded = loadCachedIdentity(dir);
            expect(loaded.major).toBe('158');
            expect(loaded.reference.userAgent).toBe(REFERENCE.userAgent);
        } finally { done(); }
    });

    test('a different Chrome version invalidates it', () => {
        // A UA that claims the previous major is a mismatch, so the cache must not
        // survive a Chrome update.
        const { dir, done } = tempProfile();
        try {
            saveCachedIdentity(dir, 'Chrome/158.0.8127.37', REFERENCE);
            expect(loadCachedIdentity(dir, { product: 'Chrome/159.0.8200.1' })).toBeNull();
            expect(loadCachedIdentity(dir, { product: 'Chrome/158.0.8127.37' })).not.toBeNull();
        } finally { done(); }
    });

    test('a stale identity is measured again', () => {
        const { dir, done } = tempProfile();
        try {
            const measuredAt = Date.now() - IDENTITY_TTL_MS - 1;
            saveCachedIdentity(dir, 'Chrome/158.0.8127.37', REFERENCE, { now: measuredAt });
            expect(loadCachedIdentity(dir)).toBeNull();
            expect(loadCachedIdentity(dir, { now: measuredAt + IDENTITY_TTL_MS - 1 })).not.toBeNull();
        } finally { done(); }
    });

    test('an unusable or corrupt cache is ignored, never applied', () => {
        const { dir, done } = tempProfile();
        try {
            expect(loadCachedIdentity(dir)).toBeNull();
            fs.writeFileSync(path.join(dir, IDENTITY_FILE), '{not json');
            expect(loadCachedIdentity(dir)).toBeNull();
            const blank = { ...REFERENCE, uaData: { brands: [] } };
            saveCachedIdentity(dir, 'Chrome/158.0.8127.37', blank);
            expect(loadCachedIdentity(dir)).toBeNull();
        } finally { done(); }
    });
});
