import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the 2026-11-23 data-loss bug.
 *
 * The vault used to stamp provenance with POST /api/characters/edit, which
 * rebuilds the card through charaFormatData() and blanks every text field the
 * request does not carry in its flat form fields. Measured A/B on the Testing
 * worktree: desc 5213 -> 0 after the stamp call, with the import itself fine.
 * See docs/PITFALLS.md entry 1.
 *
 * These assertions are deliberately about the source contract, because the bug
 * is a wrong endpoint choice — nothing in the pure logic could have caught it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../public/scripts/extensions/weavers-vault/index.js'), 'utf8');

/** Every fetch to a given API route, ignoring comments. */
function fetchCalls(route) {
    const pattern = new RegExp(String.raw`fetch\(\s*[\x27"` + '`' + String.raw`]` + route.replace(/[/]/g, '\\/'), 'g');
    return source.match(pattern) ?? [];
}

describe('vault provenance stamping', () => {
    test('never writes a character through /api/characters/edit', () => {
        expect(fetchCalls('/api/characters/edit')).toEqual([]);
    });

    test('stamps through /api/characters/merge-attributes', () => {
        expect(fetchCalls('/api/characters/merge-attributes')).toHaveLength(1);
        expect(source).toMatch(/async function stampVaultProvenance\(/);
    });

    test('sends only the keys it means to change', () => {
        const body = source.slice(source.indexOf('async function stampVaultProvenance('));
        const payload = body.slice(0, body.indexOf('return true'));
        // The payload must be { avatar, data: { extensions } } — nothing that
        // could overwrite text fields.
        expect(payload).toMatch(/JSON\.stringify\(\{\s*avatar,\s*data:\s*\{\s*extensions\s*\}\s*\}\)/);
        for (const field of ['description', 'first_mes', 'personality', 'scenario', 'tags']) {
            expect(payload).not.toContain(field);
        }
    });

    test('both import paths use the shared stamp helper', () => {
        const calls = source.match(/await stampVaultProvenance\(/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
        // DataCat and chub provenance keys both still exist.
        expect(source).toContain("vault_source: 'datacat'");
        expect(source).toContain("vault_source: 'chub'");
    });

    test('documents the trap where the next reader will look', () => {
        const pitfalls = readFileSync(join(here, '../../public/scripts/extensions/weavers-vault/docs/PITFALLS.md'), 'utf8');
        expect(pitfalls).toContain('/api/characters/edit');
        expect(pitfalls).toContain('/api/characters/merge-attributes');
        expect(pitfalls).toContain('retracted');
    });
});
