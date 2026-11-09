import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { createSyncRouter, resetHubState } from '../../src/endpoints/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'sync-token.js');

const tmpRoots = [];

// Opt-in keys must exist as env vars: getConfigValue falls through to
// getConfig() (which process.exits in tests) when no env var is set.
process.env.SILLYTAVERN_SYNC_SYNCEXTENSIONS = '';
process.env.SILLYTAVERN_SYNC_SYNCSECRETS = '';

beforeEach(() => {
    tmpRoots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-token-')));
});

afterEach(() => {
    resetHubState();
    while (tmpRoots.length) {
        fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
    }
});

function runCli(args, cwd) {
    return execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
    });
}

describe('sync-token CLI', () => {
    test('create writes a hashed token and the token authenticates', async () => {
        const dataRoot = tmpRoots[0];
        const output = runCli(['create', 'test-phone', '--dataRoot', dataRoot]);
        expect(output).toContain('test-phone');
        // The token line: a 64-hex string in the output.
        const tokenMatch = output.match(/\b[0-9a-f]{64}\b/);
        expect(tokenMatch).toBeTruthy();
        const token = tokenMatch[0];
        // Only the hash must be stored.
        const hub = JSON.parse(fs.readFileSync(path.join(dataRoot, '_sync', 'hub.json'), 'utf-8'));
        const devices = Object.entries(hub.devices);
        expect(devices).toHaveLength(1);
        const [, device] = devices[0];
        expect(device.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
        expect(device.name).toBe('test-phone');
        expect(JSON.stringify(hub)).not.toContain(token);
        // The token must authenticate against the real router.
        const app = express();
        app.use(express.json());
        app.use('/api/sync', createSyncRouter(dataRoot));
        const res = await request(app).post('/api/sync/hello?handle=default-user')
            .set('Authorization', `Bearer ${token}`).send({ name: 'test-phone' });
        expect(res.status).toBe(200);
    });

    test('revoke stops the token from authenticating', async () => {
        const dataRoot = tmpRoots[0];
        const output = runCli(['create', 'dev2', '--dataRoot', dataRoot]);
        const token = output.match(/\b[0-9a-f]{64}\b/)[0];
        const hub = JSON.parse(fs.readFileSync(path.join(dataRoot, '_sync', 'hub.json'), 'utf-8'));
        const deviceId = Object.keys(hub.devices)[0];
        runCli(['revoke', deviceId, '--dataRoot', dataRoot]);
        const hubAfter = JSON.parse(fs.readFileSync(path.join(dataRoot, '_sync', 'hub.json'), 'utf-8'));
        expect(hubAfter.devices[deviceId]).toBeUndefined();
        const app = express();
        app.use(express.json());
        app.use('/api/sync', createSyncRouter(dataRoot));
        const res = await request(app).post('/api/sync/hello?handle=default-user')
            .set('Authorization', `Bearer ${token}`).send({});
        expect(res.status).toBe(401);
    });

    test('list shows devices and lastSeen updates after hello', async () => {
        const dataRoot = tmpRoots[0];
        const output = runCli(['create', 'dev3', '--dataRoot', dataRoot]);
        const token = output.match(/\b[0-9a-f]{64}\b/)[0];
        const app = express();
        app.use(express.json());
        app.use('/api/sync', createSyncRouter(dataRoot));
        await request(app).post('/api/sync/hello?handle=default-user')
            .set('Authorization', `Bearer ${token}`).send({});
        const list = runCli(['list', '--dataRoot', dataRoot]);
        expect(list).toContain('dev3');
        expect(list).not.toContain('never');
    });

    test('revoke with unknown id fails cleanly', () => {
        const dataRoot = tmpRoots[0];
        expect(() => runCli(['revoke', 'no-such-id', '--dataRoot', dataRoot])).toThrow();
    });
});
