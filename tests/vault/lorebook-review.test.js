import { applyReview } from '../../public/scripts/extensions/weavers-vault/lorebook-review.js';
import { segmentLorebook } from '../../public/scripts/extensions/weavers-vault/lorebook-segment.js';
import { verifyLorebook } from '../../public/scripts/extensions/weavers-vault/lorebook-verify.js';

// One servant sheet, then two bracket headers: the segmenter keeps them inside the
// sheet as candidates, which is exactly the choice the review pass makes explicit.
const TEXT = [
    '- Servant Name: Artoria Pendragon;',
    '- Height/Weight: 154cm, 42kg;',
    '- Alignment: Lawful-Good;',
    '',
    '[Additional Staff List]:',
    '[Name: Jingle Abel Meunière',
    '- Age: 30~',
    '',
    '[First Singularity: City of Lies - NPCs]:',
    '- Name: Scheherazade;',
    '- Class: Caster;',
].join('\n');

function reviewed(decisions) {
    const generated = segmentLorebook(TEXT);
    return { generated, result: applyReview({ entries: generated.entries, decisions }) };
}

describe('applyReview', () => {
    test('the fixture arrives as one entry with two candidates', () => {
        const { generated } = reviewed({});
        expect(generated.entries).toHaveLength(1);
        expect(generated.entries[0].candidates.map((candidate) => candidate.text)).toEqual([
            '[Additional Staff List]:',
            "[First Singularity: City of Lies - NPCs]:",
        ]);
    });

    test('splits at a candidate and keeps both halves verbatim', () => {
        const { result } = reviewed({ splits: [{ entry: 0, candidate: 1 }] });
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].title).toBe('Artoria Pendragon');
        expect(result.entries[1].title).toBe("First Singularity: City of Lies - NPCs");
        expect(result.entries[1].role).toBe('container');
        // Only whitespace may sit between the two halves; the verifier counts it as a separator.
        expect(TEXT.slice(result.entries[0].end, result.entries[1].start).trim()).toBe('');
        for (const entry of result.entries) {
            expect(entry.content).toBe(TEXT.slice(entry.start, entry.end));
        }
        expect(result.problems).toEqual([]);
    });

    test('renames are applied and reported', () => {
        const { result } = reviewed({ renames: { 0: 'Artoria Pendragon (Saber)' } });
        expect(result.entries[0].title).toBe('Artoria Pendragon (Saber)');
        expect(result.applied).toEqual([{ kind: 'rename', entry: 0, title: 'Artoria Pendragon (Saber)' }]);
    });

    test('a merge folds an entry back into the one above it', () => {
        const { result } = reviewed({ splits: [{ entry: 0, candidate: 1 }], merges: [1] });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].content).toContain('First Singularity');
        expect(result.entries[0].end).toBe(TEXT.length);
        expect(result.applied.map((action) => action.kind)).toEqual(['split', 'merge']);
    });

    test('a split with no candidate is reported, not applied', () => {
        const { result } = reviewed({ splits: [{ entry: 0, candidate: 99 }] });
        expect(result.entries).toHaveLength(1);
        expect(result.problems[0]).toContain('no candidate 99');
    });
});

// A sheet that ends and is followed by another servant's fields with no name line: the
// capture gives no opener, so only a reviewer can place the boundary (and the author's
// list supplies the half's title). See the Paracelsus/Li Shuwen weld in the Grand Order card.
const WELD = [
    '- Servant Name: Arthur Pendragon',
    '- Class: Saber;',
    '<Noble Phantasm: "Excalibur"',
    '- NP Info: [Sword.]>',
    '',
    '- Height/Weight: 183cm, 65kg',
    '<Noble Phantasm: "Sword of Paracelsus"',
    '- NP Info: [Elixir.]>',
].join('\n');

function welded(decisions) {
    const generated = segmentLorebook(WELD);
    return applyReview({ entries: generated.entries, decisions });
}

describe('applyReview explicit offsets', () => {
    test('splits a headerless fragment off and titles it from the author list', () => {
        const at = WELD.indexOf('- Height/Weight');
        const result = welded({ splits: [{ entry: 0, at, title: 'Paracelsus von Hohenheim' }] });
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].title).toBe('Arthur Pendragon');
        expect(result.entries[1].title).toBe('Paracelsus von Hohenheim');
        expect(result.entries[1].role).toBe('unknown');
        expect(result.entries[0].content).not.toContain('Sword of Paracelsus');
        expect(result.entries[1].content.startsWith('- Height/Weight: 183cm')).toBe(true);
        for (const entry of result.entries) {
            expect(entry.content).toBe(WELD.slice(entry.start, entry.end));
        }
        expect(result.problems).toEqual([]);
        expect(result.applied).toEqual([{ kind: 'split', entry: 0, at: WELD.indexOf('- Height/Weight'), title: 'Paracelsus von Hohenheim' }]);
    });

    test('two offsets carve three entries, in source order', () => {
        const first = WELD.indexOf('- Height/Weight');
        const second = WELD.indexOf('<Noble Phantasm: "Sword');
        const result = welded({
            splits: [
                { entry: 0, at: second, title: 'Second' },
                { entry: 0, at: first, title: 'First' },
            ],
        });
        expect(result.entries.map((entry) => entry.title)).toEqual(['Arthur Pendragon', 'First', 'Second']);
        expect(result.entries[1].content).toBe('- Height/Weight: 183cm, 65kg');
        expect(result.entries[2].content).toContain('Sword of Paracelsus');
    });

    test('a split with neither candidate nor offset is reported', () => {
        const result = welded({ splits: [{ entry: 0 }] });
        expect(result.entries).toHaveLength(1);
        expect(result.problems[0]).toContain('needs a candidate or an at offset');
    });

    test('offsets that would empty a half or are not whole numbers are reported', () => {
        for (const at of [0, WELD.length, 2.5]) {
            const result = welded({ splits: [{ entry: 0, at }] });
            expect(result.entries).toHaveLength(1);
            expect(result.problems).toHaveLength(1);
        }
    });

    test('the verifier accepts the halves as verbatim and adjacent', () => {
        const at = WELD.indexOf('- Height/Weight');
        const result = welded({ splits: [{ entry: 0, at, title: 'Paracelsus von Hohenheim' }] });
        const entries = result.entries.map((entry, index) => ({
            uid: index,
            comment: entry.title,
            key: [entry.title],
            content: entry.content,
            constant: false,
            position: 4,
            depth: 10,
            start: entry.start,
            end: entry.end,
        }));
        const report = verifyLorebook({ source: WELD, entries });
        expect(report.failures).toEqual([]);
    });
});
describe('verifyLorebook title qualifier', () => {
    test('a parenthesised qualifier disambiguates without touching the body', () => {
        const content = '- Servant Name: Goetia;\n- Class: Caster;';
        const entries = [{ title: 'Goetia (Servant)', content, start: 0, end: content.length }];
        const report = verifyLorebook({ source: content, entries });
        expect(report.failures.filter((failure) => failure.code === 'title-mismatch')).toEqual([]);
    });

    test('a different name is still rejected', () => {
        const content = '- Servant Name: Goetia;\n- Class: Caster;';
        const entries = [{ title: 'Solomon', content, start: 0, end: content.length }];
        const report = verifyLorebook({ source: content, entries });
        expect(report.failures.filter((failure) => failure.code === 'title-mismatch')).toHaveLength(1);
    });
});