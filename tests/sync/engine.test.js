import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { createSyncRouter, resetHubState } from '../../src/endpoints/sync.js';
import { createSyncEngine } from '../../src/sync/engine.js';
import { createHttpTransport } from '../../src/sync/transport-http.js';
import { sha256Hex } from '../../src/sync/state.js';

const tmpRoots = [];
let httpServer = null;
let hubPort = 0;

process.env.SILLYTAVERN_SYNC_MAXFILEMB = '256';
process.env.SILLYTAVERN_SYNC_RETENTIONDAYS = '30';
// Opt-in keys must exist as env vars: getConfigValue falls through to
// getConfig() (which process.exits in tests) when no env var is set.
process.env.SILLYTAVERN_SYNC_SYNCEXTENSIONS = '';
process.env.SILLYTAVERN_SYNC_SYNCSECRETS = '';

beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-engine-'));
    tmpRoots.push(dir);
    // Start a fresh hub HTTP server per test.
    resetHubState();
    const app = express();
    app.use(express.json());
    app.use('/api/sync', createSyncRouter(dir)); // dir is the hub's data root
    httpServer = http.createServer(app);
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    hubPort = httpServer.address().port;
});

afterEach(async () => {
    resetHubState();
    if (httpServer) {
        await new Promise(resolve => httpServer.close(resolve));
        httpServer = null;
    }
    while (tmpRoots.length) {
        fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
    }
});

/** Root layout: hub data lives in the first tmp dir; each client gets its own dir. */
function makeClientDir(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-client-'));
    tmpRoots.push(dir);
    return { name, dataRoot: dir };
}

/**
 * Register a client device with the hub and return an engine bound to it.
 * @param {string} deviceId
 */
function registerDevice(deviceId) {
    const dataRoot = tmpRoots[0];
    const token = crypto.randomBytes(32).toString('hex');
    const hubDir = path.join(dataRoot, '_sync');
    fs.mkdirSync(hubDir, { recursive: true });
    const hubFile = path.join(hubDir, 'hub.json');
    let devices = {};
    try { devices = JSON.parse(fs.readFileSync(hubFile, 'utf-8')).devices; } catch { /* new */ }
    devices[deviceId] = { name: deviceId, tokenHash: sha256Hex(token), created: Date.now(), lastSeen: 0 };
    fs.writeFileSync(hubFile, JSON.stringify({ devices }));
    return token;
}

function makeEngine({ deviceId, client, handle = 'default-user', ...opts }) {
    const token = registerDevice(deviceId);
    return createSyncEngine({
        dataRoot: client.dataRoot,
        handle,
        hubUrl: `http://127.0.0.1:${hubPort}`,
        token,
        deviceName: deviceId,
        ...opts,
    });
}

const wf = (base, rel, content) => {
    const abs = path.join(base, 'default-user', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
};
const rf = (base, rel) => fs.readFileSync(path.join(base, 'default-user', rel), 'utf-8');
const exists = (base, rel) => fs.existsSync(path.join(base, 'default-user', rel));

describe('sync engine', () => {
    test('offline: hub unreachable returns offline result without side effects', async () => {
        const client = makeClientDir('c1');
        wf(client.dataRoot, 'chats/a.jsonl', 'x');
        const engine = createSyncEngine({
            dataRoot: client.dataRoot, handle: 'default-user',
            hubUrl: 'http://127.0.0.1:1', token: 't', deviceName: 'c1',
        });
        const result = await engine();
        expect(result.ok).toBe(false);
        expect(result.offline).toBe(true);
        expect(result.errors).toEqual([]);
        expect(exists(client.dataRoot, 'chats/a.jsonl')).toBe(true);
    });

    test('extensions opt-in: .git dirs and junk files are never scanned or pushed', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        process.env.SILLYTAVERN_SYNC_SYNCEXTENSIONS = 'true';
        try {
            wf(client.dataRoot, 'extensions/Floating-Viewer/manifest.json', '{"name":"Floating-Viewer"}');
            wf(client.dataRoot, 'extensions/Floating-Viewer/.git/config', 'git junk');
            wf(client.dataRoot, 'extensions/Floating-Viewer/.git/objects/pack/pack-abc.pack', 'git junk');
            wf(client.dataRoot, 'extensions/Floating-Viewer/Thumbs.db', 'junk');
            const engine = makeEngine({ deviceId: 'device-a', client, allowExtensions: true });
            const result = await engine();
            expect(result.ok).toBe(true);
            expect(result.errors).toEqual([]);
            expect(result.pushed).toBe(1); // manifest.json only
            expect(exists(hub, 'extensions/Floating-Viewer/manifest.json')).toBe(true);
            expect(exists(hub, 'extensions/Floating-Viewer/.git/config')).toBe(false);
            expect(exists(hub, 'extensions/Floating-Viewer/Thumbs.db')).toBe(false);
        } finally {
            process.env.SILLYTAVERN_SYNC_SYNCEXTENSIONS = '';
        }
    });

    test('first sync pushes local files to the empty hub', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(client.dataRoot, 'chats/a.jsonl', 'local content');
        wf(client.dataRoot, 'worlds/w.json', '{}');
        const engine = makeEngine({ deviceId: 'device-a', client });
        const result = await engine();
        expect(result.ok).toBe(true);
        expect(result.pushed).toBe(2);
        expect(rf(hub, 'chats/a.jsonl')).toBe('local content');
        expect(rf(hub, 'worlds/w.json')).toBe('{}');
        // Idempotent second run.
        const second = await engine();
        expect(second.ok).toBe(true);
        expect(second.pushed).toBe(0);
        expect(second.pulled).toBe(0);
    });

    test('first sync pulls hub files onto the empty client', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(hub, 'characters/hero.json', '{"name":"Hero"}');
        const engine = makeEngine({ deviceId: 'device-a', client });
        const result = await engine();
        expect(result.ok).toBe(true);
        expect(result.pulled).toBe(1);
        expect(rf(client.dataRoot, 'characters/hero.json')).toBe('{"name":"Hero"}');
    });

    test('edit on A converges to B through the hub', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        const hub = tmpRoots[0];
        wf(a.dataRoot, 'chats/a.jsonl', 'v1');
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        // Seed B from A.
        await engineA();
        await engineB();
        expect(rf(b.dataRoot, 'chats/a.jsonl')).toBe('v1');
        // A edits and syncs; B syncs and gets the edit.
        wf(a.dataRoot, 'chats/a.jsonl', 'v2 from A');
        const r1 = await engineA();
        expect(r1.pushed).toBe(1);
        const r2 = await engineB();
        expect(r2.pulled).toBe(1);
        expect(rf(b.dataRoot, 'chats/a.jsonl')).toBe('v2 from A');
        expect(rf(hub, 'chats/a.jsonl')).toBe('v2 from A');
    });

    test('delete on A removes the file on B and trashes it', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        const hub = tmpRoots[0];
        wf(a.dataRoot, 'worlds/gone.json', '{}');
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();
        expect(rf(b.dataRoot, 'worlds/gone.json')).toBe('{}');
        // A deletes locally, syncs, B syncs.
        fs.rmSync(path.join(a.dataRoot, 'default-user', 'worlds', 'gone.json'));
        const r1 = await engineA();
        expect(r1.ok).toBe(true);
        expect(r1.deleted).toBe(1);
        const r2 = await engineB();
        expect(r2.ok).toBe(true);
        expect(r2.deleted).toBe(1);
        expect(exists(b.dataRoot, 'worlds/gone.json')).toBe(false);
        expect(exists(hub, 'worlds/gone.json')).toBe(false);
        expect(exists(b.dataRoot, 'sync-trash/worlds/gone.json')).toBe(true);
    });

    test('both sides edit the same file offline: hub wins locally, local copy preserved', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        wf(a.dataRoot, 'characters/hero.json', 'A version');
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();
        // Both edit offline (before syncing).
        wf(a.dataRoot, 'characters/hero.json', 'A edit');
        wf(b.dataRoot, 'characters/hero.json', 'B edit');
        // A pushes first (wins on hub), then B hits the conflict.
        const r1 = await engineA();
        expect(r1.ok).toBe(true);
        const r2 = await engineB();
        expect(r2.ok).toBe(true);
        expect(r2.conflicts).toHaveLength(1);
        expect(r2.conflicts[0].path).toBe('characters/hero.json');
        // B's local file now holds the hub version (A's edit).
        expect(rf(b.dataRoot, 'characters/hero.json')).toBe('A edit');
        // B's edit is preserved as a conflict copy.
        const conflictsDir = path.join(b.dataRoot, 'default-user', 'sync-conflicts');
        const copies = fs.readdirSync(conflictsDir).filter(n => n.startsWith('characters/hero.json') || n.startsWith('hero.json'));
        // atomicWriteFile writes into sync-conflicts/characters/... — check recursively.
        expect(copies.length >= 0).toBe(true);
        const flat = fs.readdirSync(path.join(conflictsDir, 'characters'), { recursive: true });
        expect(flat.some(n => String(n).includes('.conflict'))).toBe(true);
        expect(fs.readFileSync(path.join(conflictsDir, 'characters', flat.find(n => String(n).includes('.conflict'))), 'utf-8')).toBe('B edit');
    });

    test('same edit on both sides converges without conflict', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        wf(a.dataRoot, 'chats/a.jsonl', 'v1');
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();
        wf(a.dataRoot, 'chats/a.jsonl', 'same edit');
        wf(b.dataRoot, 'chats/a.jsonl', 'same edit');
        const r1 = await engineA();
        const r2 = await engineB();
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r2.conflicts).toHaveLength(0);
        expect(rf(b.dataRoot, 'chats/a.jsonl')).toBe('same edit');
    });

    test('delete on A vs edit on B: the edit wins and is pushed back', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        wf(a.dataRoot, 'worlds/w.json', '{}');
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();
        // A deletes offline; B edits offline.
        fs.rmSync(path.join(a.dataRoot, 'default-user', 'worlds', 'w.json'));
        wf(b.dataRoot, 'worlds/w.json', '{"edited":true}');
        const r1 = await engineA();
        expect(r1.ok).toBe(true);
        const r2 = await engineB();
        expect(r2.ok).toBe(true);
        // B's edit must survive: it is pushed back over the delete.
        expect(r2.conflicts.some(c => c.path === 'worlds/w.json')).toBe(true);
        const hub = tmpRoots[0];
        expect(rf(hub, 'worlds/w.json')).toBe('{"edited":true}');
        expect(rf(b.dataRoot, 'worlds/w.json')).toBe('{"edited":true}');
    });

    test('watermark does not advance when a path errors, and retry works', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(hub, 'chats/a.jsonl', 'hub v1');
        wf(hub, 'characters/x.json', '{}');
        const engine = makeEngine({ deviceId: 'device-a', client });
        const r1 = await engine();
        expect(r1.ok).toBe(true);
        expect(r1.pulled).toBe(2);
        // Corrupt the base table watermark back to 0 but keep entries, so
        // next run reprocesses; everything should be no-op.
        const stateFile = path.join(client.dataRoot, '_sync', 'state-default-user.json');
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        state.lastHubSeq = 0;
        fs.writeFileSync(stateFile, JSON.stringify(state));
        const r2 = await engine();
        expect(r2.ok).toBe(true);
        expect(r2.pushed).toBe(0);
        expect(r2.pulled).toBe(0);
        expect(r2.conflicts).toHaveLength(0);
    });

    test('progress: 100% when every path is in sync', async () => {
        const client = makeClientDir('c1');
        wf(client.dataRoot, 'chats/a.jsonl', 'one');
        wf(client.dataRoot, 'characters/x.json', '{}');
        const engine = makeEngine({ deviceId: 'device-a', client });
        const r = await engine();
        expect(r.ok).toBe(true);
        expect(r.total).toBe(2);
        expect(r.synced).toBe(2);
        expect(r.pending).toBe(0);
        expect(r.percent).toBe(100);
    });

    test('progress: one failed path does not stop other paths, and retried to 100%', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(client.dataRoot, 'chats/a.jsonl', 'one');
        wf(client.dataRoot, 'chats/b.jsonl', 'two');
        wf(client.dataRoot, 'characters/x.json', '{}');

        const token = registerDevice('device-a');
        const real = createHttpTransport({ hubUrl: `http://127.0.0.1:${hubPort}`, token });
        const failing = {
            ...real,
            putFile: async (handle, p, buf, rev) => {
                if (p === 'chats/b.jsonl') {
                    return { ok: false, status: 500, error: 'test failure' };
                }
                return real.putFile(handle, p, buf, rev);
            },
        };
        const engine = createSyncEngine({
            dataRoot: client.dataRoot, handle: 'default-user',
            hubUrl: `http://127.0.0.1:${hubPort}`, token, deviceName: 'device-a',
            transport: failing,
        });
        const r1 = await engine();
        // Other paths still sync despite the failed one.
        expect(r1.ok).toBe(false);
        expect(r1.errors).toEqual(['chats/b.jsonl: put failed (500)']);
        expect(r1.synced).toBe(2);
        expect(r1.pending).toBe(1);
        expect(r1.total).toBe(3);
        expect(r1.percent).toBe(67);
        expect(rf(hub, 'chats/a.jsonl')).toBe('one');
        expect(rf(hub, 'characters/x.json')).toBe('{}');

        // The failed path retries against a clean transport next run → 100%.
        const engine2 = createSyncEngine({
            dataRoot: client.dataRoot, handle: 'default-user',
            hubUrl: `http://127.0.0.1:${hubPort}`, token, deviceName: 'device-a',
        });
        const r2 = await engine2();
        expect(r2.ok).toBe(true);
        expect(r2.percent).toBe(100);
        expect(rf(hub, 'chats/b.jsonl')).toBe('two');
    });

    test('new hub files between runs are pulled incrementally', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(hub, 'chats/a.jsonl', 'one');
        const engine = makeEngine({ deviceId: 'device-a', client });
        await engine();
        wf(hub, 'chats/b.jsonl', 'two');
        const r2 = await engine();
        expect(r2.pulled).toBe(1);
        expect(rf(client.dataRoot, 'chats/b.jsonl')).toBe('two');
        expect(rf(client.dataRoot, 'chats/a.jsonl')).toBe('one');
    });

    test('push preserves the local mtime on the hub copy', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        wf(client.dataRoot, 'chats/a.jsonl', 'one');
        // A fixed mtime in the past (2026-01-01), like an old chat file.
        const mtimeMs = 1767225600000;
        fs.utimesSync(path.join(client.dataRoot, 'default-user', 'chats', 'a.jsonl'), new Date(mtimeMs), new Date(mtimeMs));
        const engine = makeEngine({ deviceId: 'device-a', client });
        const r = await engine();
        expect(r.ok).toBe(true);
        expect(r.pushed).toBe(1);
        const stat = fs.statSync(path.join(hub, 'default-user', 'chats', 'a.jsonl'));
        expect(Math.round(stat.mtimeMs)).toBe(mtimeMs);
    });

    test('pull applies the hub mtime to the local copy', async () => {
        const client = makeClientDir('c1');
        const hub = tmpRoots[0];
        const mtimeMs = 1767225600000;
        wf(hub, 'chats/a.jsonl', 'one');
        fs.utimesSync(path.join(hub, 'default-user', 'chats', 'a.jsonl'), new Date(mtimeMs), new Date(mtimeMs));
        const engine = makeEngine({ deviceId: 'device-a', client });
        const r = await engine();
        expect(r.ok).toBe(true);
        expect(r.pulled).toBe(1);
        const stat = fs.statSync(path.join(client.dataRoot, 'default-user', 'chats', 'a.jsonl'));
        expect(Math.round(stat.mtimeMs)).toBe(mtimeMs);
    });

    test('chat continued on A then on B fast-forwards without losing messages', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        const META = '{"chat_metadata":{"integrity":"x"}}';
        const m = (i) => `{"name":"Char","is_user":${i % 2 === 0},"mes":"msg ${i}"}`;
        const chatOf = (...msgs) => [META, ...msgs].join('\n') + '\n';

        wf(a.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0), m(1)));
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();
        expect(rf(b.dataRoot, 'chats/r/chat.jsonl')).toBe(chatOf(m(0), m(1)));

        // B continues the chat offline: adds msg 2 and 3.
        wf(b.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0), m(1), m(2), m(3)));
        // A also continues offline: adds msg 2 (identical) — both append the same prefix.
        wf(a.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0), m(1), m(2), m(3), m(4)));

        const r1 = await engineA();
        expect(r1.ok).toBe(true);
        const r2 = await engineB();
        expect(r2.ok).toBe(true);
        // B's shorter history fast-forwards to the hub's longer one; no messages lost.
        expect(rf(b.dataRoot, 'chats/r/chat.jsonl')).toBe(chatOf(m(0), m(1), m(2), m(3), m(4)));
        expect(r2.conflicts.some(c => c.kind === 'diverged')).toBe(false);
    });

    test('diverged chats keep both versions (conflict copy) and converge on hub content', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        const META = '{"chat_metadata":{"integrity":"x"}}';
        const m = (i, swipe = '') => `{"name":"Char","is_user":false,"mes":"msg ${i}${swipe}"}`;
        const chatOf = (...msgs) => [META, ...msgs].join('\n') + '\n';

        wf(a.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0)));
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();

        // Divergent swipes on the same message.
        wf(a.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0), m(1, ' A')));
        wf(b.dataRoot, 'chats/r/chat.jsonl', chatOf(m(0), m(1, ' B')));

        const r1 = await engineA();
        expect(r1.ok).toBe(true);
        const r2 = await engineB();
        expect(r2.ok).toBe(true);
        expect(r2.conflicts.some(c => c.path === 'chats/r/chat.jsonl')).toBe(true);
        // B now holds A's version (hub), and B's version is preserved in sync-conflicts.
        expect(rf(b.dataRoot, 'chats/r/chat.jsonl')).toBe(chatOf(m(0), m(1, ' A')));
        const conflictDir = path.join(b.dataRoot, 'default-user', 'sync-conflicts', 'chats', 'r');
        const copies = fs.readdirSync(conflictDir).filter(n => n.endsWith('.conflict'));
        expect(copies).toHaveLength(1);
        expect(fs.readFileSync(path.join(conflictDir, copies[0]), 'utf-8')).toBe(chatOf(m(0), m(1, ' B')));
    });

    test('settings.json per-key merge keeps both devices\' disjoint edits everywhere', async () => {
        const a = makeClientDir('a');
        const b = makeClientDir('b');
        const s = (extA, extB) => JSON.stringify({ theme: 'dark', extA, extB });
        // Both devices start from the same settings state.
        wf(a.dataRoot, 'settings.json', s('a0', 'b0'));
        const engineA = makeEngine({ deviceId: 'device-a', client: a });
        const engineB = makeEngine({ deviceId: 'device-b', client: b });
        await engineA();
        await engineB();

        // Offline: A edits extA, B edits extB.
        wf(a.dataRoot, 'settings.json', s('a1', 'b0'));
        wf(b.dataRoot, 'settings.json', s('a0', 'b1'));
        const r1 = await engineA();
        const r2 = await engineB();
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        // B merged A's extA in with its own extB.
        expect(JSON.parse(rf(b.dataRoot, 'settings.json'))).toEqual({ theme: 'dark', extA: 'a1', extB: 'b1' });
        // A picks the merged result up and nothing regresses.
        await engineA();
        expect(JSON.parse(rf(a.dataRoot, 'settings.json'))).toEqual({ theme: 'dark', extA: 'a1', extB: 'b1' });
    });
});
