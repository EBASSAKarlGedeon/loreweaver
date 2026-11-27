import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { janitorMacroRestorer, janitorTriggerMessage } from '../../src/endpoints/weavers-vault-janitor-capture.js';

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

describe('janitorMacroRestorer', () => {
    test('puts both macros back and strips the credit line', () => {
        const macro = janitorMacroRestorer({ charNames: ['Anna Lee'], userNames: ['Hiro'] });
        expect(macro('Hiro met Anna Lee.\ncreated by someone on janitorai.com'))
            .toBe('{{user}} met {{char}}.');
    });

    test('every account identity candidate is restored', () => {
        const macro = janitorMacroRestorer({ userNames: ['Hiro', 'Hiro_123'] });
        expect(macro('Hiro_123 met Hiro.')).toBe('{{user}} met {{user}}.');
    });

    test('with no names it leaves prose alone', () => {
        expect(janitorMacroRestorer({})('Body text.')).toBe('Body text.');
    });
});

/**
 * The 2026-11-26 bug: the site expands `{{user}}` to the account's persona name,
 * and the capture put `{{char}}` back but never the user name, so every imported
 * card carried one person's name where the macro belonged. Nothing in the pure
 * functions could catch it — the name was simply never passed in.
 */
const captureSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/endpoints/weavers-vault-janitor-capture.js'),
    'utf8',
);

describe('capture macro wiring', () => {
    test('reads the account identity the site expands', () => {
        expect(captureSource).toContain('/profiles/mine');
        expect(captureSource).toContain('readAccountUserNames(');
        expect(captureSource).toMatch(/janitorAccountNames\(/);
    });

    test('every captured text field goes through the restorer built from both name sets', () => {
        // One closure for the card, scenario, examples, greetings and lorebook:
        // `macro(...)` is the only path into the card fields.
        expect(captureSource).toContain('janitorMacroRestorer({ charNames, userNames })');
        const restorer = captureSource.slice(captureSource.indexOf('export function janitorMacroRestorer'));
        expect(restorer.slice(0, restorer.indexOf('export async function'))).toContain('restoreMacros(');
    });
});
