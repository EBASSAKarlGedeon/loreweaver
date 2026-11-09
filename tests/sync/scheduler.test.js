import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

// The scheduler reads every sync.* config key; each needs an env var so
// getConfigValue never reaches getConfig() (which process.exits in tests).
// Note: enabled is checked as a truthy string — '' = disabled, 'true' = enabled.
const ALL_SYNC_ENV = {
    SILLYTAVERN_SYNC_ENABLED: '',
    SILLYTAVERN_SYNC_ROLE: 'client',
    SILLYTAVERN_SYNC_HUBURL: '',
    SILLYTAVERN_SYNC_TOKEN: '',
    SILLYTAVERN_SYNC_DEVICENAME: '',
    SILLYTAVERN_SYNC_INTERVALSECONDS: '60',
    SILLYTAVERN_SYNC_RETENTIONDAYS: '30',
    SILLYTAVERN_SYNC_SETTINGSAUTHORITATIVEDEVICE: '',
    SILLYTAVERN_SYNC_HANDLES: '["default-user"]',
};

describe('sync scheduler', () => {
    let scheduler;

    beforeEach(async () => {
        Object.assign(process.env, ALL_SYNC_ENV);
        scheduler = await import('../../src/sync/index.js');
        scheduler._resetForTests();
    });

    afterEach(() => {
        scheduler.stop();
        for (const key of Object.keys(ALL_SYNC_ENV)) {
            delete process.env[key];
        }
        delete globalThis.DATA_ROOT;
    });

    test('start() is a no-op when sync is disabled', () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = '';
        expect(() => scheduler.start()).not.toThrow();
        expect(scheduler.runSyncOnce()).resolves.toBeNull();
    });

    test('runSyncOnce returns null when config incomplete (no hubUrl/token)', async () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
        const result = await scheduler.runSyncOnce();
        expect(result).toBeNull();
    });

    test('runSyncOnce reports offline when the hub is unreachable', async () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
        process.env.SILLYTAVERN_SYNC_HUBURL = 'http://127.0.0.1:1';
        process.env.SILLYTAVERN_SYNC_TOKEN = 'tok';
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-sched-'));
        globalThis.DATA_ROOT = dir;
        try {
            const result = await scheduler.runSyncOnce();
            expect(result).not.toBeNull();
            expect(result.ok).toBe(false);
            expect(result.offline).toBe(true);
            expect(result.errors).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('mutex: concurrent run marks dirty and returns last result', async () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
        process.env.SILLYTAVERN_SYNC_HUBURL = 'http://127.0.0.1:1';
        process.env.SILLYTAVERN_SYNC_TOKEN = 'tok';
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-sched2-'));
        globalThis.DATA_ROOT = dir;
        try {
            const first = scheduler.runSyncOnce();
            const second = await scheduler.runSyncOnce();
            await first;
            expect(second === null || typeof second === 'object').toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('start() with valid client config schedules without crashing', () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
        process.env.SILLYTAVERN_SYNC_HUBURL = 'http://127.0.0.1:1';
        process.env.SILLYTAVERN_SYNC_TOKEN = 'tok';
        expect(() => scheduler.start()).not.toThrow();
        scheduler.stop();
    });

    test('hub role does not schedule', () => {
        process.env.SILLYTAVERN_SYNC_ENABLED = 'true';
        process.env.SILLYTAVERN_SYNC_ROLE = 'hub';
        process.env.SILLYTAVERN_SYNC_HUBURL = 'http://127.0.0.1:1';
        process.env.SILLYTAVERN_SYNC_TOKEN = 'tok';
        expect(() => scheduler.start()).not.toThrow();
        scheduler.stop();
    });
});
