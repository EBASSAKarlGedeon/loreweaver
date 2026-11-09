// Loreweaver sync: browser-facing status endpoints (login-protected).
// Mounted at /api/sync-status. These are for the UI status block only;
// device-to-hub traffic stays on /api/sync with bearer tokens.
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getConfigValue } from '../util.js';
import { requireLoginMiddleware } from '../users.js';

const router = express.Router();

/** Read sync config with safe fallbacks. */
function readSyncConfig() {
    const get = (key, fallback) => {
        try {
            return getConfigValue(key, fallback);
        } catch {
            return fallback;
        }
    };
    return {
        enabled: !!get('sync.enabled', false),
        role: String(get('sync.role', 'client')),
        hubUrl: String(get('sync.hubUrl', '')),
        intervalSeconds: Math.max(10, Number(get('sync.intervalSeconds', 60))),
    };
}

/**
 * GET /api/sync-status — current scheduler state for the logged-in user.
 * Returns 200 with { enabled: false } when sync is off, so the UI can hide.
 */
router.get('/', requireLoginMiddleware, async (_request, response) => {
    const config = readSyncConfig();
    if (!config.enabled) {
        response.json({ enabled: false });
        return;
    }
    const { lastRunResult } = await import('../sync/index.js');
    response.json({
        enabled: true,
        role: config.role,
        hubUrl: config.hubUrl,
        intervalSeconds: config.intervalSeconds,
        lastRun: lastRunResult,
    });
});

/**
 * POST /api/sync-status/run — trigger a sync now (client role only).
 */
router.post('/run', requireLoginMiddleware, async (_request, response) => {
    const config = readSyncConfig();
    if (!config.enabled || config.role !== 'client') {
        response.status(400).json({ error: 'sync not enabled for this role' });
        return;
    }
    const { runSyncOnce } = await import('../sync/index.js');
    const result = await runSyncOnce();
    response.json({ result });
});

/**
 * GET /api/sync-status/conflicts — list conflict copies for the user.
 */
router.get('/conflicts', requireLoginMiddleware, async (request, response) => {
    const handle = request.user?.handle ?? 'default-user';
    const dir = path.join(globalThis.DATA_ROOT, handle, 'sync-conflicts');
    /** @type {{path: string, mtime: number, size: number}[]} */
    const conflicts = [];
    try {
        const walk = (rel) => {
            const abs = path.join(dir, rel);
            for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    walk(path.join(rel, entry.name));
                } else if (entry.isFile() && entry.name.endsWith('.conflict')) {
                    const stat = fs.statSync(path.join(abs, entry.name));
                    conflicts.push({ path: path.join(rel, entry.name).replaceAll('\\', '/'), mtime: stat.mtimeMs, size: stat.size });
                }
            }
        };
        if (fs.existsSync(dir)) {
            walk('');
        }
    } catch { /* no conflicts dir */ }
    conflicts.sort((a, b) => b.mtime - a.mtime);
    response.json({ conflicts: conflicts.slice(0, 100) });
});

export { router };
