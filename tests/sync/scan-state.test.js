import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpRoots = [];

beforeAll(() => {
    // jest with --experimental-vm-modules: ensure env is fine (no-op placeholder).
});

beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-sync-'));
    tmpRoots.push(dir);
});

afterEach(() => {
    jest.restoreAllMocks();
    while (tmpRoots.length) {
        const dir = tmpRoots.pop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('scan.js', () => {
    test('walkFiles enumerates files recursively and skips skipNames', async () => {
        const { walkFiles } = await import('../../src/sync/scan.js');
        const root = tmpRoots[0];
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'one.txt'), 'one');
        fs.writeFileSync(path.join(root, 'a', 'b', 'two.txt'), 'two');
        fs.mkdirSync(path.join(root, 'cache'));
        fs.writeFileSync(path.join(root, 'cache', 'junk.bin'), 'junk');

        const files = await walkFiles(root, ['cache']);
        expect([...files.keys()].sort()).toEqual(['a/b/two.txt', 'a/one.txt']);
        expect(files.get('a/one.txt').size).toBe(3);
    });

    test('hashFiles hashes content and the cache avoids re-reads', async () => {
        const { walkFiles, hashFiles, HashCache, hashBuffer } = await import('../../src/sync/scan.js');
        const root = tmpRoots[0];
        fs.writeFileSync(path.join(root, 'x.txt'), 'hello');
        const files = await walkFiles(root);
        const cache = new HashCache();
        const first = await hashFiles(root, files, cache);
        expect(first.get('x.txt').hash).toBe(hashBuffer(Buffer.from('hello')));

        // Prime cache directly, then hash again: same result.
        const cache2 = new HashCache();
        cache2.set(5, 12345, 'cachedhash');
        const files2 = new Map([['y.txt', { size: 5, mtimeMs: 12345 }]]);
        const second = await hashFiles(root, files2, cache2);
        expect(second.get('y.txt').hash).toBe('cachedhash');
    });

    test('HashCache evicts oldest at capacity', async () => {
        const { HashCache } = await import('../../src/sync/scan.js');
        const cache = new HashCache(2);
        cache.set(1, 1, 'a');
        cache.set(2, 2, 'b');
        cache.set(3, 3, 'c');
        expect(cache.get(1, 1)).toBeUndefined();
        expect(cache.get(2, 2)).toBe('b');
        expect(cache.get(3, 3)).toBe('c');
    });

    test('readStableFile skips recently modified files', async () => {
        const { readStableFile } = await import('../../src/sync/scan.js');
        const file = path.join(tmpRoots[0], 'fresh.txt');
        fs.writeFileSync(file, 'data');
        const result = await readStableFile(file, 2000);
        expect(result).toBeNull(); // just written, within quiet window
    });

    test('readStableFile reads old, stable files', async () => {
        const { readStableFile } = await import('../../src/sync/scan.js');
        const file = path.join(tmpRoots[0], 'old.txt');
        fs.writeFileSync(file, 'data');
        // Backdate mtime past the quiet window.
        const past = Date.now() - 10000;
        fs.utimesSync(file, past / 1000, past / 1000);
        const result = await readStableFile(file, 2000);
        expect(result).not.toBeNull();
        expect(result.buffer.toString()).toBe('data');
    });

    test('atomicWriteFile writes and leaves no temp files', async () => {
        const { atomicWriteFile } = await import('../../src/sync/scan.js');
        const file = path.join(tmpRoots[0], 'sub', 'out.txt');
        await atomicWriteFile(file, 'content');
        expect(fs.readFileSync(file, 'utf-8')).toBe('content');
        const leftovers = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('.'));
        expect(leftovers).toEqual([]);
    });

    test('atomicWriteFile overwrites existing files', async () => {
        const { atomicWriteFile } = await import('../../src/sync/scan.js');
        const file = path.join(tmpRoots[0], 'out.txt');
        fs.writeFileSync(file, 'v1');
        await atomicWriteFile(file, 'v2');
        expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
    });

    test('moveToTrash relocates a file preserving relative structure', async () => {
        const { moveToTrash } = await import('../../src/sync/scan.js');
        const root = tmpRoots[0];
        const file = path.join(root, 'chats', 'old.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'chat data');
        const trash = path.join(root, 'sync-trash');
        await moveToTrash(file, trash, 'chats/old.jsonl');
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.readFileSync(path.join(trash, 'chats', 'old.jsonl'), 'utf-8')).toBe('chat data');
    });

    test('scanDirectory combines walk and hash', async () => {
        const { scanDirectory, HashCache } = await import('../../src/sync/scan.js');
        const root = tmpRoots[0];
        fs.mkdirSync(path.join(root, 'worlds'));
        fs.writeFileSync(path.join(root, 'worlds', 'w.json'), '{}');
        const result = await scanDirectory(root, new HashCache());
        expect(result.get('worlds/w.json').hash).toBe(crypto.createHash('sha256').update('{}').digest('hex'));
    });
});

describe('state.js — device', () => {
    test('loadOrCreateDevice creates and then reuses identity', async () => {
        const { loadOrCreateDevice } = await import('../../src/sync/state.js');
        const root = tmpRoots[0];
        const first = await loadOrCreateDevice(root);
        expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
        const second = await loadOrCreateDevice(root);
        expect(second.deviceId).toBe(first.deviceId);
    });

    test('loadOrCreateDevice regenerates from corrupt file', async () => {
        const { loadOrCreateDevice } = await import('../../src/sync/state.js');
        const root = tmpRoots[0];
        fs.mkdirSync(path.join(root, '_sync'), { recursive: true });
        fs.writeFileSync(path.join(root, '_sync', 'device.json'), '{corrupt');
        const device = await loadOrCreateDevice(root);
        expect(device.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    });
});

describe('state.js — BaseTable', () => {
    test('set/get/delete and persistence round-trip', async () => {
        const { BaseTable } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'state-test.json');
        const t1 = await new BaseTable(file).load();
        t1.set('chats/a.jsonl', { hash: 'h1', size: 1, mtimeMs: 2, hubRev: 3 });
        t1.data.lastHubSeq = 7;
        await t1.save();
        expect(t1.dirty).toBe(false);

        const t2 = await new BaseTable(file).load();
        expect(t2.data.lastHubSeq).toBe(7);
        expect(t2.get('chats/a.jsonl')).toEqual({ hash: 'h1', size: 1, mtimeMs: 2, hubRev: 3 });
        t2.delete('chats/a.jsonl');
        expect(t2.get('chats/a.jsonl')).toBeUndefined();
        expect(t2.paths()).toEqual([]);
        await t2.saveIfDirty();
    });

    test('corrupt state file starts empty', async () => {
        const { BaseTable } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'state-bad.json');
        fs.writeFileSync(file, 'not json');
        const t = await new BaseTable(file).load();
        expect(t.data.lastHubSeq).toBe(0);
        expect(t.paths()).toEqual([]);
    });

    test('saveIfDirty is a no-op when clean', async () => {
        const { BaseTable } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'state-clean.json');
        const t = await new BaseTable(file).load();
        await t.saveIfDirty(); // should not create the file
        expect(fs.existsSync(file)).toBe(false);
    });
});

describe('state.js — ChangeLog', () => {
    test('append assigns increasing seq and persists', async () => {
        const { ChangeLog } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'changes.jsonl');
        const log1 = await new ChangeLog(file).load();
        const e1 = log1.append({ path: 'chats/a.jsonl', op: 'put', hash: 'h', size: 2, deviceId: 'd1' });
        const e2 = log1.append({ path: 'chats/b.jsonl', op: 'put', hash: 'g', size: 3, deviceId: 'd1' });
        expect(e1.seq).toBe(1);
        expect(e2.seq).toBe(2);
        expect(e1.ts).toBeGreaterThan(0);
        expect(log1.currentSeq()).toBe(2);

        const log2 = await new ChangeLog(file).load();
        expect(log2.currentSeq()).toBe(2);
        const e3 = log2.append({ path: 'chats/a.jsonl', op: 'delete', hash: null, size: null, deviceId: 'd1' });
        expect(e3.seq).toBe(3);
    });

    test('since collapses to latest per path and pages', async () => {
        const { ChangeLog } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'changes2.jsonl');
        const log = await new ChangeLog(file).load();
        log.append({ path: 'a', op: 'put', hash: '1', size: 1, deviceId: 'd' });
        log.append({ path: 'b', op: 'put', hash: '2', size: 1, deviceId: 'd' });
        log.append({ path: 'a', op: 'put', hash: '3', size: 1, deviceId: 'd' }); // supersedes seq1

        const all = log.since(0);
        expect(all.changes).toHaveLength(2);
        const a = all.changes.find(c => c.path === 'a');
        expect(a.hash).toBe('3');
        expect(all.changes.every(c => c.seq > 0)).toBe(true);

        const page = log.since(0, 1);
        expect(page.changes).toHaveLength(1);
        expect(page.nextSince).toBe(page.changes[0].seq);
    });

    test('since skips old entries', async () => {
        const { ChangeLog } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'changes3.jsonl');
        const log = await new ChangeLog(file).load();
        log.append({ path: 'a', op: 'put', hash: '1', size: 1, deviceId: 'd' });
        log.append({ path: 'a', op: 'put', hash: '2', size: 1, deviceId: 'd' });
        const rest = log.since(1);
        expect(rest.changes).toHaveLength(1);
        expect(rest.changes[0].hash).toBe('2');
    });

    test('corrupt lines are skipped, not fatal', async () => {
        const { ChangeLog } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'changes4.jsonl');
        fs.writeFileSync(file, '{"seq":1,"path":"a","op":"put"}\nnot json\n{"seq":2,"path":"b","op":"put"}\n');
        const log = await new ChangeLog(file).load();
        expect(log.currentSeq()).toBe(2);
        expect(log.entries).toHaveLength(2);
    });
});

describe('state.js — HubRegistry and helpers', () => {
    test('upsert merges device info', async () => {
        const { HubRegistry } = await import('../../src/sync/state.js');
        const file = path.join(tmpRoots[0], 'hub.json');
        const reg = await new HubRegistry(file).load();
        reg.upsert('d1', { name: 'phone', tokenHash: 'abc' });
        reg.upsert('d1', { name: 'phone2' });
        expect(reg.data.devices.d1.tokenHash).toBe('abc');
        expect(reg.data.devices.d1.name).toBe('phone2');
        await reg.save();

        const reg2 = await new HubRegistry(file).load();
        expect(reg2.data.devices.d1.name).toBe('phone2');
    });

    test('findByTokenHash matches and safeEqual behaves', async () => {
        const { HubRegistry, sha256Hex, safeEqual } = await import('../../src/sync/state.js');
        const reg = await new HubRegistry(path.join(tmpRoots[0], 'hub2.json')).load();
        reg.upsert('d1', { tokenHash: sha256Hex('tok') });
        expect(reg.findByTokenHash(sha256Hex('tok'))?.deviceId).toBe('d1');
        expect(reg.findByTokenHash(sha256Hex('other'))).toBeNull();
        expect(safeEqual('x', 'x')).toBe(true);
        expect(safeEqual('x', 'y')).toBe(false);
    });
});
