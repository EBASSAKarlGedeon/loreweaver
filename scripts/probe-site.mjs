#!/usr/bin/env node
/**
 * Step 2, probe 2: does the headless variant clear Cloudflare on the real site,
 * and does the headful one still? **This one talks to janitorai.com.**
 *
 * Per trial: a brand-new profile (cold, no `cf_clearance`), one navigation to
 * the site, one in-page `fetch()` of the same URL, then the browser is killed and
 * the profile deleted. Variants alternate so neither gets a warm machine:
 *
 *   A  today's production launch (headful, offscreen)
 *   B  the same, plus `--headless=new` and the override probe 1 built
 *
 * Recorded per trial: navigation status, `cf-mitigated`, the challenge markers in
 * the page (`_cf_chl_opt`, `#challenge-form`, title), how long it took to reach a
 * normal page, whether `cf_clearance` appeared, and the in-page fetch's answer.
 *
 * Usage:
 *   node scripts/probe-site.mjs                 # 5 trials per variant, 6 s apart
 *   node scripts/probe-site.mjs --trials=3
 *   node scripts/probe-site.mjs --gap=10000
 *   node scripts/probe-site.mjs --json          # full JSON on stdout as well
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { findBrowserBinary } from '../src/endpoints/weavers-vault-chrome-backend.js';
import { buildOverride, deviceMetrics } from './probe-headless.mjs';

const SITE = 'https://janitorai.com/';
const START_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

/** Today's production flags, both variants; `about:blank` so the probe navigates. */
function browserArgs(profileDir, headless) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--test-type',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
    '--disable-hang-monitor',
    '--no-service-autorun',
    '--hide-crash-restore-bubble',
    '--window-position=-32000,-32000',
    '--window-size=1280,900',
    'about:blank',
  ];
  if (headless) args.splice(args.length - 1, 0, '--headless=new');
  return args;
}

/** Minimal CDP client with event subscriptions. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  send(method, params = {}, timeoutMs = 20_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

async function readPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the browser exited with code ${child.exitCode}`);
    try {
      const [raw] = String(fs.readFileSync(file, 'utf8')).split('\n');
      const port = Number(raw);
      if (port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no debugging port within ${START_TIMEOUT_MS} ms`);
}

function stop(child) {
  if (child.exitCode !== null) return new Promise(resolve => setTimeout(resolve, 800));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    child.once('exit', () => { clearTimeout(timer); setTimeout(resolve, 800); });
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch { /* gone */ } });
  });
}

async function launch({ binary, profileDir, headless }) {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const child = spawn(binary, browserArgs(profileDir, headless), { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await readPort(profileDir, child);
  let targets = [];
  for (let i = 0; i < 60; i += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    targets = list.filter(t => t.type === 'page');
    if (targets.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!targets.length) throw new Error(`no page target on port ${port}`);
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const cdp = new Cdp(socket);
  const version = await cdp.send('Browser.getVersion');
  return { child, port, cdp, version };
}

/** What the page itself reports once it has settled. */
const SNAPSHOT_EXPRESSION = `(() => {
  const text = document.body ? document.body.innerText : "";
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    bodyLength: text.length,
    challengeForm: Boolean(document.querySelector(\'#challenge-form, #cf-challenge-running, .cf-browser-verification\')),
    chlOpt: typeof window._cf_chl_opt !== "undefined",
    turnstile: Boolean(document.querySelector(\'.cf-turnstile, iframe[src*="challenges.cloudflare.com"]\')),
    challengeText: /just a moment|checking your browser|verify you are human|enable javascript and cookies/i.test(text + " " + document.title),
    cookie: document.cookie,
  };
})()`;

/** One in-page fetch of the same URL: the request the vault actually makes. */
const FETCH_EXPRESSION = `(async () => {
  const started = performance.now();
  try {
    const response = await fetch(location.href, { cache: "no-store", credentials: "include", redirect: "follow" });
    const body = await response.text();
    return {
      status: response.status,
      redirected: response.redirected,
      url: response.url,
      cfMitigated: response.headers.get("cf-mitigated"),
      contentType: response.headers.get("content-type"),
      bytes: body.length,
      challengeText: /just a moment|checking your browser|verify you are human|enable javascript and cookies/i.test(body.slice(0, 20000)),
      chlOpt: body.includes("_cf_chl_opt"),
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { error: String(error), ms: Math.round(performance.now() - started) };
  }
})()`;

/** What the headful trial proves about itself, so B can claim the same things. */
const REFERENCE_EXPRESSION = `(async () => {
  const cm = navigator.userAgentData;
  let hev = null;
  try {
    hev = cm ? await cm.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'wow64']) : null;
  } catch { hev = null; }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    uaData: cm ? { brands: cm.brands, mobile: cm.mobile, platform: cm.platform } : null,
    uaDataHighEntropy: hev,
    screen: { width: screen.width, height: screen.height },
    window: {
      innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio,
    },
  };
})()`;
async function evaluate(cdp, expression, timeoutMs = 30_000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  }, timeoutMs + 5_000);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

/** Wait until the page stops being a challenge page, or the budget runs out. */
async function waitForChallengeToClear(cdp, startedAt) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, SNAPSHOT_EXPRESSION, 5_000);
    } catch { /* mid-navigation */ }
    const challenged = last && (last.chlOpt || last.challengeForm || last.challengeText);
    if (last && last.readyState === 'complete' && !challenged) {
      return { snapshot: last, ms: Date.now() - startedAt, cleared: true };
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { snapshot: last, ms: Date.now() - startedAt, cleared: false };
}

async function runTrial({ binary, variant, reference, index, root, site }) {
  const headless = variant === 'B';
  const profileDir = path.join(root, `trial-${index}-${variant}`);
  const trial = { index, variant, headless, startedAt: new Date().toISOString() };
  const { child, cdp, version } = await launch({ binary, profileDir, headless });
  try {
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    trial.version = version.product;
    if (headless) {
      if (!reference) throw new Error('no headful reference captured yet');
      await cdp.send('Emulation.setDeviceMetricsOverride', deviceMetrics(reference));
      await cdp.send('Emulation.setUserAgentOverride', buildOverride(reference, version, {}));
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: -32000,
          top: -32000,
          width: reference.window.outerWidth,
          height: reference.window.outerHeight,
          windowState: 'normal',
        },
      });
    }

    const requests = [];
    cdp.on('Network.requestWillBeSent', (event) => { requests.push(event.request.url); });
    let navigation = null;
    cdp.on('Network.responseReceived', (event) => {
      if (event.type === 'Document' && !navigation) {
        navigation = {
          status: event.response.status,
          url: event.response.url,
          cfMitigated: event.response.headers?.['cf-mitigated'] ?? event.response.headers?.['CF-Mitigated'] ?? null,
          cfRay: event.response.headers?.['cf-ray'] ?? event.response.headers?.['CF-Ray'] ?? null,
          server: event.response.headers?.server ?? null,
        };
      }
    });

    const started = Date.now();
    await cdp.send('Page.navigate', { url: site }, 40_000);
    const cleared = await waitForChallengeToClear(cdp, started);
    trial.navigation = navigation;
    trial.reference = await evaluate(cdp, REFERENCE_EXPRESSION, 20_000).catch(() => null);
    trial.firstPaintMs = cleared.ms;
    trial.cleared = cleared.cleared;
    trial.snapshot = cleared.snapshot;

    const report = await evaluate(cdp, SNAPSHOT_EXPRESSION);
    trial.snapshotAfterSettle = report;
    trial.fetch = await evaluate(cdp, FETCH_EXPRESSION, 40_000);

    const cookies = await cdp.send('Network.getCookies', { urls: [site] });
    trial.cookies = (cookies.cookies ?? []).map(({ name, domain, secure, httpOnly, sameSite }) => ({
      name, domain, secure, httpOnly, sameSite,
    }));
    trial.cfClearance = trial.cookies.some(cookie => cookie.name === 'cf_clearance');
    trial.requestCount = requests.length;
    trial.requests = requests.slice(0, 5);
    trial.result = trial.cleared && trial.fetch && !trial.fetch.challengeText && !trial.fetch.chlOpt && trial.fetch.status === 200
      ? 'passed'
      : 'challenged';
  } catch (error) {
    trial.error = String(error?.stack ?? error);
    trial.result = 'error';
  } finally {
    cdp.close();
    await stop(child);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      trial.cleanup = `could not remove ${profileDir}: ${error.message}`;
    }
    trial.finishedAt = Date.now();
  }
  return trial;
}

async function main() {
  const argv = process.argv.slice(2);
  const trials = Number((argv.find(a => a.startsWith('--trials=')) ?? '--trials=5').split('=')[1]);
  const gap = Number((argv.find(a => a.startsWith('--gap=')) ?? '--gap=6000').split('=')[1]);
  const asJson = argv.includes('--json');
  const site = (argv.find(a => a.startsWith('--site=')) ?? '').slice(7) || SITE;
  const binary = findBrowserBinary();
  if (!binary) { console.error('no Chrome/Edge binary found'); process.exit(2); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-site-probe-'));
  const results = [];
  let reference = null;
  let aPassed = false;
  let stopEarly = false;
  const log = (line) => { console.log(line); };
  log(`site probe: ${site}`);
  log(`trials per variant: ${trials}, gap ${gap} ms, fresh profile each, profiles in ${root}`);

  try {
    for (let index = 1; index <= trials; index += 1) {
      // Alternate which variant goes first, so neither always runs on a warmer machine.
      const order = index % 2 === 1 ? ['A', 'B'] : ['B', 'A'];
      for (const variant of order) {
        const trial = await runTrial({ binary, variant, reference, index, root, site });
        results.push(trial);
        if (variant === 'A' && trial.reference) reference = trial.reference;
        log([
          `#${String(trial.index).padStart(2)} ${variant}` + (trial.headless ? ' (headless)' : ' (headful) '),
          `nav=${trial.navigation?.status ?? '-'}` + (trial.navigation?.cfMitigated ? ` cf-mitigated=${trial.navigation.cfMitigated}` : ''),
          `cleared=${trial.cleared}` + (trial.firstPaintMs ? ` in ${trial.firstPaintMs} ms` : ''),
          `fetch=${trial.fetch?.status ?? trial.fetch?.error ?? '-'}` + (trial.fetch?.cfMitigated ? ` cf-mitigated=${trial.fetch.cfMitigated}` : ''),
          `cf_clearance=${trial.cfClearance}` + (trial.requestCount ? ` requests=${trial.requestCount}` : ''),
          `=> ${trial.result}` + (trial.error ? ` (${String(trial.error).split('\n')[0]})` : ''),
        ].join('  '));
        if (trial.error) break;
        if (variant === 'A' && trial.result === 'passed') aPassed = true;
        // The plan's failure rule: a challenge on B where A passes ends the run.
        if (variant === 'B' && aPassed && trial.result !== 'passed') {
          log('early stop: headless was challenged while headful passed');
          stopEarly = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, gap));
      }
      if (stopEarly || results.some(trial => trial.result === 'error')) break;
    }

    const byVariant = (variant) => results.filter(trial => trial.variant === variant);
    const score = (variant) => byVariant(variant).filter(trial => trial.result === 'passed').length;
    const total = (variant) => byVariant(variant).length;
    const verdict = score('B') === total('B') && total('B') > 0 && score('A') > 0;

    log('');
    log(`A (headful):  ${score('A')}/${total('A')} passed`);
    log(`B (headless): ${score('B')}/${total('B')} passed`);
    log(verdict ? 'PASS: headless clears the site as well as headful' : 'FAIL: headless does not match headful');

    const out = path.join(os.tmpdir(), 'vault-site-probe.json');
    fs.writeFileSync(out, JSON.stringify({ site, verdict, results }, null, 2));
    log(`details: ${out}`);
    if (asJson) console.log(JSON.stringify({ verdict, results }, null, 2));
    process.exitCode = verdict ? 0 : 1;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`could not remove ${root}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
