import { describe, test, expect } from '@jest/globals';
import path from 'node:path';
import {
    normalizeSyncPath,
    isSyncPathAllowed,
    validateSyncPath,
    resolveSyncPath,
    SYNCED_DIRS,
    DENY_DIRS,
} from '../../src/sync/paths.js';

describe('normalizeSyncPath', () => {
    test('normalises separators and removes dot segments', () => {
        expect(normalizeSyncPath('chats/foo.jsonl')).toBe('chats/foo.jsonl');
        expect(normalizeSyncPath('chats\\foo.jsonl')).toBe('chats/foo.jsonl');
        expect(normalizeSyncPath('chats/./foo.jsonl')).toBe('chats/foo.jsonl');
        expect(normalizeSyncPath('/chats/foo.jsonl')).toBe('chats/foo.jsonl');
        expect(normalizeSyncPath('chats/foo.jsonl/')).toBe('chats/foo.jsonl');
    });

    test('rejects traversal', () => {
        expect(() => normalizeSyncPath('../x')).toThrow();
        expect(() => normalizeSyncPath('chats/../../x')).toThrow();
        expect(() => normalizeSyncPath('..')).toThrow();
    });

    test('rejects absolute and Windows-style paths', () => {
        expect(() => normalizeSyncPath('C:/x')).toThrow();
        expect(() => normalizeSyncPath('c:\\x')).toThrow();
        expect(() => normalizeSyncPath('\\\\server\\share')).toThrow();
    });

    test('rejects empty, non-string, overlong, and control chars', () => {
        expect(() => normalizeSyncPath('')).toThrow();
        expect(() => normalizeSyncPath(null)).toThrow();
        expect(() => normalizeSyncPath('a\tb')).toThrow();
        expect(() => normalizeSyncPath('a\nb')).toThrow();
        expect(() => normalizeSyncPath('x'.repeat(513))).toThrow();
    });

    test('rejects Windows reserved names', () => {
        expect(() => normalizeSyncPath('chats/CON')).toThrow();
        expect(() => normalizeSyncPath('COM1')).toThrow();
        expect(() => normalizeSyncPath('chats/NUL.txt')).toThrow();
    });

    test('keeps legitimate names that merely look tricky', () => {
        expect(normalizeSyncPath('characters/..dotfile.json')).toBe('characters/..dotfile.json');
        expect(normalizeSyncPath('chats/a..b.jsonl')).toBe('chats/a..b.jsonl');
    });
});

describe('isSyncPathAllowed', () => {
    test('allows synced directories and root files', () => {
        expect(isSyncPathAllowed('chats/foo.jsonl')).toBe(true);
        expect(isSyncPathAllowed('group chats/g.jsonl')).toBe(true);
        expect(isSyncPathAllowed('characters/x.png')).toBe(true);
        expect(isSyncPathAllowed('worlds/w.json')).toBe(true);
        expect(isSyncPathAllowed('settings.json')).toBe(true);
        expect(isSyncPathAllowed('user/files/a.txt')).toBe(true);
    });

    test('denies unknown directories', () => {
        expect(isSyncPathAllowed('not-a-dir/x')).toBe(false);
        expect(isSyncPathAllowed('random.json')).toBe(false);
    });

    test('hard-denies deny-list dirs even though some are also synced-adjacent', () => {
        expect(DENY_DIRS).toContain('thumbnails');
        expect(isSyncPathAllowed('thumbnails/t.png')).toBe(false);
        expect(isSyncPathAllowed('vectors/v.bin')).toBe(false);
        expect(isSyncPathAllowed('backups/b.json')).toBe(false);
        expect(isSyncPathAllowed('extensions/e.js')).toBe(false);
        expect(isSyncPathAllowed('assets/a.mp3')).toBe(false);
        expect(isSyncPathAllowed('sync-trash/x')).toBe(false);
        expect(isSyncPathAllowed('sync-conflicts/x')).toBe(false);
    });

    test('denies secrets and junk files anywhere', () => {
        expect(isSyncPathAllowed('chats/secrets.json')).toBe(false);
        expect(isSyncPathAllowed('chats/SecretsBackup.json')).toBe(false);
        expect(isSyncPathAllowed('chats/.git/config')).toBe(false);
        expect(isSyncPathAllowed('chats/foo.jsonl.tmp')).toBe(false);
        expect(isSyncPathAllowed('user/files/Thumbs.db')).toBe(false);
    });

    test('optional extra allow-list filter can narrow', () => {
        const onlyChats = (first) => first === 'chats';
        expect(isSyncPathAllowed('chats/a.jsonl', onlyChats)).toBe(true);
        expect(isSyncPathAllowed('worlds/w.json', onlyChats)).toBe(false);
    });
});

describe('validateSyncPath', () => {
    test('passes through valid paths', () => {
        expect(validateSyncPath('chats/foo.jsonl')).toBe('chats/foo.jsonl');
    });

    test('throws on malformed', () => {
        expect(() => validateSyncPath('../x')).toThrow('traversal rejected');
    });

    test('throws on not-allowed', () => {
        expect(() => validateSyncPath('thumbnails/t.png')).toThrow('path not allowed');
        expect(() => validateSyncPath('chats/secrets.json')).toThrow('path not allowed');
    });
});

describe('resolveSyncPath', () => {
    test('resolves inside the data root', () => {
        const root = path.resolve('/data/default-user');
        const expected = path.resolve(root, 'chats/foo.jsonl');
        expect(resolveSyncPath(root, 'chats/foo.jsonl')).toBe(expected);
    });

    test('rejects paths that would escape even if normalisation is bypassed', () => {
        // resolveSyncPath assumes a normalised path, but must still refuse escapes.
        expect(() => resolveSyncPath('/data/default-user', '../outside')).toThrow();
    });
});

describe('lists consistency', () => {
    test('SYNCED_DIRS entries have no traversal segments', () => {
        for (const dir of SYNCED_DIRS) {
            expect(dir).not.toContain('..');
        }
    });
});
