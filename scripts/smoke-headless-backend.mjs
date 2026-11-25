#!/usr/bin/env node
/**
 * Smoke test for the headless vault backend — against the local dev server, so
 * it costs the site nothing.
 *
 * It runs the *production* backend (`ChromeBackend` with `headless: true`), not a
 * copy of its logic, and checks the three things the design depends on:
 *
 *   1. the identity is taken from a real Chrome on this machine and applied;
 *   2. no OS window exists for the browser it started;
 *   3. the measured identity is cached for the next run.
 *
 * Usage: node scripts/smoke-headless-backend.mjs [--keep]
 * Requires the dev server on http://127.0.0.1:8000.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromeBackend } from '../src/endpoints/weavers-vault-chrome-backend.js';
import { IDENTITY_FILE } from '../src/endpoints/weavers-vault-headless-identity.js';

const ORIGIN = 'http://127.0.0.1:8000/';
const HOST = '127.0.0.1';
const keep = process.argv.includes('--keep');
// `--headful` runs the other mode, as a regression check that the window path
// still works after a change to the shared start sequence.
const headless = !process.argv.includes('--headful');

/**
 * The Chrome processes that were started on this profile, and which of them own
 * an OS window. A headless browser leaves `MainWindowHandle` at 0 for every
 * process, so a non-zero handle here is a window a user could see.
 */
function profileWindows(profileDir) {
    const name = path.basename(profileDir);
    const script = [
        `$pids = (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${name}*' }).ProcessId`
        , 'if (-not $pids) { "0"; exit }'
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

/** The identity the page claims, read the way a site would. */
const IDENTITY_READ = `(async () => ({
    ua: navigator.userAgent,
    brands: (navigator.userAgentData?.brands ?? []).map(b => b.brand + '/' + b.version),
    platform: navigator.userAgentData?.platform ?? '',
    screen: [screen.width, screen.height],
    viewport: [innerWidth, innerHeight],
    outer: [outerWidth, outerHeight],
    dpr: devicePixelRatio,
}))()`;

async function main() {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-headless-smoke-'));
    const logger = {
        info: () => {},
        warn: (...args) => process.stderr.write(`warn: ${args.join(' ')}\n`),
    };
    const backend = new ChromeBackend({ profileDir, host: HOST, origin: ORIGIN, headless, logger });
    const result = { mode: headless ? 'headless' : 'headful', profileDir };
    try {
        // The first run pays for the measuring launch as well as the headless one.
        const startedAt = Date.now();
        await backend.start();
        result.startMs = Date.now() - startedAt;
        result.identity = await backend.page.evaluate(IDENTITY_READ, { awaitPromise: true, timeoutMs: 15_000 });
        result.localFetch = await backend.page.evaluate('fetch("/").then(r => r.status)', { awaitPromise: true, timeoutMs: 15_000 });
        result.windows = profileWindows(profileDir);
        const cachePath = path.join(profileDir, IDENTITY_FILE);
        result.cache = fs.existsSync(cachePath)
            ? { written: true, major: JSON.parse(fs.readFileSync(cachePath, 'utf8')).major }
            : { written: false, major: null };
    } finally {
        await backend.dispose();
    }
    result.verdict = {
        saysHeadless: /Headless/i.test(String(result.identity?.ua ?? '')),
        brands: result.identity?.brands?.length ?? 0,
        screen: (result.identity?.screen ?? []).join('x'),
        viewport: (result.identity?.viewport ?? []).join('x'),
        osWindows: result.windows?.withWindow ?? -1,
        // In headful mode the parked window exists but must be off screen; this
        // is the count the headless mode has to beat, not match.
        processes: result.windows?.processes ?? -1,
        cacheWritten: result.cache?.written === true,
        localFetch: result.localFetch,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!keep) {
        // Chrome can still hold a handle in its cache directories for a moment
        // after the process is gone (measured: EPERM right after dispose).
        try {
            fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch (error) {
            process.stderr.write(`could not remove ${profileDir}: ${error.message}\n`);
        }
    }
}

void main();
