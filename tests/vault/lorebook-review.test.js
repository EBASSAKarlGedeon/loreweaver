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