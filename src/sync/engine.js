// Loreweaver sync: client-side engine implementing the spec's section 6 algorithm.
// One run = hello -> scan -> diff -> push/pull -> update base table.
import path from 'node:path';

import {
    SYNCED_DIRS,
    SYNCED_ROOT_FILES,
    isSyncPathAllowed,
    resolveSyncPath,
} from './paths.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
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
import { planMerge } from './merge.js';
import { SETTINGS_PATH, mergeSettingsBuffers } from './settings-merge.js';

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
 * @property {number} total Paths in scope this run
 * @property {number} synced Paths confirmed in sync (settled, no error)
 * @property {number} pending Paths that errored or need another run
 * @property {number} percent 0-100 share of paths confirmed
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
        settingsWinner = 'hub',
        allowExtensions = false,
        allowSecrets = false,
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
        const skip = ['sync-trash', 'sync-conflicts', '_sync', 'node_modules', '.git'];
        // Opt-in dirs/files extend the standard synced set.
        const dirs = [...SYNCED_DIRS];
        if (allowExtensions && !dirs.includes(USER_DIRECTORY_TEMPLATE.extensions)) {
            dirs.push(USER_DIRECTORY_TEMPLATE.extensions);
        }
        const rootFiles = [...SYNCED_ROOT_FILES];
        if (allowSecrets) {
            rootFiles.push('secrets.json');
        }
        for (const dir of dirs) {
            const scanned = await scanDirectory(path.join(root, dir), cache, skip);
            for (const [rel, entry] of scanned) {
                const relPath = `${dir}/${rel}`;
                // Never push paths the hub would deny (e.g. .git, Thumbs.db,
                // nested secrets*): it would 400 and wedge the watermark.
                if (isSyncPathAllowed(relPath, null, { allowExtensions, allowSecrets })) {
                    current.set(relPath, entry);
                }
            }
        }
        for (const file of rootFiles) {
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
        // total/synced/pending/percent: porting confirmation over all paths
        // in scope this run (pending = errored or drifted here; those retry next run).
        const result = {
            ok: true, offline: false,
            pushed: 0, pulled: 0, deleted: 0, skipped: 0,
            conflicts: [], errors: [], hubSeq: 0,
            total: 0, synced: 0, pending: 0, percent: 100,
        };

        // 1. Hello.
        const device = await loadOrCreateDevice(dataRoot);
        const hello = await transport.hello(handle, deviceName || device.deviceId, 1);
        if (!hello.ok) {
            result.ok = false;
            result.offline = hello.status === 0;
            result.percent = 0; // nothing confirmed while unreachable/failing to start
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
        result.total = allPaths.size;
        for (const relPath of allPaths) {
            const before = { errors: result.errors.length, skipped: result.skipped };
            try {
                await processPath(relPath, local, base, remote, result);
            } catch (err) {
                result.errors.push(`${relPath}: ${err?.message ?? String(err)}`);
                result.ok = false;
            }
            // A path is confirmed when it finished without an error or a skip
            // (both retry next run); successful pushes/pulls/deletes are
            // settled by the base table in the same pass.
            if (result.errors.length > before.errors || result.skipped > before.skipped) {
                result.pending++;
            } else {
                result.synced++;
            }
        }
        result.percent = result.total ? Math.round(((result.total - result.pending) / result.total) * 100) : 100;

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
                const put = await transport.putFile(handle, relPath, await readFileForPush(root, relPath), B?.hubRev ?? 0, L.mtimeMs);
                if (put.ok) {
                    base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: put.json.seq });
                    await snapshotSettingsBase(relPath, await readFileForPush(root, relPath));
                    result.pushed++;
                } else if (put.status === 409) {
                    await handleConflict(relPath, L, syntheticChange(put.json), base, result);
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
                    await handleConflict(relPath, null, syntheticChange(del.json), base, result);
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
        await handleConflict(relPath, L, change, base, result);
    }

    /**
     * Build a hub-change-shaped object from the 409 response body
     * ({currentHash, currentRev, deleted?}) so handleConflict always has
     * real hub state to work with.
     * @param {any} json
     * @returns {object|null}
     */
    function syntheticChange(json) {
        if (!json || typeof json !== 'object') {
            return null;
        }
        if (json.deleted) {
            return { seq: json.currentRev, op: 'delete', hash: null, size: null, path: '' };
        }
        return { seq: json.currentRev, op: 'put', hash: json.currentHash, size: null, path: '' };
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
        // The hub may have drifted since the change entry was written (its own
        // ST instance rewrites files between log entries). The /file endpoint
        // hashes the exact bytes it sends, so got.hash always describes
        // got.body: record the actual content and rev it to this change. The
        // hub's applyLocalDrift logs the drifted content on the next /changes,
        // and the recorded hash then matches — no skip-and-retry livelock.
        await atomicWriteFile(resolveSyncPath(root, relPath), got.body, got.mtimeMs);
        base.set(relPath, { hash: got.hash ?? R.hash, size: got.body.length, mtimeMs: got.mtimeMs ?? Date.now(), hubRev: change?.seq ?? R.rev });
        await snapshotSettingsBase(relPath, got.body);
        result.pulled++;
    }

    /**
     * Conflict resolution entry point. Tries planMerge (chat prefix
     * fast-forward, delete-vs-edit rules) before falling back to Rule B.
     * @param {string} relPath
     * @param {{hash: string, size: number, mtimeMs: number}|null} L Local entry (null = deleted locally)
     * @param {object|null} change Latest hub change for the path (null = unchanged since base)
     * @param {BaseTable} base
     * @param {SyncRunResult} result
     */
    async function handleConflict(relPath, L, change, base, result) {
        const hubDeleted = change ? change.op === 'delete' : false;
        try {
            const localBuffer = L ? await readFileForPush(root, relPath) : null;

            // Fetch the hub version when the hub has content.
            let hubBuffer = null;
            if (!hubDeleted && change) {
                const got = await transport.getFile(handle, relPath);
                if (!got.ok) {
                    result.errors.push(`${relPath}: conflict get failed (${got.status})`);
                    result.ok = false;
                    return;
                }
                hubBuffer = got.body;
            }

            const plan = planMerge(relPath, localBuffer, hubBuffer);

            // settings.json: 3-way per-key merge instead of last-writer-wins,
            // so theme/extensions/persona edits from both devices survive.
            // On parse failure fall through to the generic plan below.
            if (relPath === SETTINGS_PATH && hubBuffer && localBuffer) {
                const baseBuf = await readBaseEntryBuffer(relPath);
                const merged = mergeSettingsBuffers(baseBuf, localBuffer, hubBuffer, settingsWinner);
                if (merged.ok) {
                    const put = await transport.putFile(handle, relPath, merged.content, change?.seq ?? 0, L.mtimeMs);
                    if (put.ok) {
                        // Land the merge locally too — otherwise the next run
                        // sees local ≠ base and pushes the pre-merge file back,
                        // clobbering the other device's keys.
                        await atomicWriteFile(resolveSyncPath(root, relPath), merged.content);
                        base.set(relPath, { hash: hashBuffer(merged.content), size: merged.content.length, mtimeMs: Date.now(), hubRev: put.json.seq });
                        await snapshotSettingsBase(relPath, merged.content);
                        result.pushed++;
                        if (merged.conflictKeys?.length) {
                            result.conflicts.push({ path: relPath, kind: `settings-merge (${merged.conflictKeys.length} keys)` });
                        }
                    } else if (put.status === 409) {
                        // Hub moved on again; the next run re-merges against the newer state.
                        result.skipped++;
                    } else {
                        result.errors.push(`${relPath}: merged put failed (${put.status})`);
                        result.ok = false;
                    }
                    return;
                }
            }

            if (plan.action === 'fast-forward' && plan.winner === 'local') {
                // Local continuation wins: push it.
                const put = await transport.putFile(handle, relPath, plan.content, change?.seq ?? 0, L.mtimeMs);
                if (!put.ok) {
                    result.errors.push(`${relPath}: fast-forward push failed (${put.status})`);
                    result.ok = false;
                    return;
                }
                base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: put.json.seq });
                result.pushed++;
                result.conflicts.push({ path: relPath, kind: 'fast-forward-local' });
                return;
            }

            if (plan.action === 'fast-forward' || plan.action === 'hub') {
                if (plan.action === 'hub' && localBuffer && hubBuffer) {
                    // Real Rule B conflict. Preserve the local loser only when
                    // the pull below will actually land: writing it first made
                    // a failed/skipped pull repeat the conflict next run and
                    // pile up copies.
                    const R = { hash: change.hash, size: change.size, rev: change.seq };
                    const pulled = await pullRemoteBuffer(relPath, R, change, base, result);
                    if (pulled) {
                        await atomicWriteFile(conflictCopyPath(relPath), localBuffer);
                    }
                    result.conflicts.push({ path: relPath, kind: plan.action === 'fast-forward' ? 'fast-forward-hub' : (hubDeleted ? 'delete-edit' : 'diverged') });
                    return;
                }
                const R = { hash: change.hash, size: change.size, rev: change.seq };
                await pullRemote(relPath, R, change, base, result);
                result.conflicts.push({ path: relPath, kind: plan.action === 'fast-forward' ? 'fast-forward-hub' : (hubDeleted ? 'delete-edit' : 'diverged') });
                return;
            }

            if (plan.action === 'local') {
                // Edit-vs-delete: push the local version back.
                const put = await transport.putFile(handle, relPath, localBuffer, change?.seq ?? 0, L.mtimeMs);
                if (put.ok) {
                    base.set(relPath, { hash: L.hash, size: L.size, mtimeMs: L.mtimeMs, hubRev: put.json.seq });
                    result.pushed++;
                    result.conflicts.push({ path: relPath, kind: 'delete-edit' });
                } else {
                    result.errors.push(`${relPath}: conflict put failed (${put.status})`);
                    result.ok = false;
                }
                return;
            }

            // 'manual': both sides deleted — settle the tombstone.
            base.delete(relPath);
            result.deleted++;
        } catch (err) {
            result.errors.push(`${relPath}: conflict handling failed: ${err?.message ?? String(err)}`);
            result.ok = false;
        }
    }

    /**
     * Read the snapshot of the last-synced settings.json (the merge
     * ancestor). Written by snapshotSettingsBase on every successful
     * pull/push; null when unavailable.
     * @param {string} relPath
     * @returns {Promise<Buffer|null>}
     */
    async function readBaseEntryBuffer(relPath) {
        if (relPath !== SETTINGS_PATH) {
            return null;
        }
        try {
            const { readFile } = await import('node:fs/promises');
            return await readFile(settingsBaseSnapshotPath());
        } catch {
            return null;
        }
    }

    /** Persist the common-ancestor bytes for settings.json. */
    async function snapshotSettingsBase(relPath, buffer) {
        if (relPath !== SETTINGS_PATH || !buffer) {
            return;
        }
        try {
            await atomicWriteFile(settingsBaseSnapshotPath(), buffer);
        } catch { /* best effort; merge still works with a stale/null ancestor */ }
    }

    /** Absolute path of the settings ancestor snapshot (not synced). */
    function settingsBaseSnapshotPath() {
        return path.join(syncStateDir(dataRoot), `settings-base-${handle}.json`);
    }

    /**
     * Pull the hub version, returning true when written. Does not touch
     * result counters (caller reports the outcome).
     */
    async function pullRemoteBuffer(relPath, R, change, base, result) {
        const got = await transport.getFile(handle, relPath);
        if (!got.ok) {
            result.errors.push(`${relPath}: conflict get failed (${got.status})`);
            result.ok = false;
            return false;
        }
        // Same rule as pullRemote: trust the actual bytes (got.hash describes
        // got.body exactly), not the possibly-stale change-entry hash.
        await atomicWriteFile(resolveSyncPath(root, relPath), got.body, got.mtimeMs);
        base.set(relPath, { hash: got.hash ?? R.hash, size: got.body.length, mtimeMs: got.mtimeMs ?? Date.now(), hubRev: change?.seq ?? R.rev });
        await snapshotSettingsBase(relPath, got.body);
        return true;
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
