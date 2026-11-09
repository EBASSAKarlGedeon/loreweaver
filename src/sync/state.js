// Loreweaver sync: persistent state — device identity, hub registry,
// base tables (last-synced snapshot per handle) and the hub change log.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SYNC_DIR = '_sync';

/** Directory holding all sync state, under data root (data/_sync). */
export function syncStateDir(dataRoot) {
    return path.join(dataRoot, SYNC_DIR);
}

/**
 * Load or create the local device identity. Never synced.
 * @param {string} dataRoot Absolute data root (data/)
 * @returns {{deviceId: string, created: number}}
 */
export async function loadOrCreateDevice(dataRoot) {
    const dir = syncStateDir(dataRoot);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'device.json');
    try {
        const raw = await fsp.readFile(file, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0) {
            return parsed;
        }
    } catch { /* fall through to create */ }
    const device = { deviceId: crypto.randomUUID(), created: Date.now() };
    await atomicWriteJson(file, device);
    return device;
}

/**
 * Base table for one handle: what each file looked like at the last successful sync.
 * File: data/_sync/state-<handle>.json  ->  { lastHubSeq, files: { relPath: {hash,size,mtimeMs,hubRev} } }
 */
export class BaseTable {
    constructor(stateFile) {
        this.file = stateFile;
        /** @type {{lastHubSeq: number, files: Record<string, {hash: string, size: number, mtimeMs: number, hubRev: number}>}} */
        this.data = { lastHubSeq: 0, files: {} };
        this.dirty = false;
    }

    /** @returns {Promise<BaseTable>} */
    async load() {
        try {
            const raw = await fsp.readFile(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                this.data = {
                    lastHubSeq: Number(parsed.lastHubSeq) || 0,
                    files: (parsed.files && typeof parsed.files === 'object') ? parsed.files : {},
                };
            }
        } catch { /* missing or corrupt: start empty */ }
        return this;
    }

    async save() {
        await atomicWriteJson(this.file, this.data);
        this.dirty = false;
    }

    /**
     * Get the base entry for a path, or undefined.
     * @param {string} relPath
     */
    get(relPath) {
        return this.data.files[relPath];
    }

    /**
     * Record the new known state of a path.
     * @param {string} relPath
     * @param {{hash: string, size: number, mtimeMs: number, hubRev: number}} entry
     */
    set(relPath, entry) {
        this.data.files[relPath] = entry;
        this.dirty = true;
    }

    /** Remove a path from the table (file deleted and synced). */
    delete(relPath) {
        if (relPath in this.data.files) {
            delete this.data.files[relPath];
            this.dirty = true;
        }
    }

    /** All tracked paths. */
    paths() {
        return Object.keys(this.data.files);
    }

    /** Persist only if something changed. */
    async saveIfDirty() {
        if (this.dirty) {
            await this.save();
        }
    }
}

/**
 * Hub-side change log (JSONL, append-only) plus a rebuildable index.
 * File: data/_sync/changes-<handle>.jsonl
 * Line: { seq, path, op: 'put'|'delete', hash, size, deviceId, ts }
 */
export class ChangeLog {
    constructor(logFile) {
        this.file = logFile;
        /** @type {{path: string, op: string, hash: string|null, size: number|null, seq: number, deviceId: string, ts: number}[]} */
        this.entries = [];
        this.nextSeq = 1;
        this.loaded = false;
    }

    /** Load (or reload) the full log from disk. */
    async load() {
        this.entries = [];
        this.nextSeq = 1;
        let raw = '';
        try {
            raw = await fsp.readFile(this.file, 'utf-8');
        } catch {
            this.loaded = true;
            return this;
        }
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const entry = JSON.parse(trimmed);
                if (entry && typeof entry.seq === 'number') {
                    this.entries.push(entry);
                    if (entry.seq >= this.nextSeq) {
                        this.nextSeq = entry.seq + 1;
                    }
                }
            } catch { /* skip corrupt line */ }
        }
        this.loaded = true;
        return this;
    }

    /**
     * Append a change. Caller supplies everything except seq/ts.
     * @param {{path: string, op: 'put'|'delete', hash: string|null, size: number|null, deviceId: string}} change
     * @returns {object} The stored entry including seq and ts
     */
    append(change) {
        const entry = { seq: this.nextSeq++, ts: Date.now(), ...change };
        this.entries.push(entry);
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf-8');
        return entry;
    }

    /** Highest seq handed out. */
    currentSeq() {
        return this.nextSeq - 1;
    }

    /**
     * Latest entry per path with seq > since, ordered by seq.
     * @param {number} since Return changes with seq > this
     * @param {number} [limit] Max entries returned
     * @returns {{changes: object[], nextSince: number}} nextSince is where the next page should start
     */
    since(since, limit = 5000) {
        /** @type {Map<string, object>} */
        const latest = new Map();
        for (const entry of this.entries) {
            if (entry.seq > since) {
                latest.set(entry.path, entry);
            }
        }
        const changes = [...latest.values()].sort((a, b) => a.seq - b.seq);
        if (changes.length <= limit) {
            return { changes, nextSince: this.currentSeq() };
        }
        const page = changes.slice(0, limit);
        return { changes: page, nextSince: page[page.length - 1].seq };
    }
}

/**
 * Hub device registry. File: data/_sync/hub.json
 * { seq: <unused legacy>, devices: { deviceId: { name, tokenHash, created, lastSeen } } }
 */
export class HubRegistry {
    constructor(file) {
        this.file = file;
        /** @type {{devices: Record<string, {name: string, tokenHash: string, created: number, lastSeen: number}>}} */
        this.data = { devices: {} };
    }

    /** @returns {Promise<HubRegistry>} */
    async load() {
        try {
            const raw = await fsp.readFile(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.devices === 'object') {
                this.data = { devices: parsed.devices };
            }
        } catch { /* start empty */ }
        return this;
    }

    /**
     * Register or refresh a device.
     * @param {string} deviceId
     * @param {{name?: string, tokenHash?: string}} patch
     */
    upsert(deviceId, patch) {
        const existing = this.data.devices[deviceId] ?? { name: '', tokenHash: '', created: Date.now(), lastSeen: 0 };
        const merged = { ...existing, ...patch, lastSeen: Date.now() };
        this.data.devices[deviceId] = merged;
        return merged;
    }

    /**
     * Find a device by token hash (constant-time-ish compare per entry).
     * @param {string} tokenHash sha256 hex of the raw token
     * @returns {{deviceId: string, device: object} | null}
     */
    findByTokenHash(tokenHash) {
        for (const [deviceId, device] of Object.entries(this.data.devices)) {
            if (safeEqual(device.tokenHash ?? '', tokenHash)) {
                return { deviceId, device };
            }
        }
        return null;
    }

    async save() {
        await atomicWriteJson(this.file, this.data);
    }
}

/** sha256 hex of a string (for token hashing). */
export function sha256Hex(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Timing-safe string compare (padded to equal length). */
export function safeEqual(a, b) {
    const ab = Buffer.from(a.padEnd(64, '\0'));
    const bb = Buffer.from(b.padEnd(64, '\0'));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Atomic JSON write: temp + rename. */
export async function atomicWriteJson(file, data) {
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fsp.writeFile(tmp, JSON.stringify(data, null, 4), 'utf-8');
        await fsp.rename(tmp, file);
    } catch (err) {
        try {
            await fsp.unlink(tmp);
        } catch { /* ignore */ }
        throw err;
    }
}

/** Read JSON file or return null on any failure. */
export async function readJsonOrNull(file) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf-8'));
    } catch {
        return null;
    }
}
