#!/usr/bin/env node
/**
 * The vault's own read, headless: does the account endpoint still answer?
 *
 * `readJanitorAccount()` is the production path — start the janitor browser from
 * the shared vault session, read the Supabase token out of the page's cookies,
 * fetch `/hampter/profiles/mine` with it, and parse the identity. Headless has to
 * survive all of it, not just the home page.
 *
 * Costs ONE page load plus one API request on the real site: run it only with a
 * go-ahead, and once.
 * Usage: node scripts/probe-headless-account.mjs [--profile <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getJanitorBrowser, readJanitorAccount } from '../src/endpoints/weavers-vault-janitor-browser.js';

const DATA = 'C:/Users/Gedeon/Documents/Coding/Loreweaver/data';
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const profileDir = arg('--profile', path.join(DATA, '_vault-janitor-profile'));

function windowCount(dir) {
    const name = path.basename(dir);
    const script = [
        `$pids = (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${name}*' }).ProcessId`
        , 'if (-not $pids) { "0 0"; exit }'
        , '$w = @(Get-Process -Id $pids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })'
        , '"$(@($pids).Count) $($w.Count)"'
    ].join('\n');
    const done = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    const [processes, withWindow] = String(done.stdout ?? '0 0').trim().split(/\s+/).map(Number);
    return { processes, withWindow };
}

const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

async function main() {
    if (!fs.existsSync(path.join(profileDir, 'Default', 'Network', 'Cookies'))) {
        throw new Error(`No signed-in profile at ${profileDir}`);
    }
    const browser = getJanitorBrowser({ profileDir, logger: { info: log, warn: log } });
    const result = { profileDir, headless: browser.headless };
    try {
        const t0 = Date.now();
        await browser.ensureStarted();
        result.startMs = Date.now() - t0;
        const t1 = Date.now();
        result.account = await readJanitorAccount(browser);
        result.accountMs = Date.now() - t1;
        result.page = await browser.evaluateInPage(`(() => ({
            title: document.title,
            url: location.href,
            ua: navigator.userAgent.slice(0, 60),
            saysHeadless: /Headless/i.test(navigator.userAgent),
        }))()`, { timeoutMs: 10_000 });
        result.windows = windowCount(profileDir);
    } finally {
        try { await browser.dispose(); } catch { /* already gone */ }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
