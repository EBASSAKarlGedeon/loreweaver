#!/usr/bin/env node
/**
 * Diff what a page can see about the browser in headful and headless mode.
 *
 * Local only (the dev server), so it costs the site nothing. It exists because
 * the identity work patched the UA and the screen and headless was *still*
 * blocked on 2026-11-25 — so the next tell is in whatever this prints a
 * difference for.
 *
 * Usage: node scripts/probe-browser-fingerprint.mjs [--origin http://127.0.0.1:8000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromeBackend } from '../src/endpoints/weavers-vault-chrome-backend.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:8000');
const HOST = new URL(ORIGIN).hostname;

const PROBE = `(() => {
    const out = {};
    const ua = navigator.userAgentData || null;
    out.ua = navigator.userAgent;
    out.brands = (ua?.brands ?? []).map(b => b.brand + '/' + b.version);
    out.webdriver = navigator.webdriver;
    out.plugins = navigator.plugins.length;
    out.pdfViewer = navigator.pdfViewerEnabled;
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = navigator.deviceMemory;
    out.maxTouchPoints = navigator.maxTouchPoints;
    out.languages = navigator.languages.join(',');
    out.platform = navigator.platform;
    out.vendor = navigator.vendor;
    out.chromeKeys = Object.keys(window.chrome ?? {}).sort().join(',');
    out.hasChromeRuntime = Boolean(window.chrome?.runtime);
    out.notificationPermission = typeof Notification === 'undefined' ? 'none' : Notification.permission;
    out.doNotTrack = navigator.doNotTrack;
    out.colorDepth = screen.colorDepth;
    out.screen = [screen.width, screen.height, screen.availWidth, screen.availHeight].join('x');
    out.inner = [innerWidth, innerHeight].join('x');
    out.outer = [outerWidth, outerHeight].join('x');
    out.dpr = devicePixelRatio;
    out.orientation = screen.orientation?.type ?? '';
    out.visibility = document.visibilityState;
    out.hasFocus = document.hasFocus();
    out.connection = navigator.connection?.effectiveType ?? '';
    out.hasGpu = typeof navigator.gpu !== 'undefined';
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        out.webglVendor = info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : '(masked)';
        out.webglRenderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '(masked)';
        out.webglVersion = gl.getParameter(gl.VERSION);
    } catch (error) { out.webglError = String(error && error.message || error); }
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    out.title = document.title.slice(0, 40);
    return out;
})()`;

async function readMode(mode, headful) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `loreweaver-fp-${mode}-`));
    const logger = { info: () => {}, warn: () => {} };
    const backend = new ChromeBackend({ profileDir, host: HOST, origin: ORIGIN, label: mode, headless: !headful, logger });
    try {
        const t0 = Date.now();
        await backend.start();
        const value = await backend.page.evaluate(PROBE, { awaitPromise: false, timeoutMs: 20_000 });
        return { mode, startMs: Date.now() - t0, ...value };
    } finally {
        try { await backend.dispose(); } catch { /* already gone */ }
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
    }
}

async function main() {
    const headful = await readMode('headful', true);
    const headless = await readMode('headless', false);
    const keys = [...new Set([...Object.keys(headful), ...Object.keys(headless)])].sort();
    const rows = keys
        .filter(key => key !== 'mode')
        .map(key => ({ key, headful: headful[key], headless: headless[key], same: String(headful[key]) === String(headless[key]) }));
    process.stdout.write(`${JSON.stringify({ headful: headful.mode, headless: headless.mode, startMs: [headful.startMs, headless.startMs], rows }, null, 2)}\n`);
}

void main();
