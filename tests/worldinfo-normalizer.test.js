import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readWorldInfoFile } from '../src/endpoints/worldinfo.js';
import { normalizeWorldInfoUids } from '../src/worldinfo-normalizer.js';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('normalizeWorldInfoUids', () => {
    test('assigns missing numeric uids from numeric object keys', () => {
        const first = { content: 'one' };
        const second = { content: 'two' };
        const world = { entries: { 0: first, 1: second } };

        const result = normalizeWorldInfoUids(world);

        expect(result).toBe(world);
        expect(Object.keys(result.entries)).toEqual(['0', '1']);
        expect(result.entries['0']).toBe(first);
        expect(first.uid).toBe(0);
        expect(second.uid).toBe(1);
        expect(first.extensions).toBeUndefined();
    });

    test('converts array entries to an object instead of hiding them', () => {
        const first = { content: 'one' };
        const second = { content: 'two' };
        const world = { entries: [first, second] };

        const result = normalizeWorldInfoUids(world);

        expect(Array.isArray(result.entries)).toBe(false);
        expect(Object.keys(result.entries)).toEqual(['0', '1']);
        expect(result.entries['0']).toBe(first);
        expect(result.entries['1']).toBe(second);
        expect(first.uid).toBe(0);
        expect(second.uid).toBe(1);
    });

    test('rekeys semantic keys to their existing numeric uid and keeps the legacy key', () => {
        const first = { uid: 1, content: 'first', extensions: { legacy_id: 'OLD', keep: true } };
        const second = { uid: 2, content: 'second' };
        const world = { entries: { 'SKILLS-HUB': first, 'SKILL-INT': second } };

        const result = normalizeWorldInfoUids(world);

        expect(Object.keys(result.entries)).toEqual(['1', '2']);
        expect(first.uid).toBe(1);
        expect(second.uid).toBe(2);
        expect(first.extensions).toEqual({ legacy_id: 'OLD', keep: true });
        expect(second.extensions).toEqual({ legacy_id: 'SKILL-INT' });
    });

    test('preserves self-addressed string uids', () => {
        const entry = { uid: 'jle_1791745242072_0', content: 'x' };
        const world = { entries: { jle_1791745242072_0: entry } };

        const result = normalizeWorldInfoUids(world);

        expect(Object.keys(result.entries)).toEqual(['jle_1791745242072_0']);
        expect(result.entries.jle_1791745242072_0).toBe(entry);
        expect(entry.uid).toBe('jle_1791745242072_0');
        expect(entry.extensions).toBeUndefined();
    });

    test('preserves an existing numeric uid of zero', () => {
        const entry = { uid: 0, content: 'x' };
        const world = { entries: { 0: entry } };

        normalizeWorldInfoUids(world);

        expect(entry.uid).toBe(0);
        expect(Object.keys(world.entries)).toEqual(['0']);
    });

    test('resolves duplicate uids without dropping either entry', () => {
        const first = { uid: 7, content: 'first' };
        const second = { uid: 7, content: 'second' };
        const world = { entries: { foo: first, bar: second } };

        const result = normalizeWorldInfoUids(world);

        expect(Object.values(result.entries)).toHaveLength(2);
        expect(Object.values(result.entries)).toEqual(expect.arrayContaining([first, second]));
        expect(first.uid).toBe(7);
        expect(second.uid).toBe('bar');
        expect(Object.keys(result.entries).sort()).toEqual(['7', 'bar']);
    });

    test('is idempotent', () => {
        const world = { entries: [{ content: 'one' }, { uid: 5, content: 'two' }] };
        normalizeWorldInfoUids(world);
        const snapshot = JSON.parse(JSON.stringify(world));

        normalizeWorldInfoUids(world);

        expect(JSON.parse(JSON.stringify(world))).toEqual(snapshot);
    });

    test('leaves a world without an entries list alone', () => {
        const world = { name: 'not-a-world' };

        expect(normalizeWorldInfoUids(world)).toBe(world);
        expect(world.entries).toBeUndefined();
    });

    test('normalizes while reading a world file', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-worldinfo-'));
        temporaryDirectories.push(directory);
        fs.writeFileSync(path.join(directory, 'book.json'), JSON.stringify({
            entries: { 0: { content: 'one' }, 1: { content: 'two' } },
        }));

        const result = readWorldInfoFile({ worlds: directory }, 'book', false);

        expect(Object.keys(result.entries)).toEqual(['0', '1']);
        expect(result.entries['0'].uid).toBe(0);
        expect(result.entries['1'].uid).toBe(1);
    });
});
