#!/usr/bin/env node
// Harvest the author's own keys from a capture into a reusable store (P4).
//
//   node tools/author-keys.mjs <capture.txt> [more...] [--out data/author-keys.json]
//
// A closed Janitor lorebook has no entry list, but the sheets declare their own
// "- Keywords:" lines and name their spirit. The store is keyed by normalised title,
// so a book by the same author that shares those sheets picks the keys up unchanged.
import fs from 'node:fs';
import { segmentLorebook } from '../public/scripts/extensions/weavers-vault/lorebook-segment.js';
import { buildKeyStore, mergeStores } from '../public/scripts/extensions/weavers-vault/lorebook-keys.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : 'data/author-keys.json';
const inputs = args.filter((value, index) => value !== '--out' && index !== outAt + 1 || (outAt < 0 && index >= 0));
const files = args.filter((value, index) => value !== '--out' && index !== outAt + 1);

if (!files.length) {
    console.error('usage: node tools/author-keys.mjs <capture.txt> [more...] [--out data/author-keys.json]');
    process.exit(2);
}

const stores = [];
if (fs.existsSync(outPath)) stores.push(JSON.parse(fs.readFileSync(outPath, 'utf8')));
let totalAuthored = 0;
const collisions = [];

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const segmentation = segmentLorebook(text);
    const built = buildKeyStore(segmentation.entries);
    stores.push(built.store);
    totalAuthored += built.authored;
    collisions.push(...built.collisions);
    console.log(JSON.stringify({
        file,
        entries: segmentation.entries.length,
        authoredSheets: built.authored,
        keys: Object.values(built.store).reduce((sum, keys) => sum + keys.length, 0),
        collisions: built.collisions.length,
    }));
}

const merged = mergeStores(...stores);
fs.writeFileSync(outPath, JSON.stringify(merged, null, 1));
const names = Object.keys(merged);
const keys = Object.values(merged).reduce((sum, list) => sum + list.length, 0);
console.log(JSON.stringify({ out: outPath, names: names.length, keys, authoredSheets: totalAuthored }));
if (collisions.length) {
    const sample = collisions.slice(0, 5).map((entry) => entry.key + ' -> ' + entry.titles.join(' vs '));
    console.log('collisions (a key two entries would both claim): ' + sample.join('; '));
}