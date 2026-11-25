import { describe, test, expect } from '@jest/globals';
import { janitorTriggerMessage } from '../../src/endpoints/weavers-vault-janitor-capture.js';

/**
 * The trigger send is the only place a closed lorebook's keys can fire:
 * measured 2026-11-24 on JanitorAI, the scan window sees exactly the message the
 * client sends, and the default message is the card's own text plus greetings.
 * A coverage pass that cannot add its own words can only ever test keys the card
 * happens to use, so the caller-supplied part is part of the contract.
 */

describe('janitorTriggerMessage', () => {
    test('the card text alone is a valid trigger', () => {
        expect(janitorTriggerMessage({ card: '  Your task is to roast the Hiro.  ' }))
            .toBe('Your task is to roast the Hiro.');
    });

    test('caller-supplied words are appended after the card text', () => {
        expect(janitorTriggerMessage({ card: 'card body', triggerText: 'morrowfen quokka' }))
            .toBe('card body\n\nmorrowfen quokka');
    });

    test('greetings follow the caller-supplied words', () => {
        expect(janitorTriggerMessage({
            card: 'card body',
            triggerText: 'morrowfen',
            greetings: ['first greeting', 'second greeting'],
        })).toBe('card body\n\nmorrowfen\n\nfirst greeting\n\n---\n\nsecond greeting');
    });

    test('empty parts never leave stray separators', () => {
        expect(janitorTriggerMessage({ card: 'card body', triggerText: '   ', greetings: [''] }))
            .toBe('card body');
    });

    test('nothing to say falls back to the probe dot', () => {
        expect(janitorTriggerMessage({})).toBe('.');
        expect(janitorTriggerMessage()).toBe('.');
    });
});
