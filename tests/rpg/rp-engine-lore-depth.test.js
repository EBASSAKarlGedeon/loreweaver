import { describe as jestDescribe, test, expect } from '@jest/globals';
import { HAS_RPG_ENGINE, loadRpgEngine } from './rpg-source.js';

const describe = HAS_RPG_ENGINE ? jestDescribe : jestDescribe.skip;
const { RPEngine } = HAS_RPG_ENGINE ? await loadRpgEngine('rp-engine.js') : {};
const { normalizeLorebook } = HAS_RPG_ENGINE ? await loadRpgEngine('lorebook.js') : {};

// End-to-end context assembly: an at-depth World Info entry must ride INSIDE the transcript at
// its authored message boundary, while ordinary lore stays in WORLD LORE.

const lore = normalizeLorebook([
    { title: 'Standing', type: 'lore', activation: 'always', content: 'STANDING_FACT' },
    { title: 'One', type: 'lore', activation: 'always', content: 'AT_DEPTH_ONE', role: 'system', depth: 1, order: 5 },
    { title: 'Zero', type: 'lore', activation: 'always', content: 'AT_DEPTH_ZERO', role: 'assistant', depth: 0, order: 1 },
]);

const history = [
    { role: 'narrator', text: 'The diner is quiet.' },
    { role: 'action', text: 'I sit at the counter.' },
    { role: 'narrator', text: 'Meg looks up.' },
    { role: 'action', text: 'I wave.' },
];

function engine() {
    return new RPEngine({ genText: async () => '', promptText: 'PROMPT', loreEntries: lore });
}

describe('at-depth lore in the GM context', () => {
    test('positioned entries enter the transcript at their boundary, not WORLD LORE', () => {
        const state = { id: 'adv', turn: 3, character: { name: 'Hero', stats: {} }, messages: history, memories: { manual: [], auto: [] } };
        const ctx = engine().buildContext(state, history, 'I order coffee', 'action', false, {});
        const worldLore = ctx.indexOf('WORLD LORE');
        const one = ctx.indexOf('AT_DEPTH_ONE');
        const zero = ctx.indexOf('AT_DEPTH_ZERO');
        const lastAction = ctx.indexOf('I wave.');
        const latest = ctx.indexOf('LATEST ACTION: I order coffee');
        expect(worldLore).toBeGreaterThanOrEqual(0);
        expect(ctx).toContain('STANDING_FACT');
        expect(one).toBeLessThan(lastAction);
        expect(zero).toBeGreaterThan(lastAction);
        expect(zero).toBeGreaterThan(one);
        expect(zero).toBeLessThan(latest);
        expect(ctx).toContain('[SYSTEM LORE]');
        expect(ctx).toContain('[ASSISTANT LORE]');
    });

    test('with no transcript yet, the same entries keep their labels in one ordered section', () => {
        const state = { id: 'adv', turn: 0, character: { name: 'Hero', stats: {} }, messages: [], memories: { manual: [], auto: [] } };
        const ctx = engine().buildContext(state, [], '', 'action', true, {});
        expect(ctx).toContain('WORLD LORE — AT-DEPTH INSERTIONS');
        expect(ctx).toContain('AT_DEPTH_ONE');
        expect(ctx).toContain('AT_DEPTH_ZERO');
        expect(ctx).toContain('[SYSTEM LORE]');
        expect(ctx).toContain('[ASSISTANT LORE]');
    });
});
