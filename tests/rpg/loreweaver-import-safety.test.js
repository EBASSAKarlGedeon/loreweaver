import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The import page has two direct-write paths that bypass HeroStore/WorldStore. Both used to be
// able to destroy data: a 41st persona import shifted the oldest saved hero out, and a new world
// trusted only the cached world index before reusing a slug. These are source contracts because
// the functions are closures inside mountImportsPage and cannot be called in isolation.

const SOURCE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/app/src/scripts/loreweaver-import.js',
);
const source = fs.existsSync(SOURCE_PATH) ? fs.readFileSync(SOURCE_PATH, 'utf8') : '';
const describeIfSource = source ? describe : describe.skip;

describeIfSource('import page data safety', () => {
    test('a full hero library refuses the import instead of evicting the oldest hero', () => {
        expect(source).toContain('import { MAX_SAVED_HEROES } from "./storage.js"');
        const start = source.indexOf('async function saveHeroList(');
        const end = source.indexOf('function findLinkedHero(', start);
        const block = source.slice(start, end);
        expect(block).toContain('list.length > MAX_SAVED_HEROES');
        expect(block).toContain('hero-limit');
        expect(block).not.toContain('list.shift()');
    });

    test('a new world id is checked against the stored blob, not only the index', () => {
        const start = source.indexOf('async function freshWorldId(');
        const end = source.indexOf('async function refreshWorldImport(', start);
        expect(source.slice(start, end)).toContain('window.root.kv.worlds.get(cand)');
    });
});
