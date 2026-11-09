// Loreweaver sync: hub-side HTTP endpoints.
// Mounted at /api/sync. Authenticated by per-device bearer tokens (not ST sessions).
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getConfigValue } from '../util.js';
import {
    SYNCED_DIRS,
    SYNCED_ROOT_FILES,
    validateSyncPath,
    resolveSyncPath,
} from '../sync/paths.js';
import {
    HashCache,
    scanDirectory,
    atomicWriteFile,
    moveToTrash,
    readStableFile,
    hashBuffer,
} from '../sync/scan.js';
import {
    ChangeLog,
    HubRegistry,
    sha256Hex,
    syncStateDir,
} from '../sync/state.js';

const SYNC_CONFIG = {
    get maxFileBytes() {
        const mb = readConfig('sync.maxFileMB', 256);
        return Math.max(1, Number(mb) * 1024 * 1024);
    },
    get retentionDays() {
        return Number(readConfig('sync.retentionDays', 30));
    },
};

/**
 * Read a config value, falling back to the default when the config system is
 * not initialised (unit tests) rather than exiting the process.
 * @param {string} key
 * @param {any} fallback
 */
function readConfig(key, fallback) {
    try {
        return getConfigValue(key, fallback);
    } catch {
        return fallback;
    }
}

/** Per-handle hub state, created lazily. @type {Map<string, object>} */
const handleStates = new Map();
/** Serialises mutation + change-log writes per handle. @type {Map<string, Promise<void>>} */
const handleLocks = new Map();
/** Maps scanned directory root -> result, to assemble the full current state. */
const perDirScanCache = new Map();

/**
 * Run a function while holding the per-handle lock (no concurrent rescan/write).
 * @template T
 * @param {string} handle
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withHandleLock(handle, fn) {
    const prev = handleLocks.get(handle) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    handleLocks.set(handle, next.catch(() => { }));
    return next;
}

/**
 * Lazily created per-handle hub state: change log, hash cache, and the index
 * of current hub contents (path -> {hash, size, rev, deleted}).
 * @param {string} handle
 * @param {string} dataRoot Absolute path to data/
 */
async function getHandleState(handle, dataRoot) {
    if (handleStates.has(handle)) {
        return handleStates.get(handle);
    }
    const stateDir = syncStateDir(dataRoot);
    const changeLog = await new ChangeLog(path.join(stateDir, `changes-${handle}.jsonl`)).load();
    const state = {
        handle,
        dataRoot,
        changeLog,
        cache: new HashCache(),
        /** @type {Map<string, {hash: string|null, size: number|null, rev: number, deleted: boolean, deviceId: string, ts: number}>} */
        index: new Map(),
        indexBuilt: false,
    };
    handleStates.set(handle, state);
    return state;
}

/**
 * Snapshot the current disk state for a handle's synced directories and
 * root files. Returns {path: {hash, size, mtimeMs}} using the hash cache,
 * so unchanged files are never re-read.
 * @param {string} handle
 * @param {string} dataRoot
 * @param {HashCache} cache
 * @returns {Promise<Map<string, {hash: string, size: number, mtimeMs: number}>>}
 */
async function scanHandleFiles(handle, dataRoot, cache) {
    const root = path.join(dataRoot, handle);
    const current = new Map();
    const skip = ['sync-trash', 'sync-conflicts', '_sync', 'node_modules'];
    for (const dir of SYNCED_DIRS) {
        const absDir = path.join(root, dir);
        if (!fs.existsSync(absDir)) {
            continue;
        }
        const scanned = await scanDirectory(absDir, cache, skip);
        for (const [relPath, entry] of scanned) {
            current.set(`${dir}/${relPath}`, entry);
        }
    }
    for (const file of SYNCED_ROOT_FILES) {
        const stable = await readStableFile(path.join(root, file), 0);
        if (stable) {
            current.set(file, { hash: hashBuffer(stable.buffer), size: stable.size, mtimeMs: stable.mtimeMs });
        }
    }
    return current;
}

/**
 * Build the index once by replaying the change log; then apply any disk
 * drift found by scanning (the hub's own local edits) as new log entries.
 * @param {object} state Per-handle state
 * @param {string} deviceId Fixed device id for hub-local edits
 */
async function ensureIndex(state, deviceId = 'hub') {
    if (state.indexBuilt) {
        return;
    }
    for (const entry of state.changeLog.entries) {
        state.index.set(entry.path, {
            hash: entry.op === 'delete' ? null : entry.hash,
            size: entry.op === 'delete' ? null : entry.size,
            rev: entry.seq,
            deleted: entry.op === 'delete',
            deviceId: entry.deviceId,
            ts: entry.ts,
        });
    }
    state.indexBuilt = true;
    await applyLocalDrift(state, deviceId);
}

/**
 * Compare the index against the actual disk and record drift as change-log
 * entries (puts for new/changed files, deletes for vanished ones).
 * @param {object} state Per-handle state
 * @param {string} deviceId
 */
async function applyLocalDrift(state, deviceId) {
    const current = await scanHandleFiles(state.handle, state.dataRoot, state.cache);
    const seen = new Set();
    /** @type {{path: string, op: 'put'|'delete', hash: string|null, size: number|null, deviceId: string}[]} */
    const changes = [];
    for (const [relPath, entry] of current) {
        seen.add(relPath);
        const idx = state.index.get(relPath);
        if (!idx || idx.deleted || idx.hash !== entry.hash) {
            const seqEntry = state.changeLog.append({
                path: relPath, op: 'put', hash: entry.hash, size: entry.size, deviceId,
            });
            state.index.set(relPath, {
                hash: entry.hash, size: entry.size, rev: seqEntry.seq, deleted: false, deviceId, ts: seqEntry.ts,
            });
            changes.push(seqEntry);
        }
    }
    for (const [relPath, idx] of state.index) {
        if (!idx.deleted && !seen.has(relPath)) {
            const seqEntry = state.changeLog.append({
                path: relPath, op: 'delete', hash: null, size: null, deviceId,
            });
            state.index.set(relPath, { hash: null, size: null, rev: seqEntry.seq, deleted: true, deviceId, ts: seqEntry.ts });
            changes.push(seqEntry);
        }
    }
    return changes;
}

/** Force a rescan on the next request (used before serving reads). */
export async function rescanHandle(handle, dataRoot) {
    return withHandleLock(handle, async () => {
        const state = await getHandleState(handle, dataRoot);
        await ensureIndex(state, 'hub');
        return applyLocalDrift(state, 'hub');
    });
}

/** Reset cached state (tests). */
export function resetHubState() {
    handleStates.clear();
    handleLocks.clear();
}

/**
 * Build the sync router.
 * @param {string} dataRoot Absolute path to data/
 * @param {{dataRoot: string}} [options] Overrides for tests
 * @returns {express.Router}
 */
export function createSyncRouter(dataRoot, options = {}) {
    const router = express.Router();
    const registryFile = path.join(syncStateDir(dataRoot), 'hub.json');
    const registry = new HubRegistry(registryFile);
    let registryLoaded = false;

    /**
     * Bearer-token auth. Token hash is looked up in the hub registry.
     * @type {express.RequestHandler}
     */
    async function auth(request, response, next) {
        if (!registryLoaded) {
            await registry.load();
            registryLoaded = true;
        }
        const header = String(request.headers['authorization'] ?? '');
        if (!header.startsWith('Bearer ')) {
            response.status(401).json({ error: 'missing token' });
            return;
        }
        const token = header.slice(7).trim();
        const found = registry.findByTokenHash(sha256Hex(token));
        if (!found) {
            response.status(401).json({ error: 'invalid token' });
            return;
        }
        response.locals.deviceId = found.deviceId;
        next();
    }

    router.use(auth);

    /**
     * Resolve the handle from the query, verifying it exists and is allowed.
     * @type {(request: express.Request, response: express.Response) => string | null}
     */
    function getHandle(request, response) {
        const handle = String(request.query.handle ?? 'default-user');
        // Path-safety: handle must not contain separators (it is a single directory name).
        if (!/^[a-zA-Z0-9_-]+$/.test(handle)) {
            response.status(400).json({ error: 'invalid handle' });
            return null;
        }
        if (!fs.existsSync(path.join(dataRoot, handle))) {
            // Fresh hub: create the user directory (charset is validated above).
            fs.mkdirSync(path.join(dataRoot, handle), { recursive: true });
        }
        return handle;
    }

    // POST /hello — register or refresh device, report hub sequence.
    router.post('/hello', async (request, response) => {
        const handle = getHandle(request, response);
        if (handle === null) {
            return;
        }
        const deviceId = response.locals.deviceId;
        const patch = {};
        if (typeof request.body?.name === 'string' && request.body.name.trim() !== '') {
            patch.name = request.body.name.slice(0, 100);
        }
        registry.upsert(deviceId, patch);
        await registry.save();
        const state = await withHandleLock(handle, async () => {
            const s = await getHandleState(handle, dataRoot);
            await ensureIndex(s, 'hub');
            await applyLocalDrift(s, 'hub');
            return s;
        });
        response.json({ hubSeq: state.changeLog.currentSeq(), protocol: 1, serverTime: Date.now() });
    });

    // GET /changes — latest entry per path since a seq, paginated.
    router.get('/changes', async (request, response) => {
        const handle = getHandle(request, response);
        if (handle === null) {
            return;
        }
        const since = Number(request.query.since ?? 0);
        if (!Number.isFinite(since) || since < 0) {
            response.status(400).json({ error: 'invalid since' });
            return;
        }
        const limit = Math.min(5000, Math.max(1, Number(request.query.limit ?? 5000)));
        const state = await withHandleLock(handle, async () => {
            const s = await getHandleState(handle, dataRoot);
            await ensureIndex(s, 'hub');
            await applyLocalDrift(s, 'hub');
            return s;
        });
        const { changes, nextSince } = state.changeLog.since(since, limit);
        response.json({ hubSeq: state.changeLog.currentSeq(), changes, nextSince });
    });

    // GET /file — stream file bytes with content hash header.
    router.get('/file', async (request, response) => {
        const handle = getHandle(request, response);
        if (handle === null) {
            return;
        }
        let relPath;
        try {
            relPath = validateSyncPath(String(request.query.path ?? ''));
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        let absPath;
        try {
            absPath = resolveSyncPath(path.join(dataRoot, handle), relPath);
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        let stat;
        try {
            stat = fs.statSync(absPath);
            if (!stat.isFile()) {
                throw new Error('not a file');
            }
        } catch {
            response.status(404).json({ error: 'file not found' });
            return;
        }
        const stable = await readStableFile(absPath, 0);
        if (!stable) {
            response.status(503).json({ error: 'file busy' });
            return;
        }
        const hash = hashBuffer(stable.buffer);
        response.setHeader('X-Content-Hash', hash);
        response.setHeader('Content-Length', stable.size);
        response.setHeader('Content-Type', 'application/octet-stream');
        response.send(stable.buffer);
    });

    // PUT /file — upload with optimistic concurrency (baseRev).
    router.put('/file', async (request, response) => {
        const handle = getHandle(request, response);
        if (handle === null) {
            return;
        }
        let relPath;
        try {
            relPath = validateSyncPath(String(request.query.path ?? ''));
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        let absPath;
        try {
            absPath = resolveSyncPath(path.join(dataRoot, handle), relPath);
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        const baseRev = Number(request.query.baseRev ?? 0);
        if (!Number.isFinite(baseRev) || baseRev < 0) {
            response.status(400).json({ error: 'invalid baseRev' });
            return;
        }
        const declaredHash = String(request.headers['x-content-hash'] ?? '');
        if (!/^[0-9a-f]{64}$/.test(declaredHash)) {
            response.status(400).json({ error: 'missing or invalid X-Content-Hash' });
            return;
        }

        // Read the body (bounded).
        const chunks = [];
        let total = 0;
        for await (const chunk of request) {
            total += chunk.length;
            if (total > SYNC_CONFIG.maxFileBytes) {
                response.status(413).json({ error: 'file too large' });
                return;
            }
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const actualHash = hashBuffer(buffer);
        if (actualHash !== declaredHash) {
            response.status(400).json({ error: 'hash mismatch' });
            return;
        }

        const result = await withHandleLock(handle, async () => {
            const state = await getHandleState(handle, dataRoot);
            await ensureIndex(state, 'hub');
            const idx = state.index.get(relPath);
            const currentRev = idx?.rev ?? 0;
            const sameContent = idx && !idx.deleted && idx.hash === actualHash;

            // Optimistic check: conflict if the hub moved on since baseRev and content differs.
            if (!sameContent && currentRev > baseRev) {
                return { conflict: true, rev: currentRev, hash: idx?.hash ?? null, deleted: idx?.deleted ?? false };
            }

            if (sameContent) {
                return { conflict: false, rev: currentRev, hash: actualHash, noop: true };
            }

            // Apply the write.
            if (idx && !idx.deleted && fs.existsSync(absPath)) {
                // Move the previous version to trash before overwriting.
                const trashDir = path.join(dataRoot, handle, 'sync-trash');
                await moveToTrash(absPath, trashDir, relPath);
            }
            await atomicWriteFile(absPath, buffer);
            const entry = state.changeLog.append({
                path: relPath, op: 'put', hash: actualHash, size: buffer.length, deviceId: response.locals.deviceId,
            });
            state.index.set(relPath, {
                hash: actualHash, size: buffer.length, rev: entry.seq, deleted: false,
                deviceId: response.locals.deviceId, ts: entry.ts,
            });
            return { conflict: false, rev: entry.seq, hash: actualHash, noop: false };
        });

        if (result.conflict) {
            response.status(409).json({ currentHash: result.hash, currentRev: result.rev, deleted: result.deleted });
            return;
        }
        response.status(result.noop ? 200 : 201).json({ seq: result.rev, hash: result.hash });
    });

    // DELETE /file — tombstone with optimistic check; previous file moves to trash.
    router.delete('/file', async (request, response) => {
        const handle = getHandle(request, response);
        if (handle === null) {
            return;
        }
        let relPath;
        try {
            relPath = validateSyncPath(String(request.query.path ?? ''));
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        let absPath;
        try {
            absPath = resolveSyncPath(path.join(dataRoot, handle), relPath);
        } catch (err) {
            response.status(400).json({ error: err.message });
            return;
        }
        const baseRev = Number(request.query.baseRev ?? 0);
        if (!Number.isFinite(baseRev) || baseRev < 0) {
            response.status(400).json({ error: 'invalid baseRev' });
            return;
        }

        const result = await withHandleLock(handle, async () => {
            const state = await getHandleState(handle, dataRoot);
            await ensureIndex(state, 'hub');
            const idx = state.index.get(relPath);
            const currentRev = idx?.rev ?? 0;

            if (idx?.deleted || !fs.existsSync(absPath)) {
                // Already gone: idempotent success.
                if (!idx?.deleted) {
                    const entry = state.changeLog.append({
                        path: relPath, op: 'delete', hash: null, size: null, deviceId: response.locals.deviceId,
                    });
                    state.index.set(relPath, { hash: null, size: null, rev: entry.seq, deleted: true, deviceId: response.locals.deviceId, ts: entry.ts });
                    return { rev: entry.seq, alreadyGone: true };
                }
                return { rev: idx.rev, alreadyGone: true };
            }

            const sameContent = idx && idx.hash !== null;
            if (sameContent && currentRev > baseRev) {
                return { conflict: true, rev: currentRev, hash: idx.hash };
            }

            const trashDir = path.join(dataRoot, handle, 'sync-trash');
            await moveToTrash(absPath, trashDir, relPath);
            const entry = state.changeLog.append({
                path: relPath, op: 'delete', hash: null, size: null, deviceId: response.locals.deviceId,
            });
            state.index.set(relPath, { hash: null, size: null, rev: entry.seq, deleted: true, deviceId: response.locals.deviceId, ts: entry.ts });
            return { rev: entry.seq, alreadyGone: false };
        });

        if (result.conflict) {
            response.status(409).json({ currentHash: result.hash, currentRev: result.rev });
            return;
        }
        response.status(200).json({ seq: result.rev });
    });

    return router;
}
