import { describe, test, expect } from '@jest/globals';
import {
    entryDisabled,
    truthyFlag,
    dedupeRegexKeywords,
    loreFromWorldInfoEntry,
    loreFromCardEntry,
    loreTypeForTitle,
    loreTypeForWorldEntry,
    resolveCharMacro,
    npcFromCard,
    buildCardLore,
    importedTitleSet,
    importedContentHashes,
    stripPreviousImport,
    cardImportHash,
    chatPlayerName,
    chatMessagesToImport,
    chatTurnCount,
} from '../../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/app/src/scripts/loreweaver-import-map.js';

// The SillyTavern -> RPG Engine importer used to lose or corrupt data in ways that only show up
// after a linked import is refreshed. These tests pin the conversion rules themselves, not the
// DOM: see app/src/scripts/loreweaver-import-map.js for the why of every rule.

describe('SillyTavern entry flags', () => {
    test('disable and enabled spellings are both honoured', () => {
        expect(entryDisabled({ disable: true })).toBe(true);
        expect(entryDisabled({ disable: 'true' })).toBe(true);
        expect(entryDisabled({ enabled: false })).toBe(true);
        expect(entryDisabled({ enabled: 'false' })).toBe(true);
        expect(entryDisabled({ disable: false, enabled: true })).toBe(false);
        expect(entryDisabled(null)).toBe(true);
    });

    test('constant accepts boolean and string', () => {
        expect(truthyFlag(true)).toBe(true);
        expect(truthyFlag('true')).toBe(true);
        expect(truthyFlag('True')).toBe(true);
        expect(truthyFlag(false)).toBe(false);
        expect(truthyFlag(undefined)).toBe(false);
    });
});

describe('keyword mapping', () => {
    test('secondary keys stay separate unless selective turns them into an AND', () => {
        const plain = loreFromWorldInfoEntry({ key: ['Elise'], keysecondary: ['bracelet'], content: 'x' });
        expect(plain.keywords).toEqual(['Elise']);
        expect(plain.secondary).toBeUndefined();
        expect(plain.selective).toBeUndefined();
        const and = loreFromWorldInfoEntry({ key: ['Elise'], keysecondary: ['bracelet', 'cabin'], selective: true, content: 'x' });
        expect(and.keywords).toEqual(['Elise']);
        expect(and.secondary).toEqual(['bracelet', 'cabin']);
        expect(and.selective).toBe(true);
    });

    test('regex keys are preserved as patterns, not guessed into literals', () => {
        expect(dedupeRegexKeywords(['\\b(Meg|Sullivan)\\b', '^bracelet$', '\\b(Meg|Sullivan)\\b']))
            .toEqual(['\\b(Meg|Sullivan)\\b', '^bracelet$']);
        const e = loreFromWorldInfoEntry({ key: ['\\b(Meg|Sullivan)\\b'], use_regex: true, content: 'x' });
        expect(e.keywords).toEqual(['\\b(Meg|Sullivan)\\b']);
        expect(e.useRegex).toBe(true);
        expect(e.activation).toBe('keywords');
    });

    test('order, probability, role and depth are carried natively', () => {
        const e = loreFromWorldInfoEntry({
            key: ['Meg'],
            content: 'x',
            order: 250,
            probability: 35,
            position: 4,
            role: 1,
            depth: 2,
        });
        expect(e).toMatchObject({ order: 250, probability: 35, role: 'user', depth: 2 });
        const offDepth = loreFromWorldInfoEntry({ key: ['Meg'], content: 'x', position: 0, role: 1, depth: 2 });
        expect(offDepth.role).toBeUndefined();
        expect(offDepth.depth).toBeUndefined();
        const defaultDepth = loreFromWorldInfoEntry({ key: ['Meg'], content: 'x', position: 4, role: 0, depth: null });
        expect(defaultDepth).toMatchObject({ role: 'system', depth: 4 });
    });

    test('a world-info entry keeps its words, activation and title', () => {
        const e = loreFromWorldInfoEntry({
            key: ['Meg Sullivan'],
            keysecondary: ['diner'],
            comment: 'Meg Sullivan',
            content: 'Night shift at Lou\'s.',
            constant: false,
        });
        expect(e).toMatchObject({
            title: 'Meg Sullivan',
            type: 'lore',
            activation: 'keywords',
            keywords: ['Meg Sullivan'],
        });
    });

    test('constant entries are always-on even with keywords', () => {
        const e = loreFromWorldInfoEntry({ key: ['a'], content: 'x', constant: 'true' });
        expect(e.activation).toBe('always');
    });

    test('an entry with no key is always-on, not an unfireable orphan', () => {
        expect(loreFromWorldInfoEntry({ content: 'x' }).activation).toBe('always');
    });

    test('disabled and empty entries are dropped', () => {
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', disable: true })).toBeNull();
        expect(loreFromWorldInfoEntry({ key: ['a'], content: '   ' })).toBeNull();
        expect(loreFromCardEntry({ keys: ['a'], content: 'x', enabled: false })).toBeNull();
    });

    test('an embedded card entry is titled from its comment/keyword', () => {
        const e = loreFromCardEntry({ keys: [], secondary_keys: ['bracelet'], comment: '', content: 'x' });
        expect(e.keywords).toEqual(['bracelet']);
        expect(e.title).toBe('bracelet');
    });

    test('a never-fire probability is not turned into an always-on entry', () => {
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', probability: 0 })).toBeNull();
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', probability: '0' })).toBeNull();
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', probability: 50 }).activation).toBe('keywords');
        // null/"" mean "unset" (default 100), never "never fire" — Number(null) is 0.
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', probability: null }).probability).toBeUndefined();
        expect(loreFromWorldInfoEntry({ key: ['a'], content: 'x', probability: '' }).probability).toBeUndefined();
    });

    test('card titles and keywords resolve {{char}} too', () => {
        const e = loreFromCardEntry({ keys: ['{{char}}'], comment: '{{char}} at home', content: 'x' }, 'Elise');
        expect(e.title).toBe('Elise at home');
        expect(e.keywords).toEqual(['Elise']);
    });

    test('world-info place and rule titles reach the map without mistyping generic lore', () => {
        expect(loreTypeForWorldEntry("Lou's 24-Hour Diner")).toBe('location');
        expect(loreTypeForWorldEntry('House rules')).toBe('law');
        expect(loreTypeForWorldEntry('Meg Sullivan')).toBe('lore');
    });

    test('place and rule titles get a type the map subsystem can use', () => {
        expect(loreTypeForTitle("Owen's family house at Red Mesa")).toBe('location');
        expect(loreTypeForTitle("User's room")).toBe('location');
        expect(loreTypeForTitle('House rules')).toBe('law');
        expect(loreTypeForTitle('Elise and user grew up next door')).toBe('character');
        expect(loreFromCardEntry({ keys: ['x'], comment: 'Places around campus', content: 'y' }).type).toBe('location');
    });
});

describe('card book import', () => {
    const card = {
        name: 'The Bracelet Stays On',
        data: {
            character_book: {
                entries: [
                    { keys: ['usual trip'], comment: 'Excuses', content: 'one', enabled: true },
                    { keys: ['heat'], comment: 'Disabled', content: 'two', disable: true },
                    { keys: ['bracelet'], comment: '', content: 'three' },
                    { keys: ['x'], comment: 'Empty body', content: '' },
                ],
            },
        },
    };

    test('{{char}} in card prose becomes the card name, {{user}} is left for the engine', () => {
        expect(resolveCharMacro('{{char}} waves at {{user}}.', 'Elise')).toBe('Elise waves at {{user}}.');
        const built = buildCardLore({
            name: 'Elise',
            character_book: { entries: [{ keys: ['bracelet'], content: '{{char}} wears it.' }] },
        });
        expect(built.lore[0].content).toBe('Elise wears it.');
    });

    test('an imported NPC resolves {{char}} but leaves {{user}} for play', () => {
        const npc = npcFromCard({
            name: 'Elise',
            description: '{{char}} grew up next door to {{user}}.',
            personality: '{{char}} is patient.',
            scenario: '{{char}} visits {{user}}.',
        }, '/characters/elise.png');
        expect(npc.persona).toBe('Elise grew up next door to {{user}}.\n\nElise is patient.');
        expect(npc.extra).toBe('Elise visits {{user}}.');
        expect(npc.avatar).toBe('/characters/elise.png');
    });

    test('builds only enabled, non-empty entries', () => {
        const { lore, titles } = buildCardLore(card);
        expect(lore.map(l => l.title)).toEqual(['Excuses', 'bracelet']);
        expect(titles).toEqual(['Excuses', 'bracelet']);
    });
});

describe('linked-import refresh safety', () => {
    test('empty titles are never tracked as deletion keys', () => {
        const set = importedTitleSet([{ title: '' }, { title: '  ' }, { title: 'Excuses' }]);
        expect([...set]).toEqual(['excuses']);
    });

    test('the registry\'s plain title strings are tracked too', () => {
        // w.titles is stored as string[], not as entry objects — reading .title off a string
        // silently produced an empty set and made every refresh append a duplicate 24-entry book.
        expect([...importedTitleSet(['Excuses', '', 'Meg Sullivan'])]).toEqual(['excuses', 'meg sullivan']);
    });

    test('an untitled hand-written entry survives a refresh', () => {
        const book = [
            { title: '', content: 'my own note', activation: 'always' },
            { title: 'Excuses', content: 'old imported body' },
            { title: '', content: 'old imported body with no title' },
        ];
        const fresh = [{ title: 'Excuses', content: 'new imported body' }, { title: '', content: 'new untitled body' }];
        const kept = stripPreviousImport(
            book,
            importedTitleSet([{ title: 'Excuses' }]),
            importedContentHashes([{ content: 'old imported body' }, { content: 'old imported body with no title' }]),
            fresh,
        );
        expect(kept.map(e => e.content)).toEqual(['my own note']);
    });

    test('an untitled imported entry is removed by exact content, not by title', () => {
        const book = [{ title: '', content: 'imported body' }];
        const fresh = [{ title: '', content: 'imported body' }];
        // Legacy records have no hashes; an exact fresh-content match is the fallback.
        expect(stripPreviousImport(book, new Set(), new Set(), fresh)).toEqual([]);
    });

    test('a renamed imported entry is left in place (duplicate is recoverable)', () => {
        const book = [{ title: 'My rename', content: 'imported body' }];
        const fresh = [{ title: '', content: 'imported body' }];
        // No title/hash match (only an exact-content legacy match would remove this).
        expect(stripPreviousImport(book, new Set(), new Set([importedContentHashes([{ content: 'other' }]).values().next().value]), [{ title: 'x', content: 'changed' }])).toHaveLength(1);
    });
});

describe('card source hash', () => {
    const base = { name: 'X', description: 'd', personality: 'p', scenario: 's', data: { character_book: { entries: [] } } };

    test('is stable for equal content and changes with the embedded book', () => {
        expect(cardImportHash(base)).toBe(cardImportHash(JSON.parse(JSON.stringify(base))));
        const edited = JSON.parse(JSON.stringify(base));
        edited.data.character_book.entries.push({ keys: ['k'], comment: 'c', content: 'new lore' });
        expect(cardImportHash(edited)).not.toBe(cardImportHash(base));
    });

    test('changes when a greeting changes', () => {
        const edited = { ...base, first_mes: 'hello' };
        expect(cardImportHash(edited)).not.toBe(cardImportHash(base));
    });
});

describe('chat import identity', () => {
    const msgs = [
        { name: 'The Bracelet Stays On', is_user: false, mes: 'opening' },
        { name: 'Natsu', is_user: true, mes: 'hello' },
    ];

    test('the hero is the player, never the AI card', () => {
        expect(chatPlayerName({ user_name: 'unused' }, msgs, 'The Bracelet Stays On')).toBe('Natsu');
        expect(chatPlayerName({ user_name: 'Gedeon' }, msgs, 'The Bracelet Stays On')).toBe('Gedeon');
        expect(chatPlayerName({}, [{ is_user: true, name: 'The Bracelet Stays On', mes: 'x' }], 'The Bracelet Stays On')).toBe('You');
    });

    test('macros are resolved and roles survive the conversion', () => {
        const out = chatMessagesToImport([
            { is_user: false, mes: '{{char}} looks at {{user}}.' },
            { is_user: true, mes: 'Hi.' },
            { is_system: true, mes: 'OOC note' },
            { is_user: true, mes: '   ' },
        ], { charName: 'Elise', playerName: 'Natsu' });
        expect(out.map(m => m.role)).toEqual(['assistant', 'user', 'action']);
        expect(out[0].text).toBe('Elise looks at Natsu.');
        expect(out).toHaveLength(3);
        // turn counts player messages, not all messages (an import of 30 lines is ~15 turns)
        expect(chatTurnCount(out)).toBe(1);
        expect(chatTurnCount([{ role: 'assistant' }, { role: 'user' }, { role: 'user' }])).toBe(2);
        expect(chatTurnCount([])).toBe(1);
    });
});
