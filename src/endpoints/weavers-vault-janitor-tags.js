/**
 * Weaver's Vault — JanitorAI tag vocabulary.
 *
 * `GET /hampter/tags` answers a bare JSON array of 53 objects
 * (`{created_at, description, id, name, slug}`, names carry an emoji prefix:
 * `"👨 Male"` with slug `male`). Measured 2026-11-24, anonymously: no Cloudflare
 * challenge on `/hampter/*`, so this read needs no sign-in.
 *
 * The catalogue is read once and cached for 7 days, the same shape the JannyAI
 * source uses, because it is a filter vocabulary and changes rarely. A cached
 * copy is preferred over a failed read: a browse screen with last week's tags is
 * more useful than an empty sheet.
 *
 * AGPL-3.0 — part of Loreweaver, forked from SillyTavern. The tag model follows
 * Glaze's `janitor_provider.dart` tag handling.
 */
import fs from 'node:fs';
import path from 'node:path';

import { JANITOR_API, janitorTagKey } from './weavers-vault-janitor.js';

const TAG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} dataRoot
 * @returns {string} Cache file for the tag catalogue.
 */
export function janitorTagCachePath(dataRoot) {
    return path.join(dataRoot, '_vault-janitor-tags.json');
}

/**
 * Shape one tag row for the filter sheet. The description is dropped (it is
 * marketing copy per tag, sometimes a paragraph) and the emoji stays in `name`
 * because that is how the site shows it.
 * @param {{id?: unknown, name?: unknown, slug?: unknown}} row
 * @returns {{id: number, name: string, slug: string, key: string}|null}
 */
export function normalizeJanitorTag(row) {
    const id = Number(row?.id);
    const name = String(row?.name ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !name) return null;
    return {
        id,
        name,
        slug: String(row?.slug ?? '').trim() || janitorTagKey(name),
        key: janitorTagKey(name),
    };
}

/**
 * Parse the endpoint's payload.
 *
 * The live endpoint returns a bare array. An object wrapper with `data`/`tags`
 * is accepted as well, because that is how every *other* `/hampter` endpoint
 * answers and a silent empty sheet would be indistinguishable from "no tags".
 * @param {unknown} payload
 * @returns {Array<{id: number, name: string, slug: string, key: string}>}
 */
export function parseJanitorTags(payload) {
    const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.tags)
                ? payload.tags
                : [];
    const seen = new Set();
    const tags = [];
    for (const row of rows) {
        const tag = normalizeJanitorTag(row);
        // One chip per tag: the curated list and a custom tag can differ only by
        // an emoji or by case, and two chips that resolve to one id is a trap.
        if (!tag || seen.has(tag.key)) continue;
        seen.add(tag.key);
        tags.push(tag);
    }
    tags.sort((a, b) => a.name.localeCompare(b.name));
    return tags;
}

/**
 * @param {string} file
 * @returns {{tags: Array<object>, fetchedAt: number}|null}
 */
export function readJanitorTagCache(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed?.tags) || !parsed.tags.length) return null;
        return { tags: parsed.tags, fetchedAt: Number(parsed.fetchedAt) || 0 };
    } catch {
        return null;
    }
}

/**
 * @param {string} file
 * @param {{tags: Array<object>, fetchedAt: number}} value
 */
export function writeJanitorTagCache(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value));
        fs.renameSync(tmp, file);
    } catch (error) {
        console.warn("[Weaver's Vault] janitor tag cache write failed:", error.message);
    }
}

/**
 * The catalogue, from cache when it is fresh.
 * @param {{
 *   dataRoot: string,
 *   force?: boolean,
 *   fetchTags: () => Promise<unknown>,
 *   now?: number,
 * }} options
 * @returns {Promise<{tags: Array<object>, fetchedAt: number, source: 'cache'|'live'|'stale'}>}
 */
export async function janitorCatalog({ dataRoot, force = false, fetchTags, now = Date.now() }) {
    const file = janitorTagCachePath(dataRoot);
    const cached = readJanitorTagCache(file);
    if (!force && cached && now - cached.fetchedAt < TAG_TTL_MS) {
        return { ...cached, source: 'cache' };
    }
    try {
        const tags = parseJanitorTags(await fetchTags());
        if (!tags.length) throw new Error('the tag endpoint returned no usable tags');
        const value = { tags, fetchedAt: now };
        writeJanitorTagCache(file, value);
        return { ...value, source: 'live' };
    } catch (error) {
        // A failed refresh must not blank the sheet: last week's vocabulary is
        // still the right vocabulary, so it is served and marked stale.
        if (cached) {
            console.warn("[Weaver's Vault] janitor tag refresh failed, serving cache:", error.message);
            return { ...cached, source: 'stale' };
        }
        throw error;
    }
}

/** @returns {string} The endpoint the browser must read. */
export function janitorTagsUrl() {
    return `${JANITOR_API}/tags`;
}
