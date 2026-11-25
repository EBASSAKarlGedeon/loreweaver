#!/usr/bin/env node
/**
 * Diff the request headers Chrome puts on the wire in headful and headless mode.
 *
 * The block the site serves is decided before any page script runs (a static 200
 * page), so what is left to compare is the request itself — and page JavaScript
 * cannot see its own headers. A local server can: it prints exactly what arrived,
 * in order.
 *
 * Local only. Costs the site nothing.
 * Usage: node scripts/probe-request-headers.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ChromeBackend } from '../src/endpoints/weavers-vault-chrome-backend.js';

const PAGE = '<!doctype html><title>Probe</title><h1>probe</h1>';

async function listen() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ path: req.url, headers: req.rawHeaders });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return { server, seen, port };
}

/** Header pairs as a map, keeping the order they were sent in. */
function asMap(raw) {
    const out = [];
    for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
    return out;
}

async function readMode(mode, headful, port) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `loreweaver-hdr-${mode}-`));
    const logger = { info: () => {}, warn: () => {} };
    const backend = new ChromeBackend({
        profileDir,
        host: '127.0.0.1',
        origin: `http://127.0.0.1:${port}/`,
        label: mode,
        headless: !headful,
        logger,
    });
    try {
        await backend.start();
        // A subresource, so the "Sec-Fetch-*" and client-hint headers of a fetch
        // can be compared too, not just the document navigation.
        await backend.page.evaluate(`fetch("/second").then(r => r.status)`, { awaitPromise: true, timeoutMs: 15_000 });
    } finally {
        try { await backend.dispose(); } catch { /* already gone */ }
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
    }
}

async function main() {
    const { server, seen, port } = await listen();
    try {
        await readMode('headful', true, port);
        const headful = seen.splice(0, seen.length);
        await readMode('headless', false, port);
        // The traffic of the previous mode is cleared above; what is left is headless.
        const headless = seen.splice(0, seen.length);
        const pick = (list, suffix) => list.find(entry => entry.path.endsWith(suffix.length ? suffix : '')) ?? null;
        const compare = (url) => {
            const a = pick(headful, url)?.headers ?? [];
            const b = pick(headless, url)?.headers ?? [];
            const toMap = pairs => new Map(pairs.map(([k, v]) => [k.toLowerCase(), v]));
            const ma = toMap(asMap(a));
            const mb = toMap(asMap(b));
            const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
            return keys.map(key => ({ key, headful: ma.get(key) ?? '(absent)', headless: mb.get(key) ?? '(absent)' }));
        };
        const out = { document: compare('/'), fetch: compare('/second') };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } finally {
        server.close();
    }
}

void main();
