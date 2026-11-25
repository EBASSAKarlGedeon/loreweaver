import { describe, test, expect } from '@jest/globals';
import {
    BOUNDLESS_MAX_TOKENS,
    CONTEXT_BLOCKS,
    DEFAULT_CHUNK_TOKENS,
    JS_SYSTEM_PROMPT,
    MIN_CHUNK_TOKENS,
    REBUILD_CONTEXT_DEFAULTS,
    REQUEST_TEMPERATURE,
    RebuildError,
    TEXT_SYSTEM_PROMPT,
    contextFor,
    greetingsContext,
    lorebookDescsContext,
    readRebuildSettings,
    resolveRebuildProfile,
    asKeys,
    chunkBudget,
    chunkText,
    messagesFor,
    normalizeEntry,
    parseReply,
    partCacheKey,
    planBuild,
    splitEntryBlocks,
    stripFences,
    transportFor,
} from '../../public/scripts/extensions/weavers-vault/lorebook-rebuild.js';

/** Deterministic counter: words. Predictable, and it makes every budget exact. */
const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean).length;

/** The block source text of one request, i.e. what the budget actually bounds. */
function payloadOf(messages) {
    const content = messages[1].content;
    const at = content.indexOf('Raw lorebook text to convert into entries:');
    const js = content.indexOf('JavaScript lorebook source to convert into entries:');
    const cut = at >= 0 ? at : js;
    expect(cut).toBeGreaterThan(-1);
    return content.slice(cut).split('\n\n').slice(1).join('\n\n');
}

function entry(overrides = {}) {
    return { comment: 'The House', key: ['house', 'the lane'], content: 'A house.', ...overrides };
}

describe('messages', () => {
    test('a text build sends the system prompt plus one user message', () => {
        const messages = messagesFor('ENTRY TEXT', { card: 'CARD TEXT' });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toEqual({ role: 'system', content: TEXT_SYSTEM_PROMPT });
        expect(messages[1].role).toBe('user');
        // The three parts join with the separator Glaze uses, in block order.
        const content = messages[1].content;
        expect(content.startsWith(CONTEXT_BLOCKS[0].intro)).toBe(true);
        expect(content).toContain('\n\nCARD TEXT');
        expect(content).toContain('\n\n---\n\nRaw lorebook text to convert into entries:\n\nENTRY TEXT');
        expect(content.endsWith('ENTRY TEXT')).toBe(true);
    });

    test('an empty or unselected block is absent, never a bare header', () => {
        const content = messagesFor('TEXT', { card: 'CARD', scenario: '   ', greetings: '' })[1].content;
        expect(content).toContain('CARD');
        expect(content).not.toContain(CONTEXT_BLOCKS[2].intro);
        expect(content).not.toContain(CONTEXT_BLOCKS[3].intro);
        // And a block nobody passed at all is absent too.
        expect(content).not.toContain(CONTEXT_BLOCKS[4].intro);
    });

    test('the JS build changes the payload header and the system prompt', () => {
        const messages = messagesFor('const loreEntries = []', { fromJs: true });
        expect(messages[0].content).toBe(JS_SYSTEM_PROMPT);
        expect(messages[1].content).toContain('JavaScript lorebook source to convert into entries:');
    });

    test('a blank system prompt override falls back to the built-in one', () => {
        expect(messagesFor('x', { systemPrompt: '   ' })[0].content).toBe(TEXT_SYSTEM_PROMPT);
        expect(messagesFor('x', { fromJs: true, systemPrompt: '' })[0].content).toBe(JS_SYSTEM_PROMPT);
        expect(messagesFor('x', { systemPrompt: 'MINE' })[0].content).toBe('MINE');
    });
});

describe('budget', () => {
    test('the setting is the budget when the window is unknown', () => {
        expect(chunkBudget({ chunkTokens: 9000, window: 0 })).toBe(9000);
        expect(chunkBudget({ window: 0 })).toBe(DEFAULT_CHUNK_TOKENS);
    });

    test('half of what is left after the repeated context wins over the setting', () => {
        expect(chunkBudget({ chunkTokens: 24000, window: 9000, fixedTokens: 1000 })).toBe(4000);
    });

    test('the floor survives a tiny window, and never goes negative', () => {
        expect(chunkBudget({ chunkTokens: 24000, window: 3000, fixedTokens: 0 })).toBe(MIN_CHUNK_TOKENS);
        expect(chunkBudget({ chunkTokens: 500, window: 100000 })).toBe(MIN_CHUNK_TOKENS);
        expect(chunkBudget({ chunkTokens: 24000, window: 1000, fixedTokens: 5000 })).toBe(MIN_CHUNK_TOKENS);
    });
});

describe('plan', () => {
    test('text that fits is one request carrying the whole text', () => {
        const plan = planBuild({ text: 'short text', countTokens: words });
        expect(plan.reason).toBe('fits');
        expect(plan.requests).toHaveLength(1);
        expect(payloadOf(plan.requests[0])).toBe('short text');
    });

    test('a source over budget splits, and every part repeats the full context', () => {
        // 220 blocks of 21 words: well over the 2000-word budget floor, so the
        // split actually happens (a smaller source would collapse to one chunk).
        const blocks = Array.from({ length: 220 }, (_, i) => `Block ${i} ` + 'word '.repeat(19).trim());
        const text = blocks.join('\n\n');
        const plan = planBuild({
            text,
            countTokens: words,
            chunkTokens: 100,
            window: 0,
            context: { card: 'CARD TEXT', scenario: 'SCENARIO TEXT' },
        });
        expect(plan.reason).toBe('chunked');
        expect(plan.requests.length).toBeGreaterThan(1);
        for (const messages of plan.requests) {
            expect(messages[1].content).toContain('CARD TEXT');
            expect(messages[1].content).toContain('SCENARIO TEXT');
            expect(words(payloadOf(messages))).toBeLessThanOrEqual(plan.budget);
        }
        // Nothing lost, nothing duplicated: the payloads are the blocks again.
        const rebuilt = plan.requests.map(m => payloadOf(m)).join('\n\n');
        expect(rebuilt).toBe(splitEntryBlocks(text).join('\n\n'));
    });

    test('a JavaScript source is always one request', () => {
        const many = Array.from({ length: 400 }, (_, i) => `ENTRY ${i} ` + 'x '.repeat(50)).join('\n\n');
        const plan = planBuild({ text: many, fromJs: true, countTokens: words, chunkTokens: 100 });
        expect(plan.reason).toBe('javascript');
        expect(plan.requests).toHaveLength(1);
        expect(plan.requests[0][0].content).toBe(JS_SYSTEM_PROMPT);
    });

    test('chunking off is one request too', () => {
        const plan = planBuild({ text: 'a\n\nb', countTokens: words, chunkTokens: 0 });
        expect(plan.reason).toBe('chunking-off');
        expect(plan.requests).toHaveLength(1);
    });

    test('one chunk still sends the whole text, not the chunk', () => {
        // Over the budget as a whole, but a single block: it splits into one
        // chunk only when the splitter cannot improve on it, so the plan must
        // send the original text.
        const text = 'one block only';
        const plan = planBuild({ text, countTokens: () => 1, chunkTokens: 2 });
        expect(plan.requests).toHaveLength(1);
        expect(payloadOf(plan.requests[0])).toBe(text);
    });
});

describe('splitting', () => {
    test('entry blocks split on blank lines', () => {
        expect(splitEntryBlocks('a\n\nb\n\n\nc')).toEqual(['a', 'b', 'c']);
    });

    test('an over-long block is cut on lines, and an over-long line by length', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${'w '.repeat(10)}`).join('\n');
        const pieces = chunkText(lines, 40, words);
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) expect(words(piece)).toBeLessThanOrEqual(40);
        // Blocks are trimmed at their edges (whitespace carries no meaning there),
        // so compare the collapsed text, not the byte string.
        expect(pieces.join('\n').replace(/\s+/g, ' ').trim()).toBe(lines.replace(/\s+/g, ' ').trim());

        // A single over-long line has no structure left to cut on, so it is cut by
        // length. Characters as the unit, because words would call it one token.
        const longline = 'x'.repeat(400);
        const byLength = chunkText(longline, 10, (t) => String(t).length);
        expect(byLength.length).toBe(40);
        expect(byLength.every(piece => piece.length <= 10)).toBe(true);
        expect(byLength.join('')).toBe(longline);
    });
});

describe('reply parsing', () => {
    test('strips fences and cuts to the outermost JSON', () => {
        expect(stripFences('```json\n{"entries":[]}\n```')).toBe('{"entries":[]}');
        expect(stripFences('Sure! {"entries":[]} done')).toBe('{"entries":[]}');
    });

    test('accepts a bare array, entries as a map, and a lorebook array', () => {
        const bare = parseReply(JSON.stringify([entry()]));
        expect(bare.entries).toHaveLength(1);
        const map = parseReply(JSON.stringify({ entries: { a: entry(), b: entry({ comment: 'B' }) } }));
        expect(map.entries.map(e => e.comment)).toEqual(['The House', 'B']);
        const lorebook = parseReply(JSON.stringify({ lorebook: [entry()] }));
        expect(lorebook.entries).toHaveLength(1);
    });

    test('accepts the aliases the site uses, and defaults order to 100', () => {
        const { entries } = parseReply(JSON.stringify({ entries: [{
            keys: 'House, the lane',
            secondary_keys: ['night'],
            text: 'A house that keeps its own hours.',
            title: 'The House',
            priority: 250,
            constant: true,
        }] }));
        expect(entries[0]).toEqual({
            comment: 'The House',
            key: ['House', 'the lane'],
            keysecondary: ['night'],
            content: 'A house that keeps its own hours.',
            order: 250,
            constant: true,
        });
        expect(parseReply(JSON.stringify([entry()])).entries[0].order).toBe(100);
    });

    test('a contentless entry is dropped and counted, not saved', () => {
        const parsed = parseReply(JSON.stringify([entry(), { comment: 'Empty', key: ['x'] }]));
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.dropped).toBe(1);
    });

    test('an unusable reply throws a RebuildError that names the part', () => {
        expect(() => parseReply('I cannot do that.')).toThrow(RebuildError);
        try {
            parseReply('not json', { part: 2, total: 3, resumable: true });
        } catch (error) {
            expect(error.code).toBe('unparseable');
            expect(error.part).toBe(2);
            expect(error.total).toBe(3);
            expect(error.resumable).toBe(true);
            expect(error.raw).toBe('not json');
        }
        try {
            parseReply('{"entries":[]}', { part: 1, total: 1 });
        } catch (error) {
            expect(error.code).toBe('no-entries');
        }
    });

    test('keys normalize from arrays and comma strings, without duplicates', () => {
        expect(asKeys(['a', ' b ', 'a', ''])).toEqual(['a', 'b']);
        expect(asKeys('a, b,a')).toEqual(['a', 'b']);
        expect(asKeys(undefined)).toEqual([]);
    });

    test('an entry without a comment falls back to its index', () => {
        expect(normalizeEntry({ content: 'x' }, 4).comment).toBe('Entry 4');
    });
});

describe('transport', () => {
    test('the reply is boundless and preset-free', () => {
        const plan = planBuild({ text: 'x', countTokens: words });
        const request = transportFor(plan.requests[0]);
        // undefined, not 0 and not a cap: createRequestData() deletes undefined
        // keys, so max_tokens never reaches the provider (custom-request.js:444).
        expect(request.maxTokens).toBe(BOUNDLESS_MAX_TOKENS);
        expect(request.maxTokens).toBeUndefined();
        expect(request.temperature).toBe(REQUEST_TEMPERATURE);
        expect(request.includePreset).toBe(false);
        expect(request.stream).toBe(false);
        expect(request.messages).toBe(plan.requests[0]);
    });

    test('a cached part is keyed by profile, model and the exact messages', () => {
        const messages = messagesFor('TEXT');
        const key = partCacheKey({ profileId: 'p1', model: 'm1' }, messages);
        expect(key).toBe(partCacheKey({ profileId: 'p1', model: 'm1' }, messages));
        expect(key).not.toBe(partCacheKey({ profileId: 'p2', model: 'm1' }, messages));
        expect(key).not.toBe(partCacheKey({ profileId: 'p1', model: 'm2' }, messages));
        expect(key).not.toBe(partCacheKey({ profileId: 'p1', model: 'm1' }, messagesFor('OTHER')));
    });
});
describe('build settings', () => {
    test('a missing or garbled entry becomes complete defaults', () => {
        for (const raw of [undefined, null, 'x', 5, [], {}]) {
            const settings = readRebuildSettings(raw);
            expect(settings.chunkTokens).toBe(DEFAULT_CHUNK_TOKENS);
            expect(settings.profileId).toBe('');
            expect(settings.context).toEqual(REBUILD_CONTEXT_DEFAULTS);
            expect(settings.extra).toBe('');
            expect(settings.systemJs).toBe('');
        }
    });

    test('what the user saved survives, and nonsense is repaired', () => {
        const settings = readRebuildSettings({
            profileId: 'p1',
            model: '  cheap-model  ',
            chunkTokens: -4,
            context: { catalog: true, greetings: 'yes' },
            extra: 'Names: the Warden',
        });
        expect(settings.profileId).toBe('p1');
        expect(settings.model).toBe('cheap-model');
        expect(settings.chunkTokens).toBe(DEFAULT_CHUNK_TOKENS);
        expect(settings.context.catalog).toBe(true);
        expect(settings.context.greetings).toBe(false);
        expect(settings.context.lorebookDescs).toBe(true);
        expect(settings.extra).toBe('Names: the Warden');
    });

    test('0 chunk tokens is kept: it means one request, not a default', () => {
        expect(readRebuildSettings({ chunkTokens: 0 }).chunkTokens).toBe(0);
    });
});

describe('profile choice', () => {
    const profiles = [
        { id: 'p1', name: 'Cheaper', model: 'm1' },
        { id: 'p2', name: 'Active', model: 'm2' },
    ];

    test('a valid saved profile wins, and is not a fallback', () => {
        const chosen = resolveRebuildProfile(profiles, 'p1', 'p2');
        expect(chosen.profile.id).toBe('p1');
        expect(chosen.fellBack).toBe(false);
        expect(chosen.staleId).toBe('');
    });

    test('an empty saved id means the active profile, without a warning', () => {
        const chosen = resolveRebuildProfile(profiles, '', 'p2');
        expect(chosen.profile.id).toBe('p2');
        expect(chosen.fellBack).toBe(false);
    });

    test('a stale saved id falls back to active and says which id died', () => {
        const chosen = resolveRebuildProfile(profiles, 'gone', 'p2');
        expect(chosen.profile.id).toBe('p2');
        expect(chosen.fellBack).toBe(true);
        expect(chosen.staleId).toBe('gone');
    });

    test('no usable profile is an error, never a silent guess', () => {
        expect(() => resolveRebuildProfile([], 'p1', 'p2')).toThrow(RebuildError);
        try {
            resolveRebuildProfile([], '', '');
        } catch (error) {
            expect(error.code).toBe('no-profile');
        }
    });
});

describe('context', () => {
    const card = {
        data: {
            description: 'A lighthouse keeper.',
            scenario: 'A storm.',
            first_mes: 'Hello.',
            alternate_greetings: ['Hi.', '', 'Hey.'],
        },
    };
    const books = [
        { title: 'The Warden', description: 'Who keeps the light.' },
        { name: 'Folklore', description: '' },
        { description: 'No title at all.' },
    ];

    test('the card fields map to their own blocks', () => {
        const context = contextFor({ card, books, toggles: { greetings: true } });
        expect(context.card).toBe('A lighthouse keeper.');
        expect(context.scenario).toBe('A storm.');
        expect(context.greetings).toBe('Hello.\n\n---\n\nHi.\n\n---\n\nHey.');
        expect(context.lorebookDescs).toBe('The Warden\n\nWho keeps the light.\n\n\nFolklore\n\n\nNo title at all.');
        expect(context.catalog).toBe('');
    });

    test('a build leaves greetings off by default, exactly like Glaze', () => {
        // janitor_lorebook_capture_sheet.dart:233 — the build sources default to
        // card/catalog/scenario/lorebookDescs, and greetings stay opt-in.
        expect(contextFor({ card }).greetings).toBe('');
        expect(REBUILD_CONTEXT_DEFAULTS).toEqual({
            card: true, catalog: false, scenario: true, greetings: false, lorebookDescs: true,
        });
    });

    test('a toggle that is off sends nothing for its block', () => {
        const context = contextFor({ card, books, toggles: { card: false, scenario: false, lorebookDescs: false } });
        expect(context.card).toBe('');
        expect(context.scenario).toBe('');
        expect(context.lorebookDescs).toBe('');
        expect(context.greetings).toBe('');
    });

    test('the extra box is free text, always included when non-empty', () => {
        expect(contextFor({ extra: '  the Warden\nthe Keeper  ' }).extra).toBe('the Warden\nthe Keeper');
        expect(contextFor({}).extra).toBe('');
    });

    test('a context object flows into the messages unchanged', () => {
        const context = contextFor({ card, books, extra: 'Alias: Ward' });
        const plan = planBuild({ text: 'const loreEntries = []', fromJs: true, context, countTokens: words });
        const content = plan.requests[0][1].content;
        expect(content).toContain('A lighthouse keeper.');
        expect(content).toContain('A storm.');
        expect(content).toContain('The Warden');
        expect(content).toContain('Alias: Ward');
        expect(content).not.toContain('Hello.');
        expect(content.indexOf('A lighthouse keeper.')).toBeLessThan(content.indexOf('const loreEntries'));
    });
});