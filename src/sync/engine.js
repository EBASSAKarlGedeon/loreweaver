// Loreweaver sync: client-side engine implementing the spec's section 6 algorithm.
// One run = hello -> scan -> diff -> push/pull -> update base table.
import path from 'node:path';

import {
    SYNCED_DIRS,
    SYNCED_ROOT_FILES,
    resolveSyncPath,
} from './paths.js';
import {
    HashCache,
    scanDirectory,
    atomicWriteFile,
    moveToTrash,
    readStableFile,
    hashBuffer,
} from './scan.js';
import { BaseTable, loadOrCreateDevice, syncStateDir } from './state.js';
import { createHttpTransport } from './transport-http.js';

/**
 * @typedef {Object} SyncRunResult
 * @property {boolean} ok False when hello failed (offline) or any error occurred
 * @property {boolean} offline True when the hub was unreachable
 * @property {number} pushed
 * @property {number} pulled
 * @property {number} deleted
 * @property {number} skipped
 * @property {{path: string, kind: string}[]} conflicts
 * @property {string[]} errors
 * @property {number} hubSeq New lastHubSeq (when reachable)
 */

/**
 * Build a sync engine for one handle.
 * @param {{dataRoot: string, handle: string, hubUrl: string, token: string,
 *          deviceName?: string, transport?: Transport, quietMs?: number,
 *          onConflict?: (relPath: string, kind: string, localBuffer: Buffer | null, hubChange: object | null) => Promise<void>}} options
 */
export function createSyncEngine(options) {
    const {
        dataRoot,
        handle,
        hubUrl,
        token,
        deviceName = '',
        quietMs = 0,
    } = options;
    const transport = options.transport ?? createHttpTransport({ hubUrl, token });
    const root = path.join(dataRoot, handle);

    /**
     * Snapshot local files (walk + hash with cache).
     * @returns {Promise<Map<string, {hash: string, size: number, mtimeMs: number}>>}
     */
    async function scanLocal() {
        const cache = new HashCache();
        const current = new Map();
        const skip = ['sync-trash', 'sync-conflicts', '_sync', 'node_modules'];
        for (const dir of SYNCED_DIRS) {
            const scanned = await scanDirectory(path.join(root, dir), cache, skip);
            for (const [rel, entry] of scanned) {
                current.set(`${dir}/${rel}`, entry);
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
     * Sync run.
     * @returns {Promise<SyncRunResult>}
     */
    return async function syncRun() {
        /** @type {SyncRunResult} */
        const result = { ok: true, offline: false, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: [], errors: [], hubSeq: 0 };

        // 1. Hello.
        const device = await loadOrCreateDevice(dataRoot);
        const hello = await transport.hello(handle, deviceName || device.deviceId, 1);
        if (!hello.ok) {
            result.ok = false;
            result.offline = hello.status === 0;
            if (!result.offline) {
                result.errors.push(`hello failed: ${hello.error ?? hello.status}`);
            }
            return result;
        }

        // 2. Load the base table and scan local files.
        const base = await new BaseTable(path.join(syncStateDir(dataRoot), `state-${handle}.json`)).load();
        const local = await scanLocal();

        // 3. Fetch remote changes since the last synced seq (paged).
        const remote = new Map();
        let since = base.data.lastHubSeq;
        for (;;) {
            const r = await transport.changes(handle, since);
            if (!r.ok) {
                result.errors.push(`changes failed: ${r.error ?? r.status}`);
                result.ok = false;
                return result;
            }
            for (const change of r.json?.changes ?? []) {
                remote.set(change.path, change);
            }
            // Track the hub's current seq across pages; the last page wins.
            result.hubSeq = Math.max(result.hubSeq, r.json?.hubSeq ?? 0);
            const next = r.json?.nextSince ?? 0;
            if (!next || next <= since) {
                break;
            }
            since = next;
        }

        // 4. Three-way diff over the union of paths.
        const allPaths = new Set([...local.keys(), ...base.paths(), ...remote.keys()]);
        for (const relPath of allPaths) {
            try {
                await processPath(relPath, local, base, remote, result);
            } catch (err) {
                result.errors.push(`${relPath}: ${err?.message ?? String(err)}`);
                result.ok = false;
            }
        }

        // 5. Advance the watermark only when the whole run was clean, so a
        // failed path is retried against the same hub state next run.
        if (result.errors.length === 0) {
            base.data.lastHubSeq = result.hubSeq;
        }
        await base.saveIfDirty();
        return result;
    };

    /**
     * Hub-side state for a path: latest change if any, else inferred from base.
     * @param {object|null} baseEntry
     * @param {object|undefined} change
     */
    function hubState(baseEntry, change) {
        if (change) {
            return change.op === 'delete' ? null : { hash: change.hash, size: change.size, rev: change.seq };
        }
        return baseEntry ? { hash: baseEntry.hash, size: baseEntry.size, rev: baseEntry.hubRev } : null;
    }

    /**
     * Process one path through the three-way diff.
     * @param {string} relPath Normalised sync path
     * @param {Map<string, {hash: string, size: number, mtimeMs: number}>} local
     * @param {BaseTable} base
     * @param {Map<string, object>} remote Latest hub changes (absent = unchanged since lastHubSeq)
     * @param {SyncRunResult} result
     */
    async function processPath(relPath, local, base, remote, result) {
        const L = local.get(relPath) ?? null;
        const B = base.get(relPath) ?? null;
        const change = remote.get(relPath);
        const R = hubState(B, change);

        const localChanged = L ? (!B || L.hash !== B.hash) : !!B;
        const remoteChanged = change ? (change.op === 'delete' ? !!B : (!B || change.hash !== B.hash)) : false;

        if (!localChanged && !remoteChanged) {
            return; // in sync
        }

        if (localChanged && !remoteChanged) {
            // Push local state.
            if (L) {
                const put = await transport.putFile(handle, relPath, await readFileForPush(root, relPath), B?.hubRev ?? 0);
                if (put.ok) {
                    base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: put.json.seq });
                    result.pushed++;
                } else if (put.status === 409) {
                    await handleConflict(relPath, L, change ?? null, base, result);
                } else {
                    result.errors.push(`${relPath}: put failed (${put.status})`);
                    result.ok = false;
                }
            } else {
                const del = await transport.deleteFile(handle, relPath, B?.hubRev ?? 0);
                if (del.ok) {
                    base.delete(relPath);
                    result.deleted++;
                } else if (del.status === 409) {
                    // Remote edited since our base: pull their version instead of deleting.
                    await handleConflict(relPath, null, change ?? null, base, result);
                } else {
                    result.errors.push(`${relPath}: delete failed (${del.status})`);
                    result.ok = false;
                }
            }
            return;
        }

        if (!localChanged && remoteChanged) {
            // Pull remote state.
            if (R === null) {
                // Remote delete of an unchanged local file: trash it locally.
                try {
                    await moveToTrash(resolveSyncPath(root, relPath), path.join(root, 'sync-trash'), relPath);
                    base.delete(relPath);
                    result.deleted++;
                } catch {
                    result.skipped++;
                }
                return;
            }
            await pullRemote(relPath, R, change, base, result);
            return;
        }

        // Both changed.
        if (L && R && L.hash === R.hash) {
            // Same change made on both sides: just update the base.
            base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: change.seq });
            return;
        }
        await handleConflict(relPath, L, change ?? null, base, result);
    }

    /**
     * Download the hub version and write it locally.
     * @param {string} relPath
     * @param {{hash: string, size: number|null, rev: number}} R
     * @param {object|undefined} change
     * @param {BaseTable} base
     * @param {SyncRunResult} result
     */
    async function pullRemote(relPath, R, change, base, result) {
        const got = await transport.getFile(handle, relPath);
        if (!got.ok) {
            result.errors.push(`${relPath}: get failed (${got.status})`);
            result.ok = false;
            return;
        }
        if (got.hash && R.hash && got.hash !== R.hash) {
            result.skipped++; // hub content drifted mid-run; retry next run
            return;
        }
        await atomicWriteFile(resolveSyncPath(root, relPath), got.body);
        base.set(relPath, { hash: R.hash ?? got.hash, size: R.size ?? got.body.length, mtimeMs: Date.now(), hubRev: change?.seq ?? R.rev });
        result.pulled++;
    }

    /**
     * Conflict fallback (Rule B): the hub version wins, the local loser is
     * preserved as a conflict copy. Delete-vs-edit: the edit wins.
     * Milestone 4 adds chat prefix merging via onConflict.
     * @param {string} relPath
     * @param {{hash: string, size: number, mtimeMs: number}|null} L Local entry (null = deleted locally)
     * @param {object|null} change Latest hub change for the path (null = unchanged since base)
     * @param {BaseTable} base
     * @param {SyncRunResult} result
     */
    async function handleConflict(relPath, L, change, base, result) {
        const hubDeleted = change ? change.op === 'delete' : false;
        try {
            // Preserve the local version before it is overwritten or kept.
            let localBuffer = null;
            if (L) {
                localBuffer = await readFileForPush(root, relPath);
            }

            if (hubDeleted) {
                // Edit vs delete: the edit wins. Push local back with baseRev = delete seq.
                if (localBuffer && L) {
                    const put = await transport.putFile(handle, relPath, localBuffer, change.seq);
                    if (put.ok) {
                        base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: put.json.seq });
                        result.pushed++;
                    } else {
                        result.errors.push(`${relPath}: conflict put failed (${put.status})`);
                        result.ok = false;
                        return;
                    }
                } else {
                    // Both deleted: settle the tombstone.
                    base.delete(relPath);
                    result.deleted++;
                }
            } else if (change) {
                // Hub has content: pull it, saving the local version first.
                if (localBuffer) {
                    const copyPath = conflictCopyPath(relPath);
                    await atomicWriteFile(copyPath, localBuffer);
                }
                const R = { hash: change.hash, size: change.size, rev: change.seq };
                await pullRemote(relPath, R, change, base, result);
            } else {
                // Hub state unknown (409 on push): fetch current hub version via changes? Not available;
                // simplest correct fallback: refetch full changes is out of scope here, so report an error
                // and retry next run (the run does not advance the watermark).
                result.errors.push(`${relPath}: unresolvable conflict (no hub change info)`);
                result.ok = false;
                return;
            }

            result.conflicts.push({ path: relPath, kind: hubDeleted ? 'delete-edit' : 'diverged' });
        } catch (err) {
            result.errors.push(`${relPath}: conflict handling failed: ${err?.message ?? String(err)}`);
            result.ok = false;
        }
    }

    /** Build the conflict-copy path for a synced file. */
    function conflictCopyPath(relPath) {
        const stamp = new Date().toISOString().replaceAll(':', '-');
        const name = deviceName || 'local';
        return path.join(root, 'sync-conflicts', relPath + '.' + name + '.' + stamp + '.conflict');
    }
}

/**
 * Read a file for pushing with stability checks; falls back to a plain read.
 * @param {string} root
 * @param {string} relPath
 * @returns {Promise<Buffer>}
 */
async function readFileForPush(root, relPath) {
    const abs = resolveSyncPath(root, relPath);
    const stable = await readStableFile(abs, 0);
    if (stable) {
        return stable.buffer;
    }
    const { readFile } = await import('node:fs/promises');
    return readFile(abs);
}
