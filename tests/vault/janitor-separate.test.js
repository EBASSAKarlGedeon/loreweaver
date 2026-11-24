import { describe, test, expect } from '@jest/globals';
import {
    extractCard,
    extractCharName,
    extractFirstMessage,
    extractScenario,
    extractExample,
    getSystemContent,
    loosePattern,
    mergeLorebookTexts,
    restoreMacros,
    separate,
    splitEntries,
    stripJanitorCredit,
    stripWrappers,
    tidy,
} from '../../src/endpoints/weavers-vault-janitor-separate.js';

/**
 * An assembled prompt in the shape Glaze's separator documents, with one card
 * block, one user persona, one scenario, one example block and two lore entries.
 */
function assembledPrompt({ card = "You are Anna Lee, a lamp-lighter.\nShe is quiet.\nShe keeps a brass key.", lore = ['The lighthouse keeper is her brother.', 'The key opens the north tower.'] } = {}) {
    const system = [
        '[You are a creative writer.]',
        `<{{char}}'s Persona>\n${card}\n</{{char}}'s Persona>`,
        '<UserPersona>\nYou are Yang, a traveller.\n</UserPersona>',
        '<Scenario>\nA foggy harbour at dusk.\n</Scenario>',
        '<Example Messages>\n{{char}}: "Evening."\n</Example Messages>',
        ...lore,
    ].join('\n\n');
    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: '.' },
            { role: 'assistant', content: 'The lamp catches.' },
        ],
    };
}

describe('getSystemContent', () => {
    test('reads the first system message and tolerates rubbish', () => {
        expect(getSystemContent(assembledPrompt())).toContain('lamp-lighter');
        expect(getSystemContent({ messages: { not: 'a list' } })).toBe('');
        expect(getSystemContent(null)).toBe('');
        expect(getSystemContent({ messages: [{ role: 'user', content: 'x' }] })).toBe('');
    });
});

describe('stripWrappers', () => {
    test('removes jailbreak, card, user persona, scenario and example, each as a newline', () => {
        const { out, removed } = stripWrappers(assembledPrompt().messages[0].content);
        expect(removed.map(block => block.label)).toEqual(['jailbreak', 'card', 'userPersona', 'scenario', 'example']);
        expect(out).not.toContain('Persona>');
        expect(out).not.toContain('<Scenario>');
        expect(out).not.toContain('Example');
        // What is left is exactly the lore.
        expect(splitEntries(out)).toHaveLength(2);
    });

    test('replacing a block with a newline keeps two lore blocks from fusing', () => {
        const text = '<Scenario>\nfog\n</Scenario>\nfirst entry\n\nsecond entry';
        expect(splitEntries(stripWrappers(text).out)).toEqual(['first entry', 'second entry']);
        // With '' instead of '\n' the two entries would collapse into one.
        const fused = stripWrappers(text).out.replace(/\n+$/, '');
        expect(fused.length).toBeLessThan(text.length);
    });
});

describe('field extractors', () => {
    test('the card is the first non-user persona block', () => {
        expect(extractCard(assembledPrompt())).toContain('lamp-lighter');
        expect(extractCard(assembledPrompt())).not.toContain('traveller');
    });

    test('a prompt with only a user persona yields no card', () => {
        const payload = { messages: [{ role: 'system', content: '<UserPersona>\nYang\n</UserPersona>' }] };
        expect(extractCard(payload)).toBe('');
    });

    test('the character name comes from the wrapper tag, possessive stripped', () => {
        expect(extractCharName(assembledPrompt())).toBe('{{char}}');
        const named = { messages: [{ role: 'system', content: "<Anna Lee's Persona>\nbody\n</Anna Lee's Persona>" }] };
        expect(extractCharName(named)).toBe('Anna Lee');
    });

    test('scenario, example and first message', () => {
        expect(extractScenario(assembledPrompt())).toBe('A foggy harbour at dusk.');
        expect(extractExample(assembledPrompt())).toBe('{{char}}: "Evening."');
        expect(extractFirstMessage(assembledPrompt())).toBe('The lamp catches.');
    });
});

describe('separate', () => {
    test('everything outside the wrappers is the closed lorebook', () => {
        const result = separate(assembledPrompt());
        expect(result.entries).toEqual(['The lighthouse keeper is her brother.', 'The key opens the north tower.']);
        expect(result.lorebookText).not.toContain('lamp-lighter');
    });

    test('known card lines are subtracted, but short shared phrases are kept', () => {
        const lore = ['She nods.', 'You are Anna Lee, a lamp-lighter.'];
        const result = separate(assembledPrompt({ lore }), { knownCard: 'You are Anna Lee, a lamp-lighter.\nShe nods.' });
        // Only the long line is subtracted; "She nods." survives because a short
        // shared line is not evidence of a leak.
        expect(result.entries).toContain('She nods.');
        expect(result.entries.join('\n')).not.toContain('lamp-lighter');
        expect(result.removed.some(block => block.label === 'knownCard')).toBe(true);
    });

    test('public entries are subtracted tolerantly', () => {
        const lore = ["It's the keeper's boat — not hers.", 'Private entry.'];
        const publicContents = ["It’s the keeper’s boat – not hers."];
        const result = separate(assembledPrompt({ lore }), { publicContents });
        // Curly vs straight apostrophes and en- vs em-dash must still match.
        expect(result.entries).toEqual(['Private entry.']);
        expect(result.removed.some(block => block.label === 'publicLorebook')).toBe(true);
    });

    test('a needle shorter than twelve characters is never subtracted', () => {
        const lore = ['Short.', 'A real entry that should stay.'];
        const result = separate(assembledPrompt({ lore }), { publicContents: ['Short.'] });
        expect(result.entries).toContain('Short.');
    });
});

describe('loosePattern', () => {
    test('escapes metacharacters and treats the glyph variants as one class', () => {
        const source = loosePattern("a.b (c) 'q' - x");
        expect(source).toContain('\\.');
        expect(source).toContain('\\(');
        expect(source).toContain("['\u2018\u2019\u02BC]");
        expect(source).toContain('[-\u2013\u2014]');
        expect(() => new RegExp(source)).not.toThrow();
    });
});

describe('splitEntries / mergeLorebookTexts / tidy', () => {
    test('blank lines separate entries, and a blank line with spaces still counts', () => {
        expect(splitEntries('one\n\n  \ntwo\n')).toEqual(['one', 'two']);
    });

    test('merge de-duplicates by whole-block identity, keeping first-seen order', () => {
        const merged = mergeLorebookTexts(['Alpha entry.\n\nBeta entry.', 'beta   ENTRY.\n\nGamma entry.']);
        expect(merged).toBe('Alpha entry.\n\nBeta entry.\n\nGamma entry.');
    });

    test('tidy collapses runs of blank lines and strips trailing spaces', () => {
        expect(tidy('a   \n\n\n\nb  \n')).toBe('a\n\nb');
    });
});

describe('restoreMacros', () => {
    test('longest name first, names under three characters ignored', () => {
        const out = restoreMacros('Anna Lee met Anna and Bo.', { charNames: ['Anna', 'Anna Lee', 'Bo'] });
        expect(out).toBe('{{char}} met {{char}} and Bo.');
    });

    test('the user name is swapped after the character names', () => {
        expect(restoreMacros('Yang saw Anna Lee.', { charNames: ['Anna Lee'], userName: 'Yang' }))
            .toBe('{{user}} saw {{char}}.');
        expect(restoreMacros('text', {})).toBe('text');
        expect(restoreMacros('', { charNames: ['Anna Lee'] })).toBe('');
    });
});

describe('stripJanitorCredit', () => {
    test('removes the credit line alone on its line', () => {
        // The credit goes with its own trailing newline, so exactly one newline
        // separates the surrounding text.
        expect(stripJanitorCredit('Body text.\ncreated by Ch0keMePlz 2026© on janitorai.com\nMore text.'))
            .toBe('Body text.\nMore text.');
    });

    test('removes the credit appended to a line of real text', () => {
        expect(stripJanitorCredit('Body text. created by someone on janitor.ai')).toBe('Body text.');
    });

    test('leaves text that merely mentions janitorai.com alone', () => {
        const text = 'I found this on janitorai.com yesterday.';
        expect(stripJanitorCredit(text)).toBe(text);
    });
});
