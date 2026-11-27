import { describe as jestDescribe, test, expect } from '@jest/globals';
import { HAS_RPG_ENGINE, loadRpgEngine } from './rpg-source.js';

const describe = HAS_RPG_ENGINE ? jestDescribe : jestDescribe.skip;
const { normalizeLorebook } = HAS_RPG_ENGINE ? await loadRpgEngine('lorebook.js') : {};
const { emptyWorld, worldToFile, normalizeWorld } = HAS_RPG_ENGINE ? await loadRpgEngine('world.js') : {};

// Authored World Info fields must survive the editor -> save -> load -> re-save loop.
// Old worlds that never set them must keep their original compact shape.

describe('world lore persistence', () => {
    test('advanced fields round-trip through the portable world file', () => {
        const w = emptyWorld('test-world', 'Test World');
        w.lorebook = normalizeLorebook([{
            title: 'Meg', type: 'character', activation: 'keywords',
            keywords: ['\\b(Meg|Sullivan)\\b', 'bracelet'],
            content: 'Meg works nights.', order: 4, probability: 60,
            selective: true, secondary: ['diner'], useRegex: true,
            role: 'system', depth: 2,
        }]);
        const file = JSON.parse(JSON.stringify(worldToFile(w)));
        expect(file.lorebook[0]).toEqual({
            title: 'Meg', type: 'character', activation: 'keywords',
            keywords: ['\\b(Meg|Sullivan)\\b', 'bracelet'],
            content: 'Meg works nights.', order: 4, probability: 60,
            selective: true, secondary: ['diner'], useRegex: true,
            role: 'system', depth: 2,
        });
        const loaded = normalizeWorld(file);
        expect(loaded.errors).toEqual([]);
        const e = loaded.world.lorebook[0];
        expect(e.order).toBe(4);
        expect(e.probability).toBe(60);
        expect(e.selective).toBe(true);
        expect(e.secondary).toEqual(['diner']);
        expect(e.useRegex).toBe(true);
        expect(e.role).toBe('system');
        expect(e.depth).toBe(2);
        expect(e.injection).toBe(true);
    });

    test('plain entries stay plain and defaults do not leak into the file', () => {
        const w = emptyWorld('plain', 'Plain');
        w.lorebook = normalizeLorebook([{ title: 'A', content: 'a', activation: 'always' }]);
        const file = worldToFile(w);
        expect(file.lorebook[0]).toEqual({ title: 'A', type: 'lore', activation: 'always', keywords: [], content: 'a' });
    });
});
