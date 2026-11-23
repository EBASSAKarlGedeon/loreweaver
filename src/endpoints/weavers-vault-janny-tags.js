/**
 * Weaver's Vault — JannyAI tag catalog.
 *
 * The search index only knows numeric `tagIds`, so the labels come from the
 * site's own tag sidebar (rendered on browse pages as `/?query=…&tag_id=<id>`
 * links). Reading it needs the browser session, which is slow and rate-worthy,
 * so the result is cached on disk and served from cache until it expires.
 *
 * A cached catalog is also the reason a saved tag selection keeps working after
 * a reload: the search route resolves names through this file, not through the
 * browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { JANNY_BASE, JANNY_TAGS_FALLBACK, parseJannyTagCloud } from './weavers-vault-janny.js';

const CACHE_TTL_MS = 7 * 24 * 3600_000;
// The sidebar is rendered on browse pages. The home page carries all 57 entries;
// a query page does too, but short queries make the site answer 500 (measured:
// `?query=a&page=1` → 500, `?query=tsundere&page=1` → 200), so it is only a
// second attempt.
const CATALOG_URLS = [`${JANNY_BASE}/`, `${JANNY_BASE}/?query=tsundere&page=1`];

/**
 * Read the cached catalog if it is still fresh.
 * @param {string} cachePath
 * @returns {{tags: {id: number, name: string, title: string}[], fetchedAt: number}|null}
 */
export function readTagCache(cachePath) {
    try {
        if (!fs.existsSync(cachePath)) return null;
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (!Array.isArray(parsed?.tags) || !parsed.tags.length) return null;
        if (!Number.isFinite(parsed.fetchedAt)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeTagCache(cachePath, tags) {
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ tags, fetchedAt: Date.now() }, null, 1));
    } catch (error) {
        console.warn(`[Weaver's Vault] could not write the JannyAI tag cache: ${error.message}`);
    }
}

/**
 * Catalog for the UI, refreshing from the site when the cache is missing or old.
 *
 * A live read is best-effort: if the browser cannot read the page (challenge not
 * solved, site down), the measured fallback list is still returned so the filter
 * is usable instead of empty.
 * @param {{cachePath: string, fetchHtml?: (url: string) => Promise<{status: number, body: string}>, force?: boolean, logger?: object}} options
 * @returns {Promise<{tags: {id: number, name: string, title: string}[], source: 'cache'|'live'|'fallback', fetchedAt: number|null}>}
 */
export async function loadJannyTagCatalog({ cachePath, fetchHtml = null, force = false, logger = console }) {
    const cached = readTagCache(cachePath);
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) {
        return { tags: cached.tags, source: 'cache', fetchedAt: cached.fetchedAt };
    }

    if (fetchHtml) {
        for (const url of CATALOG_URLS) {
            try {
                const page = await fetchHtml(url);
                if (page.status !== 200 || !page.body) {
                    logger.warn?.(`[Weaver's Vault] JannyAI tag page ${url} answered ${page.status}`);
                    continue;
                }
                const tags = parseJannyTagCloud(page.body);
                if (tags.length >= 5) {
                    writeTagCache(cachePath, tags);
                    return { tags, source: 'live', fetchedAt: Date.now() };
                }
                logger.warn?.(`[Weaver's Vault] JannyAI tag sidebar had ${tags.length} entries at ${url}`);
            } catch (error) {
                logger.warn?.(`[Weaver's Vault] JannyAI tag catalog refresh failed: ${error.message}`);
            }
        }
    }

    if (cached) return { tags: cached.tags, source: 'cache', fetchedAt: cached.fetchedAt };
    return { tags: JANNY_TAGS_FALLBACK, source: 'fallback', fetchedAt: null };
}
