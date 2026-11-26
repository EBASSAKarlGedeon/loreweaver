import { buildProvenance, fingerprint, stableStringify } from '../../public/scripts/extensions/weavers-vault/lorebook-provenance.js';
import { buildLorebook } from '../../public/scripts/extensions/weavers-vault/lorebook-build.js';

const TEXT = '- Servant Name: Artoria Pendragon;\n- Height/Weight: 154cm, 42kg;';

describe('provenance', () => {
    test('the fingerprint is stable and content-sensitive', () => {
        expect(fingerprint(TEXT)).toBe(fingerprint(TEXT));
        expect(fingerprint(TEXT)).not.toBe(fingerprint(TEXT + 'x'));
        expect(fingerprint(TEXT)).toMatch(/^[0-9a-f]{16}$/);
    });

    test('stable stringify ignores key order', () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    });

    test('the book carries what it was built from', () => {
        const decisions = { splits: [{ entry: 0, candidate: 1 }] };
        const { book, report } = buildLorebook({ text: TEXT, captureId: 'ecfa4111', decisions });
        const stamp = book.extensions.vault;
        expect(stamp.captureId).toBe('ecfa4111');
        expect(stamp.source.chars).toBe(TEXT.length);
        expect(stamp.source.fingerprint).toBe(fingerprint(TEXT));
        expect(stamp.review.fingerprint).toBe(fingerprint(stableStringify(decisions)));
        expect(stamp.result.entries).toBe(1);
        expect(stamp.result.ok).toBe(true);
        expect(report.provenance).toEqual(stamp);
    });

    test('recording a decision changes the review fingerprint, not the source one', () => {
        const one = buildLorebook({ text: TEXT, decisions: { renames: { 0: 'A' } } }).book.extensions.vault;
        const two = buildLorebook({ text: TEXT, decisions: {} }).book.extensions.vault;
        expect(one.source.fingerprint).toBe(two.source.fingerprint);
        expect(one.review.fingerprint).not.toBe(two.review.fingerprint);
    });
});