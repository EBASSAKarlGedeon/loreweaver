#!/usr/bin/env node
/**
 * Exercise the one thing headless cannot do itself: hand the profile to a human.
 *
 * Runs the production backend headless on a local origin (so it costs the site
 * nothing), then calls `reveal()`, which closes the headless browser, opens a
 * plain window on the same profile, waits for that window to be closed, and brings
 * the headless session back. The window is the point — close it when it appears.
 *
 * Usage: node scripts/probe-escalation.mjs [--origin http://127.0.0.1:8000] [--timeout 300000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ChromeBackend } from '../src/endpoints/weavers-vault-chrome-backend.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:8000');
const TIMEOUT = Number(arg('--timeout', 300_000));
const HOST = new URL(ORIGIN).hostname;

/** Chrome processes on this profile, and how many own an OS window. */
function profileWindows(profileDir) {
    const name = path.basename(profileDir);
    const script = [
        `$pids = (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${name}*' }).ProcessId`
        , 'if (-not $pids) { "0 0"; exit }'
        , '$withWindow = @(Get-Process -Id $pids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })'
        , '"$(@($pids).Count) $($withWindow.Count)"'
        , '$withWindow | ForEach-Object { "window: $($_.Id) $($_.MainWindowTitle)" }'
    ].join('\n');
    const done = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    const lines = String(done.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
    const [counts = '0 0', ...windows] = lines;
    const [processes, withWindow] = counts.split(/\s+/).map(Number);
    return { processes, withWindow, windows };
}

const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

async function main() {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-escalation-'));
    const backend = new ChromeBackend({ profileDir, host: HOST, origin: ORIGIN, label: 'Probe', headless: true, logger: { info: () => {}, warn: log } });
    const result = { origin: ORIGIN, profileDir, phases: {} };
    try {
        const t0 = Date.now();
        await backend.start();
        result.phases.startMs = Date.now() - t0;
        result.before = { windows: profileWindows(profileDir), running: backend.isRunning() };
        result.before.fetch = await backend.page.evaluate('fetch("/").then(r => r.status)', { awaitPromise: true, timeoutMs: 20_000 });

        log('');
        log('--- a plain window is opening on the same profile now; CLOSE IT when you see it.');
        log(`    (it will be closed automatically after ${Math.round(TIMEOUT / 1000)} s)`);
        const t1 = Date.now();
        result.revealed = await backend.reveal({ timeoutMs: TIMEOUT });
        result.phases.humanMs = Date.now() - t1;

        result.after = { windows: profileWindows(profileDir), running: backend.isRunning() };
        result.after.title = await backend.page.evaluate('document.title', { awaitPromise: false, timeoutMs: 10_000 }).catch(() => null);
        result.after.fetch = await backend.page.evaluate('fetch("/").then(r => r.status)', { awaitPromise: true, timeoutMs: 20_000 }).catch(() => -1);
    } finally {
        try { await backend.dispose(); } catch { /* already gone */ }
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
