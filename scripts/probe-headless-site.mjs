#!/usr/bin/env node
/**
 * The one measurement the design needs from the site: does the vault's signed-in
 * profile answer 200 in a headless browser whose identity was applied?
 *
 * Costs a page load. Run it only when the user has said yes, and once: the point
 * is a single reading, not a loop. It never writes anything to the account and it
 * logs cookie *names*, never values (PITFALLS #42, probe rule).
 *
 * Usage: node scripts/probe-headless-site.mjs [--profile <dir>] [--headful]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromeBackend } from '../src/endpoints/weavers-vault-chrome-backend.js';

const DATA = 'C:/Users/Gedeon/Documents/Coding/Loreweaver/data';
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const profileDir = arg('--profile', path.join(DATA, '_vault-janitor-profile'));
const headless = !args.includes('--headful');

/** What the page is, without dumping it. */
const PAGE_READ = `(() => ({
    title: document.title,
    url: location.href,
    ready: document.readyState,
    signedIn: !!document.querySelector('a[href*="/profile"], [data-testid="user-menu"]') || /log ?out/i.test(document.body.innerText || ''),
    blocked: /Access Restricted|blocked by our firewall/i.test(document.body.innerText || ''),
    text: (document.body.innerText || "").slice(0, 160).replace(/\s+/g, " "),
    cookieNames: document.cookie.split(";").map(c => c.split("=")[0].trim()).filter(Boolean),
}))()`;

async function main() {
    if (!fs.existsSync(path.join(profileDir, 'Default', 'Network', 'Cookies'))) {
        throw new Error(`No signed-in profile at ${profileDir}`);
    }
    const logger = { info: (...a) => process.stderr.write(`${a.join(' ')}\n`), warn: (...a) => process.stderr.write(`warn: ${a.join(' ')}\n`) };
    const backend = new ChromeBackend({
        profileDir,
        host: 'janitorai.com',
        origin: 'https://janitorai.com/',
        label: 'Probe',
        headless,
        logger,
    });
    const result = { mode: headless ? 'headless' : 'headful', profileDir, phases: {} };
    try {
        const t0 = Date.now();
        await backend.start();
        result.phases.startMs = Date.now() - t0;
        // One same-origin fetch: the exact call the vault makes for every request.
        const t1 = Date.now();
        result.fetch = await backend.page.evaluate(`fetch("/").then(async r => ({
            status: r.status,
            mitigated: r.headers.get("cf-mitigated"),
            bytes: (await r.text()).length,
        }))`, { awaitPromise: true, timeoutMs: 30_000 });
        result.phases.fetchMs = Date.now() - t1;
        result.page = await backend.page.evaluate(PAGE_READ, { awaitPromise: false, timeoutMs: 15_000 });
        result.identity = await backend.page.evaluate(`(() => ({
            ua: navigator.userAgent.slice(0, 90),
            brands: (navigator.userAgentData?.brands ?? []).map(b => b.brand + '/' + b.version),
        }))()`, { awaitPromise: false, timeoutMs: 10_000 });
        result.cachedIdentity = fs.existsSync(path.join(profileDir, 'headless-identity.json'));
        // If it blocked, keep the page: analysing a saved copy costs no requests.
        if (result.page?.blocked === true) {
            const html = await backend.page.evaluate('document.documentElement.outerHTML', { awaitPromise: false, timeoutMs: 20_000 });
            const target = path.join(os.tmpdir(), 'headless-block.html');
            fs.writeFileSync(target, String(html ?? ''), 'utf8');
            result.blockPage = { saved: target, bytes: String(html ?? '').length };
        }
        result.verdict = {
            document: result.page?.title,
            signedIn: result.page?.signedIn === true,
            fetchStatus: result.fetch?.status,
            mitigated: result.fetch?.mitigated ?? null,
            bytes: result.fetch?.bytes ?? 0,
            saysHeadless: /Headless/i.test(String(result.identity?.ua ?? '')),
            cookieNames: (result.page?.cookieNames ?? []).join(','),
        };
    } finally {
        await backend.dispose();
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
