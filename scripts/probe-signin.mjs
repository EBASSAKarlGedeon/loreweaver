#!/usr/bin/env node
/**
 * Step 3, live test: the sign-in escape hatch, end to end, on the vault's real
 * profile.
 *
 *   0. a headful launch, parked offscreen on about:blank, is measured once for the
 *      identity a real Chrome reports (no site traffic);
 *   1. headless on the vault profile, with that identity, does one check of the
 *      site (one page load + one same-origin fetch);
 *   2. that browser is disposed and a PLAIN Chrome window is opened on the same
 *      profile (no automation flags, no debugging port, normal window) - the human
 *      signs in if needed and closes it;
 *   3. headless is relaunched on the profile and the same check is repeated.
 *
 * The profile is the vault's own, so the cookies (including cf_clearance and the
 * site session) are exactly what production sees. Nothing is deleted, and no
 * cookie value is ever written to the log: this file is plain text on disk.
 *
 * Usage: node scripts/probe-signin.mjs [--no-window] [--timeout=600000]
 *        node scripts/probe-signin.mjs --check=http://127.0.0.1:8000/csrf-token --no-window
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { findBrowserBinary } from '../src/endpoints/weavers-vault-chrome-backend.js';
import { buildOverride, deviceMetrics } from './probe-headless.mjs';

const PROFILE = 'C:/Users/Gedeon/Documents/Coding/Loreweaver/data/_vault-janitor-profile';
const CHECK_URL = 'https://janitorai.com/';

const LOG = path.join(os.tmpdir(), 'probe-signin.log');
fs.writeFileSync(LOG, '');
const log = (name, value = '') => {
  const line = `${new Date().toISOString()} ${name}${value === '' ? '' : ' ' + JSON.stringify(value)}`;
  fs.appendFileSync(LOG, `${line}\n`);
};

/** Production flags, parked offscreen; used only to read the real identity. */
function headfulArgs(profileDir) {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--test-type',
    '--window-position=-32000,-32000',
    '--window-size=1280,900',
    'about:blank',
  ];
}

/** Production flags minus the window placement, plus headless. */
function headlessArgs(profileDir) {
  return [
    '--headless=new',
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
    'about:blank',
  ];
}

/** A plain window for the human: no flags of ours beyond the profile. */
function plainArgs(profileDir, url) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message.id) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.socket.close(); } catch { /* closed */ } }
}

async function readPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the browser exited with code ${child.exitCode}`);
    try {
      const [raw] = String(fs.readFileSync(file, 'utf8')).split('\n');
      const port = Number(raw);
      if (port > 0) {
        const live = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false);
        if (live) return port;
      }
    } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('no debugging port');
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

/** Launch, wait for the port, attach to the page target. */
async function launch(binary, profileDir, args) {
  // A profile that has run before leaves a DevToolsActivePort behind; reading
  // that stale port attaches to nothing.
  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await readPort(profileDir, child);
  let targets = [];
  for (let i = 0; i < 60; i += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    targets = list.filter(t => t.type === 'page');
    if (targets.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!targets.length) throw new Error('no page target');
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const cdp = new Cdp(socket);
  const version = await cdp.send('Browser.getVersion');
  await cdp.send('Page.enable');
  return { child, cdp, version };
}

/** What this machine's real Chrome says about itself. */
const IDENTITY_EXPRESSION = `(async () => {
  const cm = navigator.userAgentData;
  let hev = null;
  try { hev = cm ? await cm.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'wow64']) : null; } catch {}
  return {
    userAgent: navigator.userAgent, platform: navigator.platform, languages: navigator.languages,
    uaData: cm ? { brands: cm.brands, mobile: cm.mobile, platform: cm.platform } : null,
    uaDataHighEntropy: hev,
    screen: { width: screen.width, height: screen.height },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio },
  };
})()`;

async function identity(cdp) {
  const result = await cdp.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, awaitPromise: true, returnByValue: true });
  return result.result.value ?? null;
}

/** The headless browser applies the headful identity, then reports what it now says. */
async function applyIdentity(cdp, reference) {
  const version = await cdp.send('Browser.getVersion');
  // A headless launch reports HeadlessChrome, and a UA that says so is what the
  // site's firewall blocks (403 "Access Restricted", not a challenge).
  const product = String(version.product).replace('HeadlessChrome', 'Chrome');
  if (reference) {
    await cdp.send('Emulation.setDeviceMetricsOverride', deviceMetrics(reference));
    // `buildOverride` reads the version off the object, so hand it the shape
    // `Browser.getVersion` returns rather than the bare string.
    await cdp.send('Emulation.setUserAgentOverride', buildOverride(reference, { ...version, product }, {}));
    // A parked window can report no outer size at all; setting 0x0 leaves the
    // headless default (800x600, smaller than the inner viewport). Fall back to
    // the headful measurements: inner + 1 px of frame, + 88 px of tab strip.
    const outer = {
      width: Math.max(reference.window.outerWidth, reference.window.innerWidth + 1),
      height: Math.max(reference.window.outerHeight, reference.window.innerHeight + 88),
    };
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: -32000,
        top: -32000,
        width: outer.width,
        height: outer.height,
        windowState: 'normal',
      },
    });
  }
  const now = await cdp
    .send('Runtime.evaluate', {
      expression: '({ userAgent: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + "/" + b.version) : null, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] })',
      returnByValue: true,
    })
    .then(result => result.result.value)
    .catch(() => null);
  return { product, now };
}

/** What the page and the network say about this browsing session. */
async function checkSite(cdp, url) {
  await cdp.send('Network.enable');
  const documents = [];
  cdp.on('Network.responseReceived', (event) => {
    if (event.type !== 'Document') return;
    documents.push({
      status: event.response.status,
      url: event.response.url,
      mitigated: event.response.headers?.['cf-mitigated'] ?? null,
      server: event.response.headers?.server ?? null,
    });
  });
  const started = Date.now();
  try {
    await cdp.send('Page.navigate', { url }, 40_000);
  } catch (error) {
    log('check.navigate.error', String(error.message ?? error));
  }
  await new Promise(resolve => setTimeout(resolve, 2500));

  // No cookie values anywhere in the log: a signed-in profile's cookie header is
  // an account session, and this file is plain text on disk.
  const snapshot = await cdp
    .send('Runtime.evaluate', {
      expression: `({ href: location.href, title: document.title, ready: document.readyState,
        bodyLength: document.body ? document.body.innerText.length : 0,
        chlOpt: typeof window._cf_chl_opt !== "undefined",
        challengeForm: Boolean(document.querySelector("#challenge-form, .cf-browser-verification")),
        bodyText: document.body ? document.body.innerText.slice(0, 160) : "",
        ua: navigator.userAgent,
        brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + '/' + b.version) : null,
        platform: navigator.platform, dpr: devicePixelRatio,
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
        screen: [screen.width, screen.height] })`,
      returnByValue: true,
    })
    .then(result => result.result.value)
    .catch(() => null);

  const fetched = await cdp
    .send('Runtime.evaluate', {
      expression: `(async () => {
        const started = performance.now();
        try {
          const response = await fetch(location.href, { cache: "no-store", credentials: "include" });
          const body = await response.text();
          return { status: response.status, mitigated: response.headers.get("cf-mitigated"),
            bytes: body.length, chlOpt: body.includes("_cf_chl_opt"),
            ms: Math.round(performance.now() - started) };
        } catch (error) { return { error: String(error) }; }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    .then(result => result.result.value)
    .catch(() => null);

  const cookies = await cdp.send('Network.getCookies', { urls: [url] }).catch(() => ({ cookies: [] }));
  return {
    ms: Date.now() - started,
    document: documents[0] ?? null,
    snapshot,
    fetched,
    cfClearance: (cookies.cookies ?? []).some(cookie => cookie.name === 'cf_clearance'),
    cookieNames: (cookies.cookies ?? []).map(cookie => cookie.name),
  };
}

function healthy(check) {
  return Boolean(
    check && check.document && check.document.status === 200
    && check.fetched && check.fetched.status === 200 && !check.fetched.mitigated && !check.fetched.chlOpt
    && check.snapshot && !check.snapshot.chlOpt && !check.snapshot.challengeForm,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const timeout = Number((argv.find(a => a.startsWith('--timeout=')) ?? '--timeout=600000').split('=')[1]);
  const checkUrl = (argv.find(a => a.startsWith('--check=')) ?? '').slice(8) || CHECK_URL;
  const skipWindow = argv.includes('--no-window');
  const binary = findBrowserBinary();
  if (!binary) { console.error('no Chrome/Edge binary'); process.exit(2); }
  if (!fs.existsSync(PROFILE)) { console.error(`no profile at ${PROFILE}`); process.exit(2); }
  log('begin', { profile: PROFILE, binary, checkUrl });

  // 0. The identity, measured on a parked headful launch. It has to be a real
  // document: on about:blank `navigator.userAgentData` is not populated, and a
  // reference with no brands produces a UA override whose brand list is empty -
  // something no real Chrome ever reports.
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>reference</title><p>reference');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${server.address().port}/`;
  const reference = await (async () => {
    const parked = await launch(binary, PROFILE, headfulArgs(PROFILE));
    try {
      await parked.cdp.send('Page.navigate', { url: localUrl }, 20_000).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 1200));
      return await identity(parked.cdp);
    } finally {
      parked.cdp.close();
      await stop(parked.child);
    }
  })();
  server.close();
  log('reference', { userAgent: reference?.userAgent, screen: reference?.screen, window: reference?.window });

  // 1. Headless on the vault profile.
  const first = await launch(binary, PROFILE, headlessArgs(PROFILE));
  let headlessCheck = null;
  try {
    log('phase1.identity', await applyIdentity(first.cdp, reference));
    headlessCheck = await checkSite(first.cdp, checkUrl);
    log('phase1.headless', headlessCheck);
  } finally {
    first.cdp.close();
    await stop(first.child);
  }

  // 2. Plain window for the human, on the same profile.
  log('phase2.window', { message: 'a plain Chrome window is opening on the vault profile' });
  const plain = skipWindow ? null : spawn(binary, plainArgs(PROFILE, checkUrl), { stdio: 'ignore' });
  const closed = !plain
    ? 'skipped'
    : await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeout);
        plain.once('exit', (code) => { clearTimeout(timer); resolve(`closed (${code})`); });
      });
  log('phase2.result', { closed });
  if (plain && plain.exitCode === null) await stop(plain);
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 3. Back to headless on the same profile: does the session survive?
  const second = await launch(binary, PROFILE, headlessArgs(PROFILE));
  let afterCheck = null;
  try {
    log('phase3.identity', await applyIdentity(second.cdp, reference));
    afterCheck = await checkSite(second.cdp, checkUrl);
    log('phase3.headless', afterCheck);
  } finally {
    second.cdp.close();
    await stop(second.child);
  }

  const verdict = healthy(headlessCheck) && healthy(afterCheck);
  log('verdict', { verdict, windowClosed: closed });
  const brief = (check) => check ? `${check.document?.status ?? '-'} ${JSON.stringify(check.snapshot?.title ?? '')} fetch=${check.fetched?.status ?? check.fetched?.error} cf_clearance=${check.cfClearance}` : 'null';
  console.log(`phase 1 (headless): ${brief(headlessCheck)}`);
  console.log(`phase 2 (window):   ${closed}`);
  console.log(`phase 3 (headless): ${brief(afterCheck)}`);
  console.log(verdict ? 'PASS: headless works again after the human window closed' : 'FAIL: the session did not come back cleanly');
  process.exitCode = verdict ? 0 : 1;
}

main().catch((error) => {
  log('fatal', String(error?.stack ?? error));
  console.error(error);
  process.exit(2);
});
