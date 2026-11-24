import { describe, test, expect } from '@jest/globals';
import {
    JANITOR_SCRIPT_TYPES,
    classifyJanitorLorebook,
    janitorLorebookName,
    janitorLorebookRefs,
    janitorScriptEntries,
    janitorScriptToCharacterBook,
} from '../../src/endpoints/weavers-vault-janitor.js';

/**
 * Payloads below are the live shapes measured 2026-11-26 against janitorai.com
 * (15 requests). Do not "improve" them from Glaze's Dart — the site is the
 * contract, and these are what it actually sends.
 */

/** `scripts[]` of "Hero World RPG" (d818757e-…): two PUBLIC books. */
function publicCardScripts() {
    return [
        {
            type: 'lorebook',
            id: '47c1eed5-f087-4777-a8ed-e37f0c3990b5',
            title: 'Heroes and Villains',
            description: 'Information about heroes and Villains in this RPG',
            theme: 'red',
            user_id: 'b745f52e-5bec-49d5-b299-03b54708ba80',
            user_name: '1Reika2',
            is_public: true,
            updated_at: '2026-08-08T18:57:45.762+00:00',
            message_count: 51336,
        },
        {
            type: 'lorebook',
            id: '962089bf-647c-42c1-ab2d-2ab6b8de1abe',
            title: 'World Info',
            description: 'Information about this world',
            theme: 'sky',
            is_public: true,
            message_count: 71726,
        },
    ];
}

/** `scripts[]` of "Avery & Ren": three PRIVATE books (all 404 on fetch). */
function privateCardScripts() {
    return [
        {
            type: 'lorebook',
            id: 'ca5e8a30-ebd6-4afe-9e4d-fbf000eb301d',
            title: "Misty Moon's Pizza & Burgers",
            description: '',
            theme: 'mint',
            is_public: false,
            message_count: 1642321,
        },
    ];
}

/** A measurement of `GET /hampter/script/{id}` for a public book. */
function publicScriptRecord() {
    return {
        type: 'lorebook',
        id: '962089bf-647c-42c1-ab2d-2ab6b8de1abe',
        title: 'World Info',
        description: 'Information about this world',
        is_public: true,
        is_code_public: null,
        depth: 4,
        // The site sends the array as a STRING (measured).
        script: JSON.stringify([
            {
                category: 'general',
                content: 'Hero System\nHero Agency\nThe Hero Agency is a global organization…',
                enabled: true,
                id: '4895fd2e-65fd-480f-9c39-e799a30eab74',
                key: ['World', 'info', 'lore', 'history', 'society', 'heroes', 'villains'],
                keysRaw: 'World, info, lore, history, society, heroes, villains',
                minMessages: 0,
                priority: 1,
                probability: 100,
                insertion_order: 100,
                keywordsRaw: '',
                constant: true,
            },
        ]),
    };
}

const ok = (record) => ({ status: 200, body: JSON.stringify(record) });

describe('janitorLorebookRefs', () => {
    test('reads both public books off the measured card', () => {
        const refs = janitorLorebookRefs({ scripts: publicCardScripts() });
        expect(refs).toHaveLength(2);
        expect(refs[0]).toMatchObject({
            id: '47c1eed5-f087-4777-a8ed-e37f0c3990b5',
            title: 'Heroes and Villains',
            description: 'Information about heroes and Villains in this RPG',
            type: 'lorebook',
            isPublic: true,
        });
        expect(refs[1].title).toBe('World Info');
    });

    test('a card with no books sends an empty array — and null must behave the same', () => {
        expect(janitorLorebookRefs({ scripts: [] })).toEqual([]);
        expect(janitorLorebookRefs({ scripts: null })).toEqual([]);
        expect(janitorLorebookRefs({})).toEqual([]);
        expect(janitorLorebookRefs(null)).toEqual([]);
    });

    test('is_public:false is carried as isPublic:false, not dropped', () => {
        const refs = janitorLorebookRefs({ scripts: privateCardScripts() });
        expect(refs).toHaveLength(1);
        expect(refs[0].isPublic).toBe(false);
    });

    test('keeps `advanced` and drops non-lorebook scripts', () => {
        const refs = janitorLorebookRefs({
            scripts: [
                { type: 'advanced', id: 'a', title: 'A', is_public: true },
                { type: 'persona', id: 'b', title: 'B', is_public: true },
                { type: 'lorebook', title: 'no id', is_public: true },
                { type: 'lorebook', id: 'c', title: 'C', is_public: true },
            ],
        });
        expect(refs.map(r => r.id)).toEqual(['a', 'c']);
        expect(JANITOR_SCRIPT_TYPES).toContain('advanced');
    });

    test('de-duplicates by id (a listing/page shift can repeat one)', () => {
        const refs = janitorLorebookRefs({
            scripts: [
                { type: 'lorebook', id: 'x', title: 'One', is_public: true },
                { type: 'lorebook', id: 'x', title: 'One again', is_public: true },
            ],
        });
        expect(refs).toHaveLength(1);
    });

    test('treats a non-boolean is_public defensively', () => {
        const refs = janitorLorebookRefs({
            scripts: [
                { type: 'lorebook', id: '0', title: 'zero', is_public: 0 },
                { type: 'lorebook', id: 's', title: 'string', is_public: 'false' },
                { type: 'lorebook', id: '1', title: 'one', is_public: 1 },
                { type: 'lorebook', id: 'm', title: 'missing' },
            ],
        });
        expect(refs.map(r => r.isPublic)).toEqual([false, false, true, true]);
    });
});

describe('janitorScriptEntries', () => {
    test('parses the JSON-array-in-a-string shape the site sends', () => {
        const { entries, jsSource } = janitorScriptEntries(publicScriptRecord());
        expect(jsSource).toBe('');
        expect(entries).toHaveLength(1);
        expect(entries[0].category).toBe('general');
    });

    test('accepts an inline array too', () => {
        const { entries } = janitorScriptEntries({ script: [{ content: 'x' }] });
        expect(entries).toHaveLength(1);
    });

    test('a non-JSON script is JS source, never an empty book', () => {
        const { entries, jsSource } = janitorScriptEntries({
            script: 'const loreEntries = [{ content: "x" }];',
        });
        expect(entries).toEqual([]);
        expect(jsSource).toContain('loreEntries');
    });

    test('an absent or blank script yields neither', () => {
        expect(janitorScriptEntries({})).toEqual({ entries: [], jsSource: '' });
        expect(janitorScriptEntries({ script: '   ' })).toEqual({ entries: [], jsSource: '' });
        expect(janitorScriptEntries(null)).toEqual({ entries: [], jsSource: '' });
    });
});

describe('classifyJanitorLorebook — the truth table', () => {
    const publicRef = { id: '962089bf', title: 'World Info', isPublic: true };
    const privateRef = { id: 'ca5e8a30', title: 'Private', isPublic: false };

    test('public: structured entries, no LLM involved', () => {
        const c = classifyJanitorLorebook(publicRef, ok(publicScriptRecord()));
        expect(c.kind).toBe('public');
        expect(c.reason).toBe('');
        expect(c.entryCount).toBe(1);
        expect(c.description).toBe('Information about this world');
    });

    test('private: closed on the ref\'s own word', () => {
        const c = classifyJanitorLorebook(privateRef, {});
        expect(c.kind).toBe('closed');
        expect(c.reason).toBe('private');
    });

    test('scripted: JS source needs the LLM rebuild', () => {
        const c = classifyJanitorLorebook(publicRef, ok({ script: 'const loreEntries = [];' }));
        expect(c.kind).toBe('scripted');
        expect(c.jsSource).toContain('loreEntries');
    });

    test('closed: the site answered and the book has no entries', () => {
        const c = classifyJanitorLorebook(publicRef, ok({ script: JSON.stringify([]) }));
        expect(c.kind).toBe('closed');
        expect(c.reason).toBe('no-entries');
    });

    // The acceptance rule: a transport failure is a FAILURE, never "closed".
    // Glaze's `!accessible && !isJs` folds every one of these into "private".
    test.each([
        ['transport error', { error: new Error('socket hang up') }, 'failed', 'transport'],
        ['status -1', { status: -1, body: 'fetch failed' }, 'failed', 'transport'],
        ['challenge', { status: 403, challenged: true, body: '<html>' }, 'failed', 'challenge'],
        ['401', { status: 401, body: '{}' }, 'failed', 'signed-out'],
        ['403 without challenge', { status: 403, body: '{}' }, 'failed', 'signed-out'],
        ['429', { status: 429, body: '{}' }, 'failed', 'rate-limited'],
        ['500', { status: 500, body: 'oops' }, 'failed', 'server'],
        ['502', { status: 502, body: 'bad gateway' }, 'failed', 'server'],
        ['404 script not found', { status: 404, body: '{"message":"script not found","statusCode":404}' }, 'failed', 'script-denied'],
        ['404 route gone', { status: 404, body: '{"message":"Cannot GET /hampter/script/x","error":"Not Found","statusCode":404}' }, 'failed', 'script-missing'],
        ['200 not JSON', { status: 200, body: '<html>login</html>' }, 'failed', 'unparseable'],
    ])('%s ⇒ %s/%s', (_label, result, kind, reason) => {
        const c = classifyJanitorLorebook(publicRef, result);
        expect(c.kind).toBe(kind);
        expect(c.reason).toBe(reason);
        expect(c.kind).not.toBe('closed');
    });

    test('the measured private-book 404 body is read as script-denied, not missing-route', () => {
        // 47 bytes on the wire, measured against a real private book.
        const body = '{"message":"script not found","statusCode":404}';
        const denied = classifyJanitorLorebook(publicRef, { status: 404, body });
        const missing = classifyJanitorLorebook(publicRef, {
            status: 404,
            body: '{"message":"Cannot GET /hampter/script/x","error":"Not Found","statusCode":404}',
        });
        expect(denied.reason).toBe('script-denied');
        expect(missing.reason).toBe('script-missing');
    });
});

describe('janitorScriptToCharacterBook', () => {
    const entries = () => janitorScriptEntries(publicScriptRecord()).entries;

    test('converts the measured entry into characterBook vocabulary', () => {
        const book = janitorScriptToCharacterBook(entries(), { name: 'Hero World RPG — World Info' });
        expect(book.name).toBe('Hero World RPG — World Info');
        expect(book.entries).toHaveLength(1);
        const [entry] = book.entries;
        expect(entry.keys).toEqual(['World', 'info', 'lore', 'history', 'society', 'heroes', 'villains']);
        expect(entry.content).toContain('Hero Agency');
        expect(entry.constant).toBe(true);
        expect(entry.selective).toBe(false);
        expect(entry.insertion_order).toBe(100);
        expect(entry.enabled).toBe(true);
        expect(entry.position).toBe('after_char');
        expect(entry.extensions.probability).toBe(100);
        expect(entry.extensions.display_index).toBe(0);
    });

    test('assigns numeric ids by index — the UUID would break World Info uids', () => {
        const many = [
            { content: 'a', key: ['x'] },
            { content: 'b', key: ['y'] },
        ];
        const book = janitorScriptToCharacterBook(many);
        expect(book.entries.map(e => e.id)).toEqual([0, 1]);
        expect(book.entries.map(e => e.extensions.display_index)).toEqual([0, 1]);
    });

    test('drops entries without content instead of writing empty World Info rows', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'real', key: ['a'] },
            { content: '   ', key: ['b'] },
            { key: ['c'] },
            null,
            'not an object',
        ]);
        expect(book.entries).toHaveLength(1);
        expect(book.entries[0].content).toBe('real');
    });

    test('falls back through insertion_order → priority → order', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'a', insertion_order: 7 },
            { content: 'b', priority: 8 },
            { content: 'c', order: 9 },
            { content: 'd' },
        ]);
        expect(book.entries.map(e => e.insertion_order)).toEqual([7, 8, 9, 100]);
    });

    test('normalises a fractional probability to 0-100', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'half', probability: 0.5 },
            { content: 'full', probability: 100 },
            { content: 'none', probability: 0 },
        ]);
        expect(book.entries.map(e => e.extensions.probability)).toEqual([50, 100, 0]);
    });

    test('keys come from key, then keysRaw (comma string)', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'a', keysRaw: 'One, Two ,Three' },
            { content: 'b', keywords: ['k1', 'k2'] },
        ]);
        expect(book.entries[0].keys).toEqual(['One', 'Two', 'Three']);
        expect(book.entries[1].keys).toEqual(['k1', 'k2']);
    });

    test('comment falls back to the measured `category` field', () => {
        const book = janitorScriptToCharacterBook([{ content: 'a', category: 'character' }]);
        expect(book.entries[0].comment).toBe('character');
    });

    test('placement maps to the matching side of the definition', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'a', placement: 'personality', placementPosition: 'before' },
            { content: 'b', placement: 'scenario', placementPosition: 'after' },
            { content: 'c', placement: 'default' },
            { content: 'd', position: 0 },
            { content: 'e', position: 1 },
        ]);
        expect(book.entries.map(e => e.position)).toEqual([
            'before_char', 'after_char', 'after_char', 'before_char', 'after_char',
        ]);
    });

    test('enabled:false and disable:true both disable the entry', () => {
        const book = janitorScriptToCharacterBook([
            { content: 'a', enabled: false },
            { content: 'b', disable: true },
            { content: 'c', enabled: true },
        ]);
        expect(book.entries.map(e => e.enabled)).toEqual([false, false, true]);
    });

    test('an empty script makes an empty book, not a crash', () => {
        expect(janitorScriptToCharacterBook([])).toEqual({ name: '', entries: [] });
        expect(janitorScriptToCharacterBook(undefined)).toEqual({ name: '', entries: [] });
    });
});

describe('janitorLorebookName', () => {
    test('is `<character> — <book>`', () => {
        expect(janitorLorebookName('Hero World RPG', 'World Info')).toBe('Hero World RPG — World Info');
    });

    test('degrades sensibly instead of producing a bare em dash', () => {
        expect(janitorLorebookName('', 'World Info')).toBe('World Info');
        expect(janitorLorebookName('Hero', '')).toBe('Hero');
        expect(janitorLorebookName('', '')).toBe('JanitorAI Lorebook');
        expect(janitorLorebookName(null, undefined)).toBe('JanitorAI Lorebook');
    });
});
