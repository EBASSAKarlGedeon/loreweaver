import { describe, test, expect } from '@jest/globals';
import {
    SEPARATOR_PATTERN,
    normaliseName,
    sheetNameOf,
    verifyLorebook,
} from '../../public/scripts/extensions/weavers-vault/lorebook-verify.js';

/** A World Info entry with every field the schema gate requires. */
function entry(over = {}) {
    return {
        uid: 1,
        key: ['Artoria'],
        comment: 'Artoria Pendragon',
        content: '- Servant Name: Artoria Pendragon;',
        constant: false,
        position: 4,
        depth: 10,
        ...over,
    };
}

const codes = (result) => result.failures.map((failure) => failure.code);
const warningCodes = (result) => result.warnings.map((warning) => warning.code);

describe('coverage', () => {
    const source = ['- Servant Name: Artoria Pendragon;', '', '- Servant Name: Gilgamesh;'].join('\n');
    const first = source.slice(0, source.indexOf('- Servant Name: Gilgamesh;')).replace(/\s+$/, '');

    test('a book whose entries tile the source passes', () => {
        const entries = [
            entry({ start: 0, end: first.length, content: first }),
            entry({ uid: 2, key: ['Gilgamesh'], comment: 'Gilgamesh', start: source.indexOf('- Servant Name: Gilgamesh;'), end: source.length, content: '- Servant Name: Gilgamesh;' }),
        ];
        const result = verifyLorebook({ source, entries });
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
    });

    test('content that is not source[start..end] is rejected', () => {
        const result = verifyLorebook({ source, entries: [entry({ start: 0, end: 10, content: 'something else' })] });
        expect(codes(result)).toContain('offset-mismatch');
    });

    test('stray text between entries is rejected', () => {
        const withStray = source.replace('\n\n', '\n\nstray text\n\n');
        const start = withStray.indexOf('- Servant Name: Gilgamesh;');
        const result = verifyLorebook({
            source: withStray,
            entries: [
                entry({ start: 0, end: first.length, content: first }),
                entry({ uid: 2, key: ['Gilgamesh'], comment: 'Gilgamesh', start, end: start + 27, content: '- Servant Name: Gilgamesh;' }),
            ],
        });
        expect(codes(result)).toContain('uncovered-text');
    });

    test('without offsets, invented content is still caught by search', () => {
        const result = verifyLorebook({ source, entries: [entry({ content: 'text that never existed' })] });
        expect(codes(result)).toContain('not-verbatim');
        expect(warningCodes(result)).toContain('no-offsets');
    });

    test('a rebuilt name line is allowed to be absent from the capture', () => {
        const result = verifyLorebook({ source, entries: [entry({ content: '- Servant Name: Cleopatra;\nbody that exists' })] });
        expect(codes(result)).toContain('not-verbatim');
        const ok = verifyLorebook({ source, entries: [entry({ content: '- Servant Name: Cleopatra;\n- Servant Name: Artoria Pendragon;' })] });
        expect(codes(ok)).not.toContain('not-verbatim');
    });

    test('separators allow whitespace and empty --- dividers', () => {
        expect(SEPARATOR_PATTERN.test('\n\n')).toBe(true);
        expect(SEPARATOR_PATTERN.test('\n---\n')).toBe(true);
        expect(SEPARATOR_PATTERN.test('\nstray\n')).toBe(false);
    });
});

describe('borders and titles', () => {
    test('an entry holding another entry opener is rejected', () => {
        const result = verifyLorebook({
            entries: [entry({ content: '- Servant Name: Medea;\n\n- Servant Name: Ozymandias;' })],
        });
        expect(codes(result)).toContain('foreign-opener');
    });

    test("an entry's own name line after a --- divider is not foreign", () => {
        const result = verifyLorebook({
            entries: [entry({ content: '---\n- Servant Name: Artoria Pendragon;' })],
        });
        expect(codes(result)).not.toContain('foreign-opener');
    });

    test('two entries with one title are rejected', () => {
        const result = verifyLorebook({
            entries: [entry(), entry({ uid: 2, key: ['x'], content: '- Servant Name: Artoria Pendragon; two' })],
        });
        expect(codes(result)).toContain('duplicate-title');
    });

    test('a sheet whose title disagrees with its body is rejected', () => {
        const result = verifyLorebook({
            entries: [entry({ comment: 'Rin Tohsaka', content: '- Name: Sakura Matou' })],
        });
        expect(codes(result)).toContain('title-mismatch');
    });

    test('a second character sheet in one entry is a warning, not an error', () => {
        const result = verifyLorebook({
            entries: [entry({ content: '- Servant Name: Van-Fem;\n- Height/Weight: 1\n- Height/Weight: 2' })],
        });
        expect(warningCodes(result)).toContain('multiple-sheet-blocks');
        expect(codes(result)).not.toContain('multiple-sheet-blocks');
    });
});

describe('keys, macros, schema', () => {
    test('an entry with no keys is rejected', () => {
        const result = verifyLorebook({ entries: [entry({ key: [] })] });
        expect(codes(result)).toContain('missing-keys');
    });

    test('the author key is reported when the entry does not carry it', () => {
        const result = verifyLorebook({
            entries: [entry({ key: ['Altria'] })],
            authorKeys: { 'artoria pendragon': ['Artoria', 'Saber'] },
        });
        expect(warningCodes(result)).toContain('author-key-missing');
        expect(codes(result)).toEqual([]);
    });

    test('a triple-brace macro is rejected', () => {
        const result = verifyLorebook({ entries: [entry({ content: 'hi {{{user}}}' })] });
        expect(codes(result)).toContain('malformed-macro');
    });

    test('a missing World Info field is rejected', () => {
        const bad = entry();
        delete bad.uid;
        expect(codes(verifyLorebook({ entries: [bad] }))).toContain('bad-field');
    });

    test('the summary counts what was checked', () => {
        const result = verifyLorebook({ entries: [entry(), entry({ uid: 2, key: ['a', 'b'], comment: 'B', content: 'B' })] });
        expect(result.summary.entries).toBe(2);
        expect(result.summary.keys).toBe(3);
        expect(result.ok).toBe(true);
    });
});

describe('helpers', () => {
    test('names compare without case, spaces or trailing punctuation', () => {
        expect(normaliseName('Artoria  (Summer);')).toBe('artoria (summer)');
    });

    test('sheetNameOf reads the first name line of either shape', () => {
        expect(sheetNameOf('- Servant Name: Achilles;\n- Class: Rider')).toBe('Achilles');
        expect(sheetNameOf('Servant Name: Avicebron;')).toBe('Avicebron');
        expect(sheetNameOf('- Name: Van-Fem')).toBe('Van-Fem');
    });
});
