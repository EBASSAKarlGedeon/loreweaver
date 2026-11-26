import { describe, test, expect } from '@jest/globals';
import {
    OPENERS,
    cleanTitle,
    matchOpener,
    normaliseText,
    segmentLorebook,
    shortTitle,
    titleFromLine,
} from '../../public/scripts/extensions/weavers-vault/lorebook-segment.js';

/** The traps this module exists for, each one a regression of the Fate rebuild. */
const container = [
    '[OOC]: The following Characters are present in the world/universe, and can be included whenever {{user}} wishes.',
    '',
    '---',
    '- Name: Rin Tohsaka',
    '- Age: 39',
    '',
    '---',
    '- Name: Shirou Emiya',
    '- Age: 40',
].join('\n');

const images = [
    '[System Inclusion]:',
    '- Do: display the image of a location above the message.',
    '',
    '[Miyama Town Location Images]:',
    '<Fujimura Dojo>',
    '![a](https://example.test/1.webp)',
    '',
    '[Shinto Location Images]:',
    '![b](https://example.test/2.webp)',
    '',
    '[Other Locations]:',
    '![c](https://example.test/3.webp)',
].join('\n');

const sheets = [
    '- Servant Name: Artoria Pendragon;',
    '- Servant Class: Saber;',
    '- Height/Weight: 154cm, 42kg;',
    '',
    '[Example Dialogues]:',
    '"..."',
    '',
    '- Servant Name: Gilgamesh;',
    '- Servant Class: Archer;',
    '- Height/Weight: 182cm, 68kg;',
].join('\n');

const dashless = [
    'Servant Name: Achilles;',
    'Servant-Class: Rider;',
    '- Height/Weight: 185cm, 74kg;',
].join('\n');

describe('openers', () => {
    test('a sheet opens on "- Servant Name:" with or without the dash', () => {
        expect(matchOpener('- Servant Name: Artoria Pendragon;', true).title).toBe('Artoria Pendragon');
        expect(matchOpener('Servant Name: Achilles;', true).title).toBe('Achilles');
    });

    test('"- Name:" only opens an entry after a blank line', () => {
        expect(matchOpener('- Name: Van-Fem', true)).toMatchObject({ id: 'named-sheet', role: 'sheet' });
        expect(matchOpener('- Name: Rin Tohsaka', false)).toBeNull();
    });

    test('section headings never open an entry', () => {
        for (const line of ['[Example Dialogues]:', '[Riding A+]: <Servants with Riding>', '[Extra Lore]: "..."', '[Abilities]:', '[NOTE: "ShintoRoad"]', '[Servant Sprites]:']) {
            expect(matchOpener(line, true)).toBeNull();
        }
    });

    test('the topic opener drops a leading article', () => {
        expect(matchOpener('[System OOC]: This entry contains the information for the Clock Tower.', true).title).toBe('Clock Tower');
    });

    test('the table covers every authored container', () => {
        const ids = OPENERS.map((rule) => rule.id);
        for (const id of ['deceased', 'present', 'cities', 'other-characters', 'location-images', 'holy-church', 'concepts']) {
            expect(ids).toContain(id);
        }
    });
});

describe('segmentLorebook', () => {
    test('keeps a container with --- sections as one entry', () => {
        const { entries } = segmentLorebook(container);
        expect(entries).toHaveLength(1);
        expect(entries[0].title).toBe('Present Characters');
        expect(entries[0].role).toBe('container');
        expect(entries[0].content).toContain('Rin Tohsaka');
        expect(entries[0].content).toContain('Shirou Emiya');
    });

    test('keeps the image block (blank lines and [Section]: heads) as one entry', () => {
        const { entries } = segmentLorebook(images);
        expect(entries).toHaveLength(1);
        expect(entries[0].title).toBe('Location Images');
        expect(entries[0].content.match(/!\[/g)).toHaveLength(3);
    });

    test('splits character sheets, including a dashless one', () => {
        expect(segmentLorebook(sheets).entries.map((entry) => entry.title)).toEqual(['Artoria Pendragon', 'Gilgamesh']);
        expect(segmentLorebook(dashless).entries).toHaveLength(1);
        expect(segmentLorebook(dashless).entries[0].title).toBe('Achilles');
    });

    test('"- Name:" after --- stays inside the container, after a blank line opens a sheet', () => {
        const text = [
            '[Holy Church]:',
            '- [[the hidden organization]]',
            '<[Hansa Cervantes]>:',
            '- Name: Hansa Cervantes',
            '- Age: 48',
            '',
            '- Name: Van-Fem',
            '- Age: 2300',
        ].join('\n');
        const { entries } = segmentLorebook(text);
        expect(entries.map((entry) => entry.title)).toEqual(['Holy Church', 'Van-Fem']);
        expect(entries[0].content).toContain('Hansa Cervantes');
    });

    test('a leading unanchored block becomes its own entry, flagged low-confidence', () => {
        const text = ['[In the tapestry of the war, Servants are bound by rules.]', '=== SERVANT RULES  ===', '- Rule: x'].join('\n');
        const { entries, flags } = segmentLorebook(text);
        expect(entries[0].title).toBe('In the tapestry of the war, Servants are bound by rules');
        expect(entries[0].flags).toContain('low-confidence');
        expect(flags.some((flag) => flag.code === 'low-confidence')).toBe(true);
    });

    test('a welded second sheet is reported, not silently accepted', () => {
        const text = [
            '- Servant Name: Van-Fem;',
            '- Height/Weight: 189cm, 56kg;',
            '- Name: nobody',
            '- Height/Weight: 170cm, 60kg;',
            '- Height/Weight: 165cm, 55kg;',
        ].join('\n');
        const { entries, flags } = segmentLorebook(text);
        expect(entries).toHaveLength(1);
        expect(flags.filter((flag) => flag.code === 'multiple-sheet-blocks')).toHaveLength(1);
    });

    test('a long bracketed paragraph after a blank line is a split candidate (ORT)', () => {
        const text = [
            '[System]: This Entry contains information regarding other major characters within this universe:',
            '---',
            '- Name: Lord El-Melloi II',
            '- Height/Weight: 186cm, 68kg;',
            '',
            '[ORT is a gigantic Chrome metallic Spider-like creature with glowing teal markings that cover its body.]',
        ].join('\n');
        const { entries, flags } = segmentLorebook(text);
        expect(entries).toHaveLength(1);
        expect(entries[0].role).toBe('container');
        expect(flags.some((flag) => flag.code === 'candidate-split')).toBe(true);
    });

    test('duplicate titles are produced and left for the gate to reject', () => {
        const text = [
            '[System OOC]: This entry contains the information for the Clock Tower.',
            'first body',
            '',
            '[System OOC]: This entry contains the information for the Clock Tower.',
            'second body',
        ].join('\n');
        const { entries } = segmentLorebook(text);
        expect(entries.map((entry) => entry.title)).toEqual(['Clock Tower', 'Clock Tower']);
    });

    test('CRLF and LF segment identically', () => {
        const lf = segmentLorebook(container);
        const crlf = segmentLorebook(container.split('\n').join('\r\n'));
        expect(crlf.entries.map((entry) => entry.content)).toEqual(lf.entries.map((entry) => entry.content));
        expect(crlf.entries[0].start).toBe(0);
    });

    test('every character outside an entry is a separator', () => {
        const text = [container, '', images, '', sheets].join('\n\n');
        const { entries } = segmentLorebook(text);
        let previous = 0;
        for (const entry of entries) {
            const gap = text.slice(previous, entry.start);
            expect(gap.trim() === '' || /^(?:---)+\s*$/.test(gap.trim())).toBe(true);
            previous = entry.end;
        }
        expect(text.slice(previous).trim()).toBe('');
    });

    test('the stats add up', () => {
        const { entries, stats } = segmentLorebook([container, '', images, '', sheets].join('\n\n'));
        expect(stats.entries).toBe(entries.length);
        expect(stats.chars).toBe(entries.reduce((sum, entry) => sum + entry.content.length, 0));
        expect(stats.sheets).toBe(2);
        expect(stats.containers).toBe(2);
    });
});

describe('helpers', () => {
    test('cleanTitle strips the trailing semicolon', () => {
        expect(cleanTitle('Artoria Pendragon;')).toBe('Artoria Pendragon');
    });

    test('titleFromLine turns a bracketed sentence into a title', () => {
        expect(titleFromLine('[In the grand tapestry of the Holy Grail War, Servants are bound.]')).toBe('In the grand tapestry of the Holy Grail War, Servants are bound');
    });

    test('shortTitle keeps a paragraph title short and flags it', () => {
        const line = '[In the grand tapestry of the Holy Grail War, Servants, heroic spirits summoned from across time, are bound by seven Command Seals and the rules of the ritual.]';
        const title = shortTitle(line);
        expect(title.length).toBeLessThanOrEqual(61);
        expect(title.endsWith('…')).toBe(true);
        const { entries, flags } = segmentLorebook(line + '\n\n- Servant Name: Artoria;');
        expect(entries[0].flags).toContain('derived-title');
        expect(flags.some((flag) => flag.code === 'derived-title')).toBe(true);
    });

    test('normaliseText unifies line endings', () => {
        expect(normaliseText('a\r\nb\rc')).toBe('a\nb\nc');
    });
});
