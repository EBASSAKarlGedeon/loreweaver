import { describe as jestDescribe, test, expect } from '@jest/globals';
import { HAS_RPG_ENGINE, loadRpgEngine } from './rpg-source.js';

const describe = HAS_RPG_ENGINE ? jestDescribe : jestDescribe.skip;
const {
    normalizeLoreEntry,
    loreEntryMatches,
    loreKeywordHits,
    lorebookForText,
    keywordLoreForText,
    selectLoreForTurn,
    loreForTurn,
    loreInsertionIndex,
    renderLoreInsertion,
} = HAS_RPG_ENGINE ? await loadRpgEngine('lorebook.js') : {};

// The engine used to drop World Info's order/depth/role/probability/selective/use_regex fields.
// These tests pin the native equivalents: schema, matching, selection, and at-depth placement.

describe('advanced lore schema', () => {
    test('normalizes regex, AND, priority, chance and insertion fields', () => {
        const e = normalizeLoreEntry({
            title: 'Meg',
            type: 'character',
            activation: 'keywords',
            keywords: ['\\b(Meg|Sullivan)\\b', '^bracelet$'],
            useRegex: true,
            selective: true,
            secondary: ['diner', '\\bbooth\\b'],
            order: 7,
            probability: 35,
            role: 1,
            depth: 2,
            content: 'Meg works the night shift.',
        });
        expect(e.keywords).toEqual(['\\b(Meg|Sullivan)\\b', '^bracelet$']);
        expect(e.secondary).toEqual(['diner', '\\bbooth\\b']);
        expect(e.useRegex).toBe(true);
        expect(e.selective).toBe(true);
        expect(e.order).toBe(7);
        expect(e.probability).toBe(35);
        expect(e.role).toBe('user');
        expect(e.depth).toBe(2);
        expect(e.injection).toBe(true);
    });

    test('clamps depth/chance and accepts numeric roles', () => {
        const e = normalizeLoreEntry({ content: 'x', depth: 9999, probability: 140, role: 2 });
        expect(e.depth).toBe(999);
        expect(e.probability).toBe(100);
        expect(e.role).toBe('assistant');
        const low = normalizeLoreEntry({ content: 'x', depth: -3, probability: -1, role: 'system' });
        expect(low.depth).toBe(0);
        expect(low.probability).toBe(0);
        expect(low.injection).toBe(true);
    });

    test('a bare role or bare depth does not move the entry', () => {
        expect(normalizeLoreEntry({ content: 'x', role: 'user' }).injection).toBe(false);
        expect(normalizeLoreEntry({ content: 'x', depth: 4 }).injection).toBe(false);
    });

    test('selective without secondary keys falls back to an ordinary keyword entry', () => {
        const e = normalizeLoreEntry({ content: 'x', activation: 'keywords', keywords: ['meg'], selective: true });
        expect(e.selective).toBe(false);
    });
});

describe('trigger matching', () => {
    test('regex keys match as authored and preserve alternation', () => {
        const e = normalizeLoreEntry({
            content: 'x', activation: 'keywords', useRegex: true,
            keywords: ['\\b(Meg|Sullivan)\\b'],
        });
        expect(loreEntryMatches(e, 'Meg is here.')).toBe(true);
        expect(loreEntryMatches(e, 'Sullivan is here.')).toBe(true);
        expect(loreEntryMatches(e, 'Nothing here.')).toBe(false);
    });

    test('selective requires the primary AND one secondary trigger', () => {
        const e = normalizeLoreEntry({
            content: 'x', activation: 'keywords', keywords: ['Meg'],
            secondary: ['diner', 'booth'], selective: true,
        });
        expect(loreEntryMatches(e, 'Meg is at the diner.')).toBe(true);
        expect(loreEntryMatches(e, 'Meg is in the booth.')).toBe(true);
        expect(loreEntryMatches(e, 'Meg is at home.')).toBe(false);
        expect(loreEntryMatches(e, 'Someone is at the diner.')).toBe(false);
    });

    test('invalid regex falls back to literal matching instead of throwing', () => {
        const e = normalizeLoreEntry({ content: 'x', activation: 'keywords', useRegex: true, keywords: ['[unclosed'] });
        expect(loreKeywordHits(e, 'the [unclosed pattern', '[unclosed')).toBe(true);
        expect(loreEntryMatches(e, 'the [unclosed pattern')).toBe(true);
    });

    test('the digest helpers honour selective and regex', () => {
        const entries = [
            normalizeLoreEntry({ title: 'A', content: 'a', activation: 'keywords', keywords: ['meg'], secondary: ['diner'], selective: true }),
            normalizeLoreEntry({ title: 'B', content: 'b', activation: 'keywords', useRegex: true, keywords: ['^bracelet$'] }),
        ];
        expect(lorebookForText(entries, 'Meg at the diner')).toContain('A');
        expect(lorebookForText(entries, 'Meg at home')).not.toContain('A');
        expect(keywordLoreForText(entries, 'bracelet')).toContain('B');
        expect(keywordLoreForText(entries, 'Meg at the diner')).not.toContain('B');
    });
});

describe('selection', () => {
    test('higher order wins ties in both always and keyword tiers', () => {
        const always = [
            normalizeLoreEntry({ title: 'Low', content: 'low', activation: 'always', order: 1 }),
            normalizeLoreEntry({ title: 'High', content: 'high', activation: 'always', order: 9 }),
        ];
        expect(selectLoreForTurn(always).always.map((e) => e.title)).toEqual(['High', 'Low']);

        const keyword = [
            normalizeLoreEntry({ title: 'Low', content: 'The dragon sleeps.', activation: 'keywords', keywords: ['dragon'], order: 1 }),
            normalizeLoreEntry({ title: 'High', content: 'The dragon sleeps.', activation: 'keywords', keywords: ['dragon'], order: 9 }),
        ];
        const sel = selectLoreForTurn(keyword, { actionText: 'I look at the dragon.' });
        expect(sel.chosen.map((e) => e.title)).toEqual(['High', 'Low']);
    });

    test('scene recency outranks order when ranking has no lexical signal', () => {
        // Regex escapes keep the trigger out of BM25's token stream, forcing the recency fallback.
        const recent = normalizeLoreEntry({ title: 'Recent', content: 'a', activation: 'keywords', useRegex: true, keywords: ['\\x7a'], order: 1 });
        const old = normalizeLoreEntry({ title: 'Old', content: 'b', activation: 'keywords', useRegex: true, keywords: ['\\x71'], order: 9 });
        const sel = selectLoreForTurn([old, recent], { actionText: 'z', location: 'q' });
        expect(sel.chosen.map((e) => e.title)).toEqual(['Recent', 'Old']);
    });

    test('probability 0 never fires and 100 always does; profiles can opt out', () => {
        const never = normalizeLoreEntry({ title: 'Never', content: 'x', activation: 'always', probability: 0 });
        const always = normalizeLoreEntry({ title: 'Always', content: 'x', activation: 'always', probability: 100 });
        const sel = selectLoreForTurn([never, always]);
        expect(sel.always.map((e) => e.title)).toEqual(['Always']);
        expect(selectLoreForTurn([never, always], { applyProbability: false }).always.map((e) => e.title))
            .toEqual(['Never', 'Always']);
    });

    test('the probability roll is stable for the same seed and turn', () => {
        const e = normalizeLoreEntry({ title: 'Coin', content: 'x', activation: 'always', probability: 50 });
        const first = selectLoreForTurn([e], { seed: 'adventure:7' }).always.length;
        const second = selectLoreForTurn([e], { seed: 'adventure:7' }).always.length;
        expect(first).toBe(second);
    });

    test('reordering the book never rerolls an entry\'s chance', () => {
        const coin = normalizeLoreEntry({ title: 'Coin', content: 'x', activation: 'always', probability: 50 });
        const other = normalizeLoreEntry({ title: 'Other', content: 'y', activation: 'always', probability: 100 });
        for (let turn = 0; turn < 12; turn++) {
            const seed = 'adventure:' + turn;
            const before = selectLoreForTurn([coin, other], { seed }).always.includes(coin);
            const after = selectLoreForTurn([other, coin], { seed }).always.includes(coin);
            expect(after).toBe(before);
        }
    });

    test('a selective entry without its secondary trigger is never admitted semantically', () => {
        const e = normalizeLoreEntry({
            title: 'Diner', content: 'A neon diner on the highway.', activation: 'keywords',
            keywords: ['Meg'], secondary: ['diner'], selective: true,
        });
        expect(selectLoreForTurn([e], { actionText: 'Meg is at home.' }).chosen).toEqual([]);
        expect(selectLoreForTurn([e], { actionText: 'Meg is at the diner.' }).chosen.map((x) => x.title))
            .toEqual(['Diner']);
    });

    test('loreForTurn still renders positioned entries for non-GM digests', () => {
        const e = normalizeLoreEntry({ title: 'Depth', content: 'At depth.', activation: 'always', role: 'system', depth: 4 });
        expect(loreForTurn([e])).toContain('At depth.');
    });
});

describe('at-depth placement helpers', () => {
    test('depth counts messages back from the newest boundary', () => {
        expect(loreInsertionIndex({ depth: 0 }, 10)).toBe(10);
        expect(loreInsertionIndex({ depth: 4 }, 10)).toBe(6);
        expect(loreInsertionIndex({ depth: 99 }, 10)).toBe(0);
        expect(loreInsertionIndex({}, 10)).toBe(10);
    });

    test('the insertion line carries its authored role', () => {
        const e = normalizeLoreEntry({ title: 'Rule', content: 'No shoes.', activation: 'always', role: 'assistant', depth: 0 });
        expect(renderLoreInsertion(e)).toBe('[ASSISTANT LORE] ◆ [lore] Rule — No shoes.');
    });
});
