import { afterEach, beforeEach, describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// All sync.* config keys need env vars so getConfigValue never reaches
// getConfig() (which process.exits in tests). Keys are read dynamically by
// the scheduler's readSyncConfig, so every one must exist.
const ALL_SYNC_ENV = {
    SILLYTAVERN_SYNC_ENABLED: 'true',
    SILLYTAVERN_SYNC_ROLE: 'client',
    SILLYTAVERN_SYNC_HUBURL: 'http://127.0.0.1:1',
    SILLYTAVERN_SYNC_TOKEN: 'tok',
    SILLYTAVERN_SYNC_DEVICENAME: '',
    SILLYTAVERN_SYNC_INTERVALSECONDS: '60',
    SILLYTAVERN_SYNC_RETENTIONDAYS: '30',
    SILLYTAVERN_SYNC_HANDLES: '["default-user"]',
};
Object.assign(process.env, ALL_SYNC_ENV);

// Mock users.js: requireLoginMiddleware is a pass-through attaching a fake user.
jest.unstable_mockModule('../../src/users.js', () => ({
    requireLoginMiddleware: (req, res, next) => {
        req.user = { handle: 'default-user' };
        next();
    },
}));

describe('sync-status router', () => {
    let statusRouter;
    let express;
    let request;
    let tmpDir;

    beforeEach(async () => {
        Object.assign(process.env, ALL_SYNC_ENV);
        jest.resetModules();
        express = (await import('express')).default;
        request = (await import('supertest')).default;
        statusRouter = (await import('../../src/endpoints/sync-status.js')).router;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-status-'));
        globalThis.DATA_ROOT = tmpDir;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete globalThis.DATA_ROOT;
        for (const key of Object.keys(ALL_SYNC_ENV)) {
            delete process.env[key];
        }
    });

    function makeApp() {
        const app = express();
        app.use(express.json());
        app.use('/api/sync-status', statusRouter);
        return app;
    }

    test('returns enabled:false when sync is disabled', async () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = '';
        const { router } = await import('../../src/endpoints/sync-status.js');
        const app = express();
        app.use(express.json());
        app.use('/api/sync-status', router);
        const res = await request(app).get('/api/sync-status');
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
    });

    test('status includes lastRun and conflicts list', async () => {
        // Seed a conflict copy.
        const conflictDir = path.join(tmpDir, 'default-user', 'sync-conflicts', 'chats');
        fs.mkdirSync(conflictDir, { recursive: true });
        fs.writeFileSync(path.join(conflictDir, 'chat.conflict'), 'loser');
        const app = makeApp();
        const res = await request(app).get('/api/sync-status');
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(true);
        expect(res.body.role).toBe('client');
        // No sync has run in this process: lastRun is null.
        expect(res.body.lastRun).toBeNull();
        // Conflicts list finds the seeded file.
        const res2 = await request(app).get('/api/sync-status/conflicts');
        expect(res2.status).toBe(200);
        expect(res2.body.conflicts).toHaveLength(1);
        expect(res2.body.conflicts[0].path).toBe('chats/chat.conflict');
        expect(res2.body.conflicts[0].size).toBe(5);
    });

    test('run triggers runSyncOnce and returns its result', async () => {
        const app = makeApp();
        const res = await request(app).post('/api/sync-status/run');
        expect(res.status).toBe(200);
        // Hub is unreachable (127.0.0.1:1): the run reports offline.
        expect(res.body.result).not.toBeNull();
        expect(res.body.result.offline).toBe(true);
    });

    test('run returns 400 when role is hub', async () => {
        process.env.SILLYTAVERN_SYNC_ROLE = 'hub';
        const app = makeApp();
        const res = await request(app).post('/api/sync-status/run');
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('role');
        process.env.SILLYTAVERN_SYNC_ROLE = 'client';
    });
});
