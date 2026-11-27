import { describe as jestDescribe, test, expect } from '@jest/globals';
import { HAS_RPG_ENGINE, loadRpgEngine } from './rpg-source.js';

const describe = HAS_RPG_ENGINE ? jestDescribe : jestDescribe.skip;
const { subUser } = HAS_RPG_ENGINE ? await loadRpgEngine('text-utils.js') : {};

describe('{{user}} substitution', () => {
    test('all ST spellings resolve', () => {
        expect(subUser('{{user}} and {{User}} and {{ USER }}', 'Natsu')).toBe('Natsu and Natsu and Natsu');
    });
    test('blank and null are safe', () => {
        expect(subUser(null, 'Natsu')).toBe('');
        expect(subUser('{{user}}', '')).toBe('the hero');
    });
    test('a name with a dollar sign is literal', () => {
        expect(subUser('{{user}}', '$&')).toBe('$&');
    });
});
