#!/usr/bin/env node
// Rebuild a World Info book from a captured Janitor lorebook prompt.
//
//   node tools/rebuild-lorebook.mjs <capture.txt> <out.json> [keys.json]
//
// keys.json is an optional map of { "normalised title": ["key", ...] } taken from
// the author's entry list. Prints the report; exits 1 when a gate fails.
import fs from 'node:fs';
import path from 'node:path';
import { buildLorebook } from '../public/scripts/extensions/weavers-vault/lorebook-build.js';

const [capturePath, outPath, keysPath, decisionsPath] = process.argv.slice(2);
if (!capturePath || !outPath) {
    console.error('usage: node tools/rebuild-lorebook.mjs <capture.txt> <out.json> [keys.json] [decisions.json]');
    process.exit(2);
}

const text = fs.readFileSync(capturePath, 'utf8');
// "-" keeps a positional slot empty (PowerShell drops an empty argument).
const readJson = (value) => (value && value !== '-' ? JSON.parse(fs.readFileSync(value, 'utf8')) : null);
const authorKeys = readJson(keysPath);
const decisions = readJson(decisionsPath) || {};
const { book, report } = buildLorebook({ text, authorKeys, decisions });

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(book, null, 1));

const { summary, failures, warnings, segmentation } = report;
console.log(JSON.stringify({
    entries: summary.entries,
    chars: summary.chars,
    keys: summary.keys,
    sheets: summary.sheets,
    containers: summary.containers,
    topics: summary.topics,
    captured: segmentation.stats.chars,
    flags: segmentation.flags.length,
    reviewed: report.review.applied.length,
    fingerprint: report.provenance.source.fingerprint,
    ok: report.ok,
}, null, 1));

for (const failure of failures) console.error('FAIL ' + failure.gate + '/' + failure.code + ': ' + failure.message);
for (const warning of warnings) console.log('warn ' + warning.gate + '/' + warning.code + ': ' + warning.message);
for (const flag of segmentation.flags) console.log('flag ' + flag.code + ': ' + flag.message);
process.exit(report.ok ? 0 : 1);