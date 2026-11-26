#!/usr/bin/env node
// Install a built book as a Loreweaver/SillyTavern world info file and prove it reads back.
//
//   node tools/install-lorebook.mjs <book.json> <worlds-dir>/<Name>.json
//
// Entries from lorebook-build carry only the fields the builder decides; the rest are the
// World Info defaults, so a book is installable without going through a card.
import fs from 'node:fs';
import path from 'node:path';

const [bookPath, outPath] = process.argv.slice(2);
if (!bookPath || !outPath) {
    console.error('usage: node tools/install-lorebook.mjs <book.json> <worlds-dir>/<Name>.json');
    process.exit(2);
}

const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
const entries = Object.values(book.entries || {});

const base = {
    keysecondary: [], constant: false, selective: true, selectiveLogic: 0, addMemo: true,
    ignoreBudget: false, matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false,
    matchCreatorNotes: false, triggers: [], outletName: '', probability: 100, useProbability: true,
    group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, vectorized: false,
    sticky: 0, cooldown: 0, delay: 0, excludeRecursion: false, preventRecursion: false,
    delayUntilRecursion: false, extensions: {},
};

const out = {};
entries.forEach((entry, index) => {
    out[String(index)] = {
        ...base,
        ...entry,
        uid: index,
        key: Array.isArray(entry.key) ? entry.key : [],
        comment: entry.comment || '',
        content: entry.content || '',
        order: entry.order ?? 100 - index,
        position: entry.position ?? 4,
        depth: entry.depth ?? 10,
        disable: false,
    };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ entries: out, ...(book.extensions ? { extensions: book.extensions } : {}) }));

// Read it back the way the app will, then check it against its own stamp.
const read = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const back = Object.values(read.entries);
const chars = back.reduce((sum, entry) => sum + entry.content.length, 0);
const keys = back.reduce((sum, entry) => sum + entry.key.length, 0);
const stamp = (read.extensions && read.extensions.vault) || book.extensions?.vault;
const problems = [];
if (back.length !== entries.length) problems.push('entry count changed on disk');
if (back.some((entry) => !entry.content || !Array.isArray(entry.key) || !entry.key.length)) problems.push('an entry lost its content or keys');
if (!stamp || !stamp.source || !stamp.source.fingerprint) problems.push('stamp missing');
if (stamp && stamp.result && stamp.result.entries !== back.length) problems.push('stamp disagrees with the entry count');
console.log(JSON.stringify({ world: outPath, entries: back.length, chars, keys, stamp: stamp ? stamp.source.fingerprint : null, problems }));
if (problems.length) process.exit(1);