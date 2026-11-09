import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pruneRetention, RETENTION_DIRS } from '../../src/sync/retention.js';

describe('sync retention', () => {
    let dataRoot;
    let handle;

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-retention-'));
        handle = 'default-user';
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    /** Create a file with a given age (days ago) under one of the retention dirs. */
    function makeOldFile(dirName, relName, ageDays) {
        const dir = path.join(dataRoot, handle, dirName);
        fs.mkdirSync(path.dirname(path.join(dir, relName)), { recursive: true });
        const abs = path.join(dir, relName);
        fs.writeFileSync(abs, 'stale');
        const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
        fs.utimesSync(abs, mtime, mtime);
        return abs;
    }

    test('RETENTION_DIRS covers trash and conflicts', () => {
        expect(RETENTION_DIRS).toEqual(['sync-trash', 'sync-conflicts']);
    });

    test('deletes files older than retentionDays, keeps newer ones', async () => {
        const oldFile = makeOldFile('sync-trash', 'chats/old.jsonl', 40);
        const newFile = makeOldFile('sync-trash', 'chats/new.jsonl', 1);
        const oldConflict = makeOldFile('sync-conflicts', 'settings.json.dev.x.conflict', 31);
        const newConflict = makeOldFile('sync-conflicts', 'other.conflict', 5);

        const { deleted, errors } = await pruneRetention(dataRoot, [handle], 30);

        expect(errors).toEqual([]);
        expect(deleted).toContain(oldFile);
        expect(deleted).toContain(oldConflict);
        expect(deleted).not.toContain(newFile);
        expect(deleted).not.toContain(newConflict);
        expect(fs.existsSync(newFile)).toBe(true);
        expect(fs.existsSync(newConflict)).toBe(true);
    });

    test('boundary: file exactly at the cutoff is deleted', async () => {
        // 30 days minus a bit: safely expired relative to the 30-day cutoff.
        const file = makeOldFile('sync-trash', 'edge.jsonl', 30.001);
        await pruneRetention(dataRoot, [handle], 30);
        expect(fs.existsSync(file)).toBe(false);
    });

    test('prunes nested directories and collapses emptied parents', async () => {
        makeOldFile('sync-trash', 'chats/deep/nested.jsonl', 60);
        await pruneRetention(dataRoot, [handle], 30);
        expect(fs.existsSync(path.join(dataRoot, handle, 'sync-trash', 'chats'))).toBe(false);
        expect(fs.existsSync(path.join(dataRoot, handle, 'sync-trash', 'chats', 'deep'))).toBe(false);
    });

    test('keeps recently-modified directories even when they hold old files elsewhere', async () => {
        // old file in a subdir, new file in a sibling subdir
        const oldDir = path.join(dataRoot, handle, 'sync-trash', 'chats', 'gone');
        const newDir = path.join(dataRoot, handle, 'sync-trash', 'chats', 'kept');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.mkdirSync(newDir, { recursive: true });
        const oldAbs = path.join(oldDir, 'old.jsonl');
        fs.writeFileSync(oldAbs, 'x');
        const oldM = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldAbs, oldM, oldM);
        const newAbs = path.join(newDir, 'new.jsonl');
        fs.writeFileSync(newAbs, 'y');

        await pruneRetention(dataRoot, [handle], 30);

        expect(fs.existsSync(oldDir)).toBe(false);
        expect(fs.existsSync(newAbs)).toBe(true);
    });

    test('missing retention dirs are not an error', async () => {
        const { deleted, errors } = await pruneRetention(dataRoot, [handle], 30);
        expect(deleted).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('retentionDays <= 0 disables pruning', async () => {
        const file = makeOldFile('sync-trash', 'forever.jsonl', 1000);
        const { deleted } = await pruneRetention(dataRoot, [handle], 0);
        expect(deleted).toEqual([]);
        expect(fs.existsSync(file)).toBe(true);
    });

    test('prunes every handle', async () => {
        fs.mkdirSync(path.join(dataRoot, 'other-user', 'sync-trash'), { recursive: true });
        const otherAbs = path.join(dataRoot, 'other-user', 'sync-trash', 'old.jsonl');
        fs.writeFileSync(otherAbs, 'x');
        const oldM = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        fs.utimesSync(otherAbs, oldM, oldM);

        const { deleted } = await pruneRetention(dataRoot, [handle, 'other-user'], 30);
        expect(deleted).toContain(otherAbs);
        expect(fs.existsSync(otherAbs)).toBe(false);
    });
});
