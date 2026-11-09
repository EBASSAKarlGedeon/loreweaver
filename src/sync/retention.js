// Loreweaver sync: retention — prune sync-trash/ and sync-conflicts/ after
// retentionDays (spec section 7: "Retention"). They are excluded from sync,
// so pruning here never touches synced data.
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Directories pruned, relative to data/<handle>/. */
export const RETENTION_DIRS = ['sync-trash', 'sync-conflicts'];

/**
 * Prune files older than retentionDays from data/<handle>/{sync-trash,sync-conflicts}.
 * Directory mtimes are ignored; only file mtimes count. Directories left empty
 * after pruning are removed (top-down, so parents collapse too).
 * @param {string} dataRoot Absolute path to data/
 * @param {string[]} handles User handles to prune
 * @param {number} retentionDays Keep files younger than this many days; <= 0 disables pruning
 * @returns {Promise<{deleted: string[], errors: string[]}>} Deleted absolute paths and per-path errors
 */
export async function pruneRetention(dataRoot, handles, retentionDays) {
    const deleted = [];
    const errors = [];
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return { deleted, errors };
    }
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const handle of handles) {
        for (const dir of RETENTION_DIRS) {
            await pruneDir(path.join(dataRoot, handle, dir), cutoffMs, deleted, errors);
        }
    }
    return { deleted, errors };
}

/**
 * Recursively delete expired files under one root and collapse empty dirs.
 * One unreadable entry never aborts the walk.
 */
async function pruneDir(absDir, cutoffMs, deleted, errors) {
    let entries;
    try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
        return; // missing or unreadable: nothing to prune
    }
    for (const entry of entries) {
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            await pruneDir(abs, cutoffMs, deleted, errors);
            try {
                const rest = await fsp.readdir(abs);
                if (rest.length === 0) {
                    await fsp.rmdir(abs);
                }
            } catch { /* best effort */ }
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        try {
            const stat = await fsp.stat(abs);
            if (stat.mtimeMs < cutoffMs) {
                await fsp.unlink(abs);
                deleted.push(abs);
            }
        } catch (err) {
            errors.push(`${abs}: ${err?.message ?? String(err)}`);
        }
    }
}
