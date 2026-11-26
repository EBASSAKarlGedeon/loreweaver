#!/usr/bin/env node
// Render a review page for a capture: entries, flags and split candidates.
//
//   node tools/review-lorebook.mjs <capture.txt> <review.html>
//
// Open the page, fix the titles, tick the splits, download decisions.json and pass
// it as the fourth argument to rebuild-lorebook.mjs.
import fs from 'node:fs';
import { segmentLorebook } from '../public/scripts/extensions/weavers-vault/lorebook-segment.js';

const [capturePath, outPath] = process.argv.slice(2);
if (!capturePath || !outPath) {
    console.error('usage: node tools/review-lorebook.mjs <capture.txt> <review.html>');
    process.exit(2);
}

const text = fs.readFileSync(capturePath, 'utf8');
const segmentation = segmentLorebook(text);
const entries = segmentation.entries.map((entry, index) => ({
    i: index,
    title: entry.title,
    role: entry.role,
    rule: entry.rule,
    len: entry.content.length,
    flags: entry.flags,
    preview: entry.content.slice(0, 260),
    candidates: entry.candidates.map((candidate, k) => ({
        k,
        line: candidate.line,
        kind: candidate.kind || "paragraph",
        text: candidate.text,
    })),
}));
const payload = JSON.stringify({ entries, stats: segmentation.stats }).replace(/</g, "\\u003c");
const PAGE = `
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Review lorebook</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:24px;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 4px}.sub{color:#666;margin-bottom:12px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border-bottom:1px solid #eee;padding:8px;vertical-align:top;text-align:left}
th{position:sticky;top:0;background:#fff;z-index:1;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#666}
input.title{width:100%;font:inherit;padding:4px 6px;border:1px solid #ddd;border-radius:4px}
.meta{color:#777;font-size:12px;white-space:nowrap}
.flag{display:inline-block;background:#fff3cd;border:1px solid #f0d58c;border-radius:3px;padding:0 5px;margin:1px;font-size:11px}
.cand label{display:block;font-size:12px;margin:2px 0;cursor:pointer}
details{margin-top:4px}summary{cursor:pointer;color:#666;font-size:12px;white-space:pre-wrap}
.dup input.title{border-color:#c0392b;background:#fdecea}
#bar{position:sticky;top:0;background:#fafafa;padding:8px 0 12px;display:flex;gap:12px;align-items:center}
button{font:inherit;padding:6px 12px;border-radius:4px;border:1px solid #ccc;background:#fff;cursor:pointer}
button.primary{background:#2c6e49;color:#fff;border-color:#2c6e49}
</style></head><body>
<h1>Review the capture</h1><div class="sub" id="sub"></div>
<div id="bar"><button class="primary" id="save">Download decisions.json</button><span id="count"></span></div>
<table><thead><tr><th style="width:280px">Title</th><th>Entry</th><th>Flags</th><th>Candidates</th><th style="width:90px">Merge up</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
var DATA = __DATA__;
var rows = document.getElementById('rows');
var seen = {};
DATA.entries.forEach(function (e) { var k = (e.title || '').toLowerCase(); if (!k) { e.flags = e.flags.concat(['empty-title']); } else if (seen[k]) { e.flags = e.flags.concat(['duplicate-title']); } else { seen[k] = 1; } });
document.getElementById('sub').textContent = DATA.stats.entries + ' entries, ' + DATA.stats.chars + ' characters, ' + DATA.entries.filter(function (e) { return e.candidates.length; }).length + ' entries with candidates';
DATA.entries.forEach(function (e) {
  var tr = document.createElement('tr');
  if (e.flags.indexOf('duplicate-title') >= 0) tr.className = 'dup';
  var td1 = document.createElement('td');
  var input = document.createElement('input');
  input.className = 'title'; input.value = e.title; input.dataset.i = e.i;
  td1.appendChild(input);
  tr.appendChild(td1);
  var td2 = document.createElement('td');
  td2.className = 'meta';
  td2.textContent = e.role + ' / ' + e.rule + ' / ' + e.len + ' chars';
  var det = document.createElement('details');
  var sum = document.createElement('summary'); sum.textContent = 'preview';
  det.appendChild(sum);
  var pre = document.createElement('div'); pre.textContent = e.preview; pre.style.whiteSpace = 'pre-wrap';
  det.appendChild(pre);
  td2.appendChild(det);
  tr.appendChild(td2);
  var td3 = document.createElement('td');
  e.flags.forEach(function (f) { var s = document.createElement('span'); s.className = 'flag'; s.textContent = f; td3.appendChild(s); });
  tr.appendChild(td3);
  var td4 = document.createElement('td'); td4.className = 'cand';
  e.candidates.forEach(function (c) {
    var label = document.createElement('label');
    var box = document.createElement('input'); box.type = 'checkbox'; box.dataset.entry = e.i; box.dataset.cand = c.k;
    label.appendChild(box);
    label.appendChild(document.createTextNode(' split before line ' + c.line + ' (' + c.kind + '): ' + c.text));
    td4.appendChild(label);
  });
  tr.appendChild(td4);
  var td5 = document.createElement('td');
  if (e.i > 0) { var m = document.createElement('input'); m.type = 'checkbox'; m.dataset.merge = e.i; m.title = 'merge into the entry above'; td5.appendChild(m); }
  tr.appendChild(td5);
  rows.appendChild(tr);
});
document.getElementById('save').onclick = function () {
  var decisions = { renames: {}, splits: [], merges: [] };
  document.querySelectorAll('input.title').forEach(function (input) {
    var i = Number(input.dataset.i);
    if (input.value.trim() !== DATA.entries[i].title) decisions.renames[i] = input.value.trim();
  });
  document.querySelectorAll('input[data-cand]').forEach(function (box) {
    if (box.checked) decisions.splits.push({ entry: Number(box.dataset.entry), candidate: Number(box.dataset.cand) });
  });
  document.querySelectorAll('input[data-merge]').forEach(function (box) {
    if (box.checked) decisions.merges.push(Number(box.dataset.merge));
  });
  var blob = new Blob([JSON.stringify(decisions, null, 1)], { type: 'application/json' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'decisions.json'; a.click();
};
</script></body></html>
`;
fs.writeFileSync(outPath, PAGE.replace("__DATA__", payload));
console.log(JSON.stringify({ html: outPath, entries: entries.length, candidates: entries.reduce((sum, entry) => sum + entry.candidates.length, 0) }));