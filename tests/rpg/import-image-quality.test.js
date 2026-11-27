import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The image half of the Loreweaver import page ("Cards → NPCs" and "Add as world").
 *
 * The page has two image sources for a character card: the card's own file
 * (`/characters/<avatar>`) and the avatar thumbnail (`/thumbnail?type=avatar`). The
 * thumbnail endpoint renders 96x144 by default (`thumbnails.dimensions.avatar`), which is
 * right for the 52px list tile and wrong for anything stored: imported NPC avatars and
 * world covers were built from it, so both were pixelated — see PITFALLS #55.
 */

const SOURCE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/app/src/scripts/loreweaver-import.js',
);
const source = fs.existsSync(SOURCE_PATH) ? fs.readFileSync(SOURCE_PATH, 'utf8') : '';
const lines = source.split(/\r?\n/);

/**
 * The top-level function inside `mountImportsPage` whose declaration line starts with
 * `signature` (two-space indent), up to the next top-level declaration.
 * @param {string} signature e.g. `function buildNpcFromCard(`
 * @returns {string}
 */
function blockOf(signature) {
    const start = lines.findIndex(line => line.startsWith('  ' + signature));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !/^  (async )?(function|let|const|var) /.test(lines[end])) end++;
    return lines.slice(start, end).join('\n');
}

const describeIfSource = source ? describe : describe.skip;

describeIfSource('character card art', () => {
    test('the URL helpers name the two server routes', () => {
        expect(blockOf('function cardImageUrl(')).toContain('"/characters/"');
        expect(blockOf('function cardImageUrl(')).toContain('encodeURIComponent(avatar)');
        expect(blockOf('function cardThumbUrl(')).toContain('"/thumbnail?type=avatar&file="');
    });

    test('an imported NPC avatar is the card file, never the thumbnail', () => {
        const npc = blockOf('function buildNpcFromCard(');
        // The card-file URL is passed into the pure mapper; the mapper stores it verbatim.
        expect(npc).toContain('npcFromCard(card, card.avatar ? cardImageUrl(card.avatar) : "")');
        expect(npc).not.toContain('cardThumbUrl');
    });

    test('a world cover is drawn from the card file before any thumbnail fallback', () => {
        const asWorld = blockOf('async function importCardAsWorld(');
        expect(asWorld).toContain('toCoverDataUrl(cardImageUrl(card.avatar))');
        const full = asWorld.indexOf('cardImageUrl(card.avatar)');
        const thumb = asWorld.indexOf('cardThumbUrl(card.avatar)');
        expect(full).toBeGreaterThan(-1);
        expect(thumb).toBeGreaterThan(full); // the thumbnail only stands in when the card file fails
    });

    test('the list tile keeps the cheap thumbnail', () => {
        expect(blockOf('async function renderChars(')).toContain('cardThumbUrl(c.avatar)');
    });
});
