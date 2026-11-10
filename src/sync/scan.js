// Loreweaver sync: directory scan + content hashing with a (size, mtime) cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {Object} FileEntry
 * @property {string} hash SHA-256 hex of file bytes
 * @property {number} size File size in bytes
 * @property {number} mtimeMs Last modification time (ms)
 */

/** @returns {string} SHA-256 hex of a buffer */
export function hashBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Scan a directory tree for files.
 * @param {string} rootDir Absolute root to walk
 * @param {string[]} [skipNames] Directory names to skip entirely
 * @param {number} [depth] Max recursion depth (safety bound)
 * @returns {Promise<Map<string, {size: number, mtimeMs: number}>>} Relative paths ('/' separators) -> stat info
 */
export async function walkFiles(rootDir, skipNames = [], depth = 32) {
    const results = new Map();
    const skip = new Set(skipNames);
    async function visit(dir, rel, remaining) {
        if (remaining <= 0) {
            return;
        }
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable or vanished; ignore
        }
        for (const entry of entries) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (skip.has(entry.name)) {
                    continue;
                }
                await visit(path.join(dir, entry.name), relPath, remaining - 1);
            } else if (entry.isFile()) {
                let stat;
                try {
                    stat = await fsp.stat(path.join(dir, entry.name));
                } catch {
                    continue;
                }
                if (stat.isFile()) {
                    results.set(relPath, { size: stat.size, mtimeMs: stat.mtimeMs });
                }
            }
        }
    }
    await visit(rootDir, '', depth);
    return results;
}

/**
 * Hash cache: avoids re-reading files whose (size, mtimeMs) are unchanged.
 * Keys are `${size}:${mtimeMs}`, values the known hash.
 */
export class HashCache {
    constructor(maxEntries = 20000) {
        this.map = new Map();
        this.maxEntries = maxEntries;
    }

    /**
     * Get the cached hash for a stat signature, or undefined.
     * @param {number} size
     * @param {number} mtimeMs
     */
    get(size, mtimeMs) {
        return this.map.get(`${size}:${mtimeMs}`);
    }

    /**
     * Store a hash for a stat signature.
     * @param {number} size
     * @param {number} mtimeMs
     * @param {string} hash
     */
    set(size, mtimeMs, hash) {
        if (this.map.size >= this.maxEntries) {
            // Drop the oldest entry (insertion order).
            const first = this.map.keys().next().value;
            if (first !== undefined) {
                this.map.delete(first);
            }
        }
        this.map.set(`${size}:${mtimeMs}`, hash);
    }
}

/**
 * Produce {path: {hash, size, mtimeMs}} for a walk result, using the cache.
 * Files skipped or unreadable are omitted from the result (treated as absent).
 * @param {string} rootDir Absolute root matching the walk paths
 * @param {Map<string, {size: number, mtimeMs: number}>} files Result of walkFiles
 * @param {HashCache} cache Hash cache
 * @returns {Promise<Map<string, FileEntry>>}
 */
export async function hashFiles(rootDir, files, cache) {
    const out = new Map();
    for (const [relPath, stat] of files) {
        const cached = cache.get(stat.size, stat.mtimeMs);
        if (cached) {
            out.set(relPath, { hash: cached, size: stat.size, mtimeMs: stat.mtimeMs });
            continue;
        }
        try {
            const buf = await fsp.readFile(path.join(rootDir, relPath));
            const hash = hashBuffer(buf);
            cache.set(stat.size, stat.mtimeMs, hash);
            out.set(relPath, { hash, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
            // file vanished mid-scan; omit
        }
    }
    return out;
}

/**
 * Convenience: walk + hash in one call.
 * @param {string} rootDir Absolute root
 * @param {HashCache} cache Hash cache
 * @param {string[]} [skipNames] Directory names to skip
 * @returns {Promise<Map<string, FileEntry>>}
 */
export async function scanDirectory(rootDir, cache, skipNames = []) {
    const files = await walkFiles(rootDir, skipNames);
    return hashFiles(rootDir, files, cache);
}

/**
 * Read a file with a stability check: stat before and after, and reject if the
 * file changed during the read or was modified too recently.
 * @param {string} absPath Absolute path
 * @param {number} [quietMs] Skip if modified within this many ms
 * @returns {Promise<{buffer: Buffer, size: number, mtimeMs: number} | null>} null if skipped or unreadable
 */
export async function readStableFile(absPath, quietMs = 2000) {
    let before;
    try {
        before = await fsp.stat(absPath);
        if (!before.isFile()) {
            return null;
        }
        if (quietMs > 0 && Date.now() - before.mtimeMs < quietMs) {
            return null; // recently modified; pick up next run
        }
        const buffer = await fsp.readFile(absPath);
        const after = await fsp.stat(absPath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            return null; // changed mid-read
        }
        return { buffer, size: before.size, mtimeMs: before.mtimeMs };
    } catch {
        return null;
    }
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * @param {string} absPath Final absolute path
 * @param {Buffer|string} data Content
 * @param {number} [mtimeMs] Optional modification time to set after the write
 *   (ms since epoch). Used to preserve the origin device's mtime so chat-list
 *   ordering survives sync; omitted/invalid leaves the file's real mtime.
 */
export async function atomicWriteFile(absPath, data, mtimeMs) {
    const dir = path.dirname(absPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, absPath);
        if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && mtimeMs > 0) {
            const seconds = mtimeMs / 1000;
            await fsp.utimes(absPath, seconds, seconds);
        }
    } catch (err) {
        try {
            await fsp.unlink(tmp);
        } catch { /* ignore */ }
        throw err;
    }
}

/**
 * Move a file to a trash directory (used by hub deletes and conflict copies).
 * @param {string} absPath Existing file
 * @param {string} trashDir Absolute trash directory
 * @param {string} relName Name to give inside trashDir
 */
export async function moveToTrash(absPath, trashDir, relName) {
    await fsp.mkdir(trashDir, { recursive: true });
    // Mirror the relative path inside trash so browsing is easy.
    const target = path.join(trashDir, relName);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
        await fsp.rename(absPath, target);
    } catch {
        // Cross-device or Windows lock: copy then remove.
        await fsp.copyFile(absPath, target);
        await fsp.unlink(absPath);
    }
}

/** Ensure a directory exists (mkdir -p). */
export async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
}

/** Does a path exist as a file? */
export async function fileExists(p) {
    try {
        const st = await fsp.stat(p);
        return st.isFile();
    } catch {
        return false;
    }
}

// Re-export fs for tests that need the sync API without another import.
export { fs };
