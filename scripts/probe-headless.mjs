#!/usr/bin/env node
/**
 * Step 2 probe: is `--headless=new` + a UA override indistinguishable from
 * today's headful offscreen Chrome — **without contacting the site**?
 *
 * Everything is served by a local echo server on 127.0.0.1. Nothing in this
 * script, and nothing in the page it serves, requests janitorai.com.
 *
 * What it does, per variant:
 *   A  today's production flags (headful, window born offscreen)
 *   B  the same profile/args plus `--headless=new`, launched on about:blank,
 *      then `Emulation.setUserAgentOverride` built from A's own answers, then
 *      the same navigation
 * and then compares, for each variant:
 *   - the ordered request headers of the page navigation,
 *   - the ordered request headers of an in-page `fetch()` (client hints),
 *   - the page-visible fingerprint (`navigator.*`, `window.chrome`, WebGL, ...).
 *
 * Usage:
 *   node scripts/probe-headless.mjs              # both variants, B mirrors A exactly
 *   node scripts/probe-headless.mjs --reduced    # B claims only `Chrome/<major>.0.0.0`
 *   node scripts/probe-headless.mjs --json       # machine-readable report
 *   node scripts/probe-headless.mjs --keep       # leave the temp profiles
 *
 * Exit code 1 when the two variants differ, so a later run can be scripted.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { findBrowserBinary } from '../src/endpoints/weavers-vault-chrome-backend.js';

const START_TIMEOUT_MS = 30_000;
const REPORT_TIMEOUT_MS = 30_000;

/** Headers that differ only because the two runs are two runs. */
const VOLATILE = new Set(['connection', 'content-length', 'host', 'accept-encoding']);

/** The page. Reports both the ordered headers it saw and what the page can see. */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>probe</title>
<p id="out">probe</p>
<script>
(async () => {
  const cm = navigator.userAgentData;
  let hev = null;
  try {
    hev = cm ? await cm.getHighEntropyValues([
      'fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'wow64',
    ]) : null;
  } catch (error) { hev = { error: String(error) }; }
  const gl = (() => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!ctx) return null;
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: ctx.getParameter(ctx.VENDOR),
        renderer: ctx.getParameter(ctx.RENDERER),
        unmaskedVendor: ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    } catch (error) { return { error: String(error) }; }
  })();
  const snap = {
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
    vendor: navigator.vendor,
    language: navigator.language,
    languages: navigator.languages,
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    pdfViewer: navigator.pdfViewerEnabled,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    cookieEnabled: navigator.cookieEnabled,
    uaData: cm ? { brands: cm.brands, mobile: cm.mobile, platform: cm.platform } : null,
    uaDataHighEntropy: hev,
    chrome: typeof window.chrome === 'object' ? {
      runtime: Boolean(window.chrome.runtime),
      csi: Boolean(window.chrome.csi),
      loadTimes: Boolean(window.chrome.loadTimes),
      app: Boolean(window.chrome.app),
    } : window.chrome ?? null,
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio },
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webgl: gl,
  };
  await fetch('/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snap),
  });
})();
</script>`;

/** Ordered `[name, value]` pairs from a Node request, as received. */
function orderedHeaders(raw) {
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i].toLowerCase(), raw[i + 1]]);
  return pairs;
}

/**
 * The echo server: serves the page, records the navigation headers and the
 * POSTed report (with the headers of that fetch).
 * @returns {Promise<{port: number, reset: Function, waitForReport: Function, close: Function}>}
 */
function startEchoServer() {
  let capture = null;
  let notify = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (req.method === 'POST' && req.url === '/client') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (capture) {
          capture.fetch = { headers: orderedHeaders(req.rawHeaders), body };
        }
        res.writeHead(204).end();
        notify?.();
      });
      return;
    }
    if (capture && !capture.nav) {
      capture.nav = { url: req.url, headers: orderedHeaders(req.rawHeaders) };
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        reset() { capture = { nav: null, fetch: null }; return capture; },
        current() { return capture; },
        waitForReport(timeoutMs = REPORT_TIMEOUT_MS) {
          return new Promise((ok, bad) => {
            if (capture?.fetch) { ok(capture); return; }
            const timer = setTimeout(() => { notify = null; bad(new Error(`the page did not report within ${timeoutMs} ms`)); }, timeoutMs);
            notify = () => { clearTimeout(timer); notify = null; ok(capture); };
          });
        },
        close() { return new Promise((ok) => server.close(() => ok())); },
      });
    });
  });
}

/** The production flags, minus the URL (both variants are navigated by CDP). */
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

/** A minimal CDP client: one page target, one `send()` at a time. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 15_000) {
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

/** Read the DevTools port file Chrome writes for this profile. */
async function readPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the browser exited with code ${child.exitCode}`);
    try {
      const [raw] = String(fs.readFileSync(file, 'utf8')).split('\n');
      const port = Number(raw);
      if (port > 0) return port;
    } catch {
      // Chrome still holds the file open for a moment; try again next tick.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no debugging port within ${START_TIMEOUT_MS} ms`);
}

/**
 * Launch one variant on about:blank and return its CDP handle.
 * @param {{binary: string, profileDir: string, headless: boolean}} options
 */
async function launch({ binary, profileDir, headless }) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const child = spawn(binary, browserArgs(profileDir, headless), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  const port = await readPort(profileDir, child);
  let targets = [];
  for (let i = 0; i < 50; i += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    targets = list.filter(t => t.type === 'page');
    if (targets.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!targets.length) throw new Error(`no page target on port ${port}${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const cdp = new Cdp(socket);
  const version = await cdp.send('Browser.getVersion');
  return { child, port, cdp, version, stderr: () => stderr };
}

/** Full browser version reported by the binary (e.g. 146.0.7680.166). */
function browserVersion(version) {
  const match = /(?:Headless)?Chrome\/([\d.]+)/.exec(version.product ?? '') ?? /(?:Headless)?Chrome\/([\d.]+)/.exec(version.userAgent ?? '');
  return match ? match[1] : null;
}

/**
 * Build the `Emulation.setUserAgentOverride` payload from variant A's answers,
 * so B claims exactly what the real browser proved it is.
 */
export function buildOverride(snapshotA, versionB, { reduced = false, acceptLanguage = true }) {
  const major = String(browserVersion(versionB) ?? '').split('.')[0] || '0';
  const hev = snapshotA.uaDataHighEntropy ?? {};
  const brands = (snapshotA.uaData?.brands ?? []).map((entry) => ({ ...entry }));
  // Desktop Chrome freezes the UA string to `Chrome/<major>.0.0.0` (measured on
  // this machine: A itself reported exactly that), so the UA is copied verbatim.
  const userAgent = String(snapshotA.userAgent);
  // The real build number survives only in the high-entropy list, where a real
  // Chrome always publishes it; `--reduced` replaces it with `<major>.0.0.0`.
  const realBrand = (brand) => /Chromium|Google Chrome/.test(String(brand));
  const fullVersionList = (hev.fullVersionList ?? brands).map(({ brand, version: own }) => ({
    brand,
    version: reduced && realBrand(brand) ? `${major}.0.0.0` : own,
  }));
  const fullVersion = reduced ? `${major}.0.0.0` : (hev.fullVersion ?? fullVersionList[0]?.version ?? `${major}.0.0.0`);
  const payload = {
    userAgent,
    platform: snapshotA.platform,
    userAgentMetadata: {
      brands,
      fullVersionList,
      fullVersion,
      platform: snapshotA.uaData?.platform ?? 'Windows',
      platformVersion: hev.platformVersion ?? '15.0.0',
      architecture: hev.architecture ?? 'x64',
      model: hev.model ?? '',
      mobile: false,
      bitness: hev.bitness ?? '64',
      wow64: hev.wow64 ?? false,
    },
  };
  // Setting `acceptLanguage` makes Chrome emit that header in a different
  // position than a real browser; leaving it out keeps the header order.
  if (acceptLanguage) payload.acceptLanguage = (snapshotA.languages ?? ['en-US', 'en']).join(',');
  return payload;
}

/** The screen A reported, so B does not sit in headless's 800x600 default. */
export function deviceMetrics(snapshotA) {
  return {
    width: snapshotA.window.innerWidth,
    height: snapshotA.window.innerHeight,
    deviceScaleFactor: snapshotA.window.dpr,
    mobile: false,
    screenWidth: snapshotA.screen.width,
    screenHeight: snapshotA.screen.height,
    screenOrientation: { angle: 0, type: 'landscapePrimary' },
    outer: { width: snapshotA.window.outerWidth, height: snapshotA.window.outerHeight },
  };
}

/** Kill the browser (and its children) and wait for Windows to release the profile. */
function stop(child) {
  if (child.exitCode !== null) return new Promise(resolve => setTimeout(resolve, 500));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    child.once('exit', () => { clearTimeout(timer); setTimeout(resolve, 1000); });
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    killer.on('close', () => { /* exit handler resolves */ });
  });
}

/** Run one variant: navigate, wait for the page report, return everything. */
async function runVariant({ binary, profileDir, headless, url, prepare, metrics = null }) {
  const browser = await launch({ binary, profileDir, headless });
  try {
    await browser.cdp.send('Page.enable');
    let override = null;
    if (metrics) {
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', metrics);
      // The metrics override pins the viewport but leaves `window.outerWidth`
      // at 0, which is itself a headless tell; give the window a real size back.
      if (metrics.outer) {
      const { windowId } = await browser.cdp.send('Browser.getWindowForTarget');
      await browser.cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: -32000,
          top: -32000,
          width: metrics.outer.width,
          height: metrics.outer.height,
          windowState: 'normal',
        },
      });
      }
    }
    if (prepare) {
      override = prepare(browser.version);
      await browser.cdp.send('Emulation.setUserAgentOverride', override);
    }
    const started = Date.now();
    await browser.cdp.send('Page.navigate', { url });
    return { browser, started, override };
  } catch (error) {
    browser.cdp.close();
    try { browser.child.kill(); } catch { /* already gone */ }
    throw error;
  }
}

/** Server-side evidence for one variant, keyed for the diff. */
function collect(capture) {
  return {
    nav: capture.nav,
    fetch: capture.fetch,
    snapshot: JSON.parse(capture.fetch.body),
  };
}

/** Ordered header names, so a reordered set is visible on its own. */
function headerOrder(headers) {
  return headers.map(([name]) => name);
}

/** Compare two ordered header lists. */
function diffHeaders(a, b) {
  const out = [];
  const orderA = headerOrder(a);
  const orderB = headerOrder(b);
  if (orderA.join('|') !== orderB.join('|')) {
    out.push({ kind: 'order', a: orderA.join(' | '), b: orderB.join(' | ') });
  }
  const mapA = new Map(a);
  const mapB = new Map(b);
  for (const name of new Set([...orderA, ...orderB])) {
    if (VOLATILE.has(name)) continue;
    const va = mapA.get(name);
    const vb = mapB.get(name);
    if (va === vb) continue;
    out.push({ kind: 'value', name, a: va ?? null, b: vb ?? null });
  }
  return out;
}

/** Walk two JSON values and report every leaf difference. */
function diffValues(a, b, prefix = '', out = []) {
  if (a === b) return out;
  const isObject = (value) => value && typeof value === 'object';
  if (!isObject(a) || !isObject(b)) {
    out.push({ path: prefix || '(root)', a, b });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) diffValues(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
  return out;
}

function format(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(format).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const reduced = argv.includes('--reduced');
  const keep = argv.includes('--keep');
  const acceptLanguage = !argv.includes('--no-accept-language');
  const binary = findBrowserBinary({ envName: 'VAULT_BROWSER_PATH_UNSET_IN_PROBE' });
  if (!binary) {
    console.error('no Chrome/Edge binary found');
    process.exit(2);
  }

  const server = await startEchoServer();
  const url = `http://127.0.0.1:${server.port}/`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-headless-probe-'));
  const profiles = { a: path.join(root, 'a'), b: path.join(root, 'b') };
  const results = {};

  try {
    // Variant A: today's production launch, the reference fingerprint.
    server.reset();
    const a = await runVariant({ binary, profileDir: profiles.a, headless: false, url });
    const captureA = await server.waitForReport();
    results.a = collect(captureA);
    results.a.version = a.browser.version;
    a.browser.cdp.close();
    await stop(a.browser.child);

    // Variant B: headless with the override built from A.
    server.reset();
    const b = await runVariant({
      binary,
      profileDir: profiles.b,
      headless: true,
      url,
      prepare: (versionB) => buildOverride(results.a.snapshot, versionB, { reduced, acceptLanguage }),
      metrics: deviceMetrics(results.a.snapshot),
    });
    const captureB = await server.waitForReport();
    results.b = { ...collect(captureB), version: b.browser.version, override: b.override };
    b.browser.cdp.close();
    await stop(b.browser.child);

    const report = {
      url,
      reduced,
      nav: diffHeaders(results.a.nav.headers, results.b.nav.headers),
      fetch: diffHeaders(results.a.fetch.headers, results.b.fetch.headers),
      snapshot: diffValues(results.a.snapshot, results.b.snapshot),
      a: results.a,
      b: results.b,
    };
    report.ok = !report.nav.length && !report.fetch.length && !report.snapshot.length;

    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`probe: ${url}  (zero site requests)`);
      console.log(`A: headful offscreen   B: --headless=new + UA override${reduced ? ' (reduced version)' : ''}`);
      console.log(`B version: ${browserVersion(results.b.version)}`);
      const pick = (key, read) => {
        const a = read(results.a.snapshot);
        const b = read(results.b.snapshot);
        return `${key.padEnd(24)} A: ${format(a)}\n${' '.repeat(24)} B: ${format(b)}`;
      };
      console.log('\n== fingerprint that matters to a challenge page');
      for (const line of [
        pick('navigator.webdriver', s => s.webdriver),
        pick('navigator.plugins.length', s => s.plugins),
        pick('navigator.mimeTypes.length', s => s.mimeTypes),
        pick('navigator.pdfViewerEnabled', s => s.pdfViewer),
        pick('window.chrome', s => s.chrome),
        pick('navigator.languages', s => s.languages),
        pick('navigator.userAgentData', s => s.uaData),
        pick('WEBGL unmasked renderer', s => s.webgl?.unmaskedRenderer),
        pick('screen / avail / dpr', s => `${s.screen.width}x${s.screen.height} / ${s.screen.availWidth}x${s.screen.availHeight} / ${s.window.dpr}`),
        pick('inner / outer', s => `${s.window.innerWidth}x${s.window.innerHeight} / ${s.window.outerWidth}x${s.window.outerHeight}`),
        pick('visibility / hasFocus', s => `${s.visibility} / ${s.hasFocus}`),
      ]) console.log(`  ${line}`);
      const section = (title, rows, render) => {
        console.log(`\n== ${title}: ${rows.length === 0 ? 'identical' : `${rows.length} difference(s)`}`);
        for (const row of rows) console.log(`  ${render(row)}`);
      };
      section('navigation headers', report.nav, (row) => row.kind === 'order'
        ? `order\n    A: ${row.a}\n    B: ${row.b}`
        : `${row.name}\n    A: ${format(row.a)}\n    B: ${format(row.b)}`);
      section('fetch headers', report.fetch, (row) => row.kind === 'order'
        ? `order\n    A: ${row.a}\n    B: ${row.b}`
        : `${row.name}\n    A: ${format(row.a)}\n    B: ${format(row.b)}`);
      section('page fingerprint', report.snapshot, (row) => `${row.path}\n    A: ${format(row.a)}\n    B: ${format(row.b)}`);
      console.log(`\n${report.ok ? 'PASS' : 'FAIL'}: variants ${report.ok ? 'are identical' : 'differ'}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await server.close();
    if (!keep) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        console.warn(`could not remove ${root}: ${error.message}`);
      }
    }
    else console.log(`profiles kept in ${root}`);
  }
}

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
