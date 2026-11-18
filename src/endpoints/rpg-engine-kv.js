import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { atomicWriteFile } from '../sync/scan.js';

/**
 * RPG Engine kv mirror endpoints.
 *
 * The RPG Engine extension stores its saves (adventures, hero library, world library) in a
 * browser IndexedDB kv store, which device-bound and invisible to the sync engine. The
 * extension's storage shim mirrors every write into data/<handle>/rpg-engine/kv/ through this
 * router, so Phase 2 sync carries game saves between devices like any other file.
 *
 * Key names arrive pre-encoded by the client as [A-Za-z0-9_-]+ (base64url of "folder\u0000key")
 * plus a '.json' suffix; this router treats them as opaque safe names. Deletes write a
 * '<name>.tomb.json' marker (with the tombstone's own mtime) before unlinking the data file,
 * so a deletion made offline on one device is not resurrected by another device's boot
 * reconcile.
 */

const KV_DIR = path.join('rpg-engine', 'kv');
const DATA_SUFFIX = '.json';
const TOMB_SUFFIX = '.tomb.json';
// Allowlist for opaque names: base64url body, optionally already suffixed by the client.
const NAME_RE = /^[A-Za-z0-9_-]+(\.json|\.tomb\.json)?$/;

/**
 * Resolve and validate the kv directory for the requesting user.
 * @param {import('express').Request} request
 * @returns {string} Absolute directory path
 */
function kvRoot(request) {
    const root = request.user?.directories?.root;
    if (!root) {
        throw new Error('no user data directory');
    }
    return path.join(root, KV_DIR);
}

/**
 * Validate an opaque entry name from the client.
 * @param {unknown} name
 * @returns {string} Validated name
 */
function safeName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new Error('invalid name');
    }
    return name;
}

/** Strip the .json suffix for lookups of the raw data file. */
function dataFile(dir, name) {
    const base = name.endsWith(DATA_SUFFIX) ? name : name + DATA_SUFFIX;
    const resolved = path.resolve(dir, base);
    if (!resolved.startsWith(dir)) {
        throw new Error('invalid name');
    }
    return resolved;
}

/** Tombstone path for a data file name. */
function tombFile(dir, name) {
    const base = (name.endsWith(DATA_SUFFIX) ? name.slice(0, -DATA_SUFFIX.length) : name) + TOMB_SUFFIX;
    const resolved = path.resolve(dir, base);
    if (!resolved.startsWith(dir)) {
        throw new Error('invalid name');
    }
    return resolved;
}

async function statOrNull(absPath) {
    try {
        return await fs.promises.stat(absPath);
    } catch {
        return null;
    }
}

export const router = express.Router();

/**
 * List every entry in the user's kv mirror.
 * Returns data files and tombstones with mtimes so the client can reconcile.
 */
router.post('/list', async (request, response) => {
    try {
        const dir = kvRoot(request);
        let entries;
        try {
            entries = await fs.promises.readdir(dir);
        } catch {
            return response.json({ entries: [] });
        }
        const out = [];
        for (const name of entries) {
            if (!NAME_RE.test(name)) {
                continue;
            }
            const st = await statOrNull(path.join(dir, name));
            if (!st || !st.isFile()) {
                continue;
            }
            out.push({ name, mtimeMs: Math.round(st.mtimeMs), size: st.size });
        }
        return response.json({ entries: out });
    } catch (error) {
        console.error('rpg-engine-kv list failed:', error);
        return response.status(500).json({ error: 'list failed' });
    }
});

/** Read one entry: { name } -> { content, mtimeMs } or { content: null }. */
router.post('/get', async (request, response) => {
    try {
        const dir = kvRoot(request);
        const name = safeName(request.body?.name);
        const file = dataFile(dir, name);
        const st = await statOrNull(file);
        if (!st) {
            return response.json({ content: null, mtimeMs: 0 });
        }
        const content = await fs.promises.readFile(file, 'utf8');
        return response.json({ content, mtimeMs: Math.round(st.mtimeMs) });
    } catch (error) {
        console.error('rpg-engine-kv get failed:', error);
        return response.status(500).json({ error: 'get failed' });
    }
});

/**
 * Write one entry: { name, content } -> { mtimeMs }.
 * The content must be a string (the client JSON-stringifies the value). Written atomically.
 */
router.post('/put', async (request, response) => {
    try {
        const dir = kvRoot(request);
        const name = safeName(request.body?.name);
        const { content } = request.body ?? {};
        if (typeof content !== 'string') {
            return response.status(400).json({ error: 'content must be a string' });
        }
        const file = dataFile(dir, name);
        await atomicWriteFile(file, content);
        const st = await statOrNull(file);
        // A successful put supersedes any earlier tombstone for this name.
        try {
            await fs.promises.unlink(tombFile(dir, name));
        } catch { /* no tombstone */ }
        return response.json({ mtimeMs: st ? Math.round(st.mtimeMs) : Date.now() });
    } catch (error) {
        console.error('rpg-engine-kv put failed:', error);
        return response.status(500).json({ error: 'put failed' });
    }
});

/**
 * Delete one entry: { name }. Writes a tombstone marker (so other devices honour the
 * deletion) and unlinks the data file. The tombstone carries the deletion time.
 */
router.post('/delete', async (request, response) => {
    try {
        const dir = kvRoot(request);
        const name = safeName(request.body?.name);
        const file = dataFile(dir, name);
        const now = Date.now();
        await atomicWriteFile(tombFile(dir, name), JSON.stringify({ deletedAt: now }));
        try {
            await fs.promises.unlink(file);
        } catch { /* already gone */ }
        return response.json({ ok: true, mtimeMs: now });
    } catch (error) {
        console.error('rpg-engine-kv delete failed:', error);
        return response.status(500).json({ error: 'delete failed' });
    }
});
