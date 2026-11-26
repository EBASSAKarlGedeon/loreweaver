import { describe, test, expect } from '@jest/globals';
import { buildLorebook, defaultKeys } from '../../public/scripts/extensions/weavers-vault/lorebook-build.js';

const capture = [
    '[OOC]: The following Characters are present in the world/universe, and can be included whenever {{user}} wishes.',
    '---',
    '- Name: Rin Tohsaka',
    '- Age: 39',
    '',
    '- Servant Name: Artoria Pendragon;',
    '- Servant Class: Saber;',
    '- Height/Weight: 154cm, 42kg;',
].join('\n');

describe('defaultKeys', () => {
    test('keeps the whole title and adds its parts', () => {
        expect(defaultKeys('Ishtar/Philia')).toEqual(['Ishtar/Philia', 'Ishtar', 'Philia']);
    });

    test('adds the base name without a parenthetical alias', () => {
        expect(defaultKeys('Artoria (Summer)')).toEqual(['Artoria (Summer)', 'Artoria']);
    });

    test('no title yields no keys', () => {
        expect(defaultKeys('')).toEqual([]);
    });
});

describe('buildLorebook', () => {
    test('turns a container into one entry with the full World Info schema', () => {
        const { book, report } = buildLorebook({ text: capture });
        const entries = Object.values(book.entries);
        expect(entries).toHaveLength(2);
        expect(entries[0].comment).toBe('Present Characters');
        expect(entries[0].position).toBe(4);
        expect(entries[0].depth).toBe(10);
        expect(entries[0].constant).toBe(false);
        expect(entries[0].order).toBe(100);
        expect(entries[1].order).toBe(99);
        expect(entries[0].start).toBe(0);
        expect(report.ok).toBe(true);
        expect(report.summary.entries).toBe(2);
    });

    test('the template decides the shared fields', () => {
        const { book } = buildLorebook({ text: capture, template: { position: 1, depth: 4, role: 2 } });
        const first = Object.values(book.entries)[0];
        expect(first.position).toBe(1);
        expect(first.depth).toBe(4);
        // "role" stays World Info's numeric slot; the segmentation label is separate.
        expect(first.role).toBe(2);
        expect(first.vaultRole).toBe('container');
    });

    test('author keys win over derived keys', () => {
        const { book } = buildLorebook({
            text: capture,
            authorKeys: { 'artoria pendragon': ['Artoria', 'Saber', 'King of Knights'] },
        });
        const entries = Object.values(book.entries);
        expect(entries[1].key).toEqual(['Artoria', 'Saber', 'King of Knights']);
    });

    test('the report carries the gates and the segmentation flags', () => {
        const duplicate = capture + '\n\n- Servant Name: Artoria Pendragon;';
        const { report } = buildLorebook({ text: duplicate });
        expect(report.ok).toBe(false);
        expect(report.failures.map((failure) => failure.code)).toContain('duplicate-title');
        expect(report.segmentation.stats.entries).toBe(3);
    });

    test('coverage is checked against the capture when keys are irrelevant', () => {
        const { report } = buildLorebook({ text: capture });
        expect(report.failures.filter((failure) => failure.gate === 'coverage')).toEqual([]);
    });
});
