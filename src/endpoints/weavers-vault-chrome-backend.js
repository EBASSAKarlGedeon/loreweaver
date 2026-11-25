/**
 * Weaver's Vault — the Chrome backend: one real Chromium, driven over CDP.
 *
 * This is the engine half of the vault browser. The policy half — the request
 * queue, the holds a human step takes, the idle teardown — lives in
 * `weavers-vault-browser.js`, because none of it depends on who owns the browser.
 * Phase 1 of docs/EMBEDDED-ENGINE-PLAN.md exists to make that line real: the
 * packaged app is Electron, which ships its own Chromium, so the same vault has
 * to be able to run on an engine we own.
 *
 * Ported from Glaze's `JannyWebViewProxy` and `janitor_webview_proxy.dart`
 * (AGPL-3.0). A real, headful Chromium is not an affectation: `cf_clearance` is
 * bound to the TLS fingerprint of whoever solved the challenge, so cookies
 * replayed from Node fail (`403 cf-mitigated: challenge`, measured 2026-11-23).
 *
 * A headless instance *is* rejected when it describes itself — a UA saying
 * `HeadlessChrome` earns `403 Access Restricted`, a firewall block (measured
 * 2026-11-25). With the identity of a real Chrome on this machine applied first
 * it passes exactly like a headful one (probe 2: 5/5, and the same 200 fetch),
 * which is why `headless` exists: no window, so nothing to hide. It stays off
 * until `VAULT_BROWSER_HEADLESS=1`, and a human sign-in still needs a window,
 * which is what `escalateToSignIn()` provides.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { VaultBrowserUnavailable } from './weavers-vault-browser-error.js';
import {
    applyIdentity,
    browserMajor,
    IDENTITY_EXPRESSION,
    IDENTITY_PROBE_HTML,
    identityIsUsable,
    loadCachedIdentity,
    sanitizeProduct,
    saveCachedIdentity,
} from './weavers-vault-headless-identity.js';

const START_TIMEOUT_MS = 30_000;
// A brand-new profile has to solve Cloudflare's managed challenge from scratch:
// measured 18 s on this machine and ~42 s on a truly cold one, so 45 s sat right
// on the edge and surfaced as "it loads, then times out". A profile that has
// solved before reuses cf_clearance and is ready in about a second.
const CHALLENGE_TIMEOUT_MS = 120_000;
const CHALLENGE_TIMEOUT_WARM_MS = 30_000;

/** Candidate browser binaries, first existing wins. */
const BROWSER_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/**
 * Kill browser processes that hold this profile directory.
 *
 * Chrome is single-instance per profile: if a previous run left one alive, a new
 * launch hands the URL to it and **exits 0 without ever opening a debugging
 * port** (measured — that is exactly how the live app wedged). The profile is
 * ours alone, so reclaiming it is safe.
 * @param {string} profileDir
 * @returns {number} how many processes were asked to stop
 */
function killProfileBrowsers(profileDir) {
    // Match on the folder's own name: the launch passes whatever `profileDir`
    // holds (the server hands us a relative path, so Chrome's command line shows
    // that same relative form and an absolute needle never matched).
    const needle = path.basename(path.resolve(profileDir)).toLowerCase();
    try {
        if (process.platform === 'win32') {
            const escaped = needle.replace(/'/g, "''");
            const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\""
                + ` | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${escaped}') }`
                + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }';
            const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15_000 });
            return String(result.stdout ?? '').split(/\s+/).filter(Boolean).length;
        }
        // POSIX: scan /proc for our profile path.
        let killed = 0;
        for (const pid of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
            try {
                    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(String.fromCharCode(0)).join(' ');
                if (cmdline.toLowerCase().includes(needle)) {
                    process.kill(Number(pid), 'SIGKILL');
                    killed++;
                }
            } catch { /* gone or not ours */ }
        }
        return killed;
    } catch {
        return 0;
    }
}

/**
 * Turn every top-level window of our browser into a tool window.
 *
 * `--window-position=-32000,-32000` keeps the window out of sight but the shell
 * still gives it a taskbar button (and an Alt-Tab entry), which is what the user
 * sees as "a Chrome window I cannot enter". WS_EX_TOOLWINDOW hides it from both
 * *without* hiding the window: it keeps rendering and painting, which the
 * challenge needs — a hidden window gets no frames and stalls the check.
 *
 * The window must be visible-but-offscreen, never SW_HIDE, and the style has to
 * be applied per window after it exists, so this runs on session start and again
 * once the page is ready.
 * @param {string} profileDir
 * @returns {Promise<number>} windows restyled, or -1 when unsupported/failed
 */
function hideProfileWindows(profileDir) {
    if (process.platform !== 'win32') return Promise.resolve(-1);
    const base = path.basename(path.resolve(profileDir)).replace(/'/g, "''");
    const script = `
Add-Type -Namespace Wv -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
[DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
$pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*${base}*' } |
    ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { Write-Output 0; exit }
$script:n = 0
$cb = [Wv.U+EnumWindowsProc]{
    param($h, $l)
    $procId = [uint32]0
    [void][Wv.U]::GetWindowThreadProcessId($h, [ref]$procId)
    if (($pids -contains $procId) -and [Wv.U]::IsWindowVisible($h)) {
        $ex = [int64][Wv.U]::GetWindowLongPtr($h, -20)
        # TOOLWINDOW on, APPWINDOW off — APPWINDOW forces a taskbar button.
        $new = ($ex -bor 0x80) -band (-bnot 0x40000)
        if ($new -ne $ex) {
            [void][Wv.U]::SetWindowLongPtr($h, -20, [IntPtr]$new)
            [void][Wv.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
        } else {
            # The style is already right but the shell may have created a button
            # when the window was last shown (measured after revealing it for a
            # manual check). Toggle TOOLWINDOW off and on: that forces the shell
            # to re-evaluate without hiding or moving the window.
            [void][Wv.U]::SetWindowLongPtr($h, -20, [IntPtr]($ex -band (-bnot 0x80)))
            [void][Wv.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
            [void][Wv.U]::SetWindowLongPtr($h, -20, [IntPtr]$new)
            [void][Wv.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
        }
        $script:n++
    }
    return $true
}
[void][Wv.U]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output $script:n
`;
    return new Promise(resolve => {
        let out = '';
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        child.stdout?.on('data', chunk => { out += chunk; });
        child.on('error', () => resolve(-1));
        child.on('exit', () => {
            const n = Number(String(out).trim().split(/\s+/).filter(Boolean).pop());
            resolve(Number.isFinite(n) ? n : -1);
        });
    });
}

/**
 * The watcher that strips the taskbar button the moment a window exists.
 *
 * `hideProfileWindows()` can only run after the browser answers — and PowerShell
 * has to boot first — so every launch carries a real taskbar button (and Alt-Tab
 * entry) for a while: measured 2026-11-26, ~1050 ms on this machine. That is the
 * window the user sees as "Chrome flashes open and shut", because there is
 * nothing else to see: the window itself is born offscreen.
 *
 * Started *before* the spawn, so `Add-Type` compiles while Chrome boots. It
 * polls every 50 ms and applies the tool-window style as soon as a window of
 * this profile exists. `$script:` scoping is required: the enum callback runs
 * outside the function scope, where plain `$pids` would be empty.
 * @param {string} base profile folder name, matched against the command line
 * @param {number} budgetMs how long to keep watching (it exits on its own)
 * @returns {string} a PowerShell script that prints how many windows it restyled
 */
function taskbarWatchScript(base, budgetMs) {
    const safe = String(base).replace(/'/g, "''");
    return `
Add-Type -Namespace Wv -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
[DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
$script:pids = @()
$script:nextRefresh = 0
$script:n = 0
$script:deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ${Math.round(budgetMs)}
$cb = [Wv.W+EnumWindowsProc]{
    param($h, $l)
    $procId = [uint32]0
    [void][Wv.W]::GetWindowThreadProcessId($h, [ref]$procId)
    if (($script:pids -contains $procId) -and [Wv.W]::IsWindowVisible($h)) {
        $ex = [int64][Wv.W]::GetWindowLongPtr($h, -20)
        # TOOLWINDOW on, APPWINDOW off: no taskbar button, no Alt-Tab entry.
        $new = ($ex -bor 0x80) -band (-bnot 0x40000)
        if ($new -ne $ex) {
            [void][Wv.W]::SetWindowLongPtr($h, -20, [IntPtr]$new)
            [void][Wv.W]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
            $script:n++
        }
    }
    return $true
}
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $script:deadline) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($now -ge $script:nextRefresh) {
        $script:pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${safe}') } |
            ForEach-Object { [uint32]$_.ProcessId })
        $script:nextRefresh = $now + 1000
    }
    if ($script:pids.Count -gt 0) { [void][Wv.W]::EnumWindows($cb, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 50
}
Write-Output $script:n
`;
}

/**
 * Ask Chrome to shut down through its own shutdown path.
 *
 * A killed browser records `profile.exit_type: "Crashed"` in its Preferences,
 * and the next launch then greets the user with "Restore pages? Chrome didn't
 * shut down correctly." (measured: that file said exactly that). `Browser.close`
 * on the browser endpoint runs the normal shutdown instead.
 * @param {number} port
 * @returns {Promise<boolean>} true when the browser acknowledged the close
 */
function closeBrowserGracefully(port) {
    if (!(port > 0)) return Promise.resolve(false);
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        let socket;
        try {
            socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
        } catch {
            finish(false);
            return;
        }
        socket.on('open', () => {
            try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch { finish(false); }
        });
        socket.on('message', () => finish(true));
        socket.on('close', () => finish(true));
        socket.on('error', () => finish(false));
        setTimeout(() => { try { socket.close(); } catch { /* ignore */ } finish(false); }, 3000);
    });
}

/**
 * Rewrite the recorded exit state in the profile so Chrome starts clean.
 * Covers the cases we cannot close politely: a wedged leftover process, a hard
 * kill, or a crash.
 * @param {string} profileDir
 */
function repairExitState(profileDir) {
    for (const rel of ['Default/Preferences', 'Preferences']) {
        const file = path.join(profileDir, rel);
        try {
            if (!fs.existsSync(file)) continue;
            const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
            const profile = prefs.profile && typeof prefs.profile === 'object' ? prefs.profile : (prefs.profile = {});
            if (profile.exit_type === 'Normal' && profile.exited_cleanly !== false) continue;
            profile.exit_type = 'Normal';
            profile.exited_cleanly = true;
            fs.writeFileSync(file, JSON.stringify(prefs), 'utf8');
        } catch { /* a profile we cannot read is not fatal */ }
    }
}

/**
 * Make our browser windows ordinary windows again (Windows only).
 *
 * The opposite of `hideProfileWindows`: APPWINDOW set, TOOLWINDOW cleared. A
 * tool window is right for an unattended session and wrong for one the user has
 * to type into — it has no taskbar button and does not appear in Alt-Tab, which
 * reads as "a window I cannot reach".
 * @param {string} profileDir
 * @returns {Promise<number>} windows restyled
 */
function normalizeProfileWindows(profileDir) {
    if (process.platform !== 'win32') return Promise.resolve(-1);
    const base = path.basename(path.resolve(profileDir)).replace(/'/g, "''");
    const script = `
Add-Type -Namespace Wv -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
[DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
$pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*${base}*' } |
    ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { Write-Output 0; exit }
$script:n = 0
$cb = [Wv.N+EnumWindowsProc]{
    param($h, $l)
    $procId = [uint32]0
    [void][Wv.N]::GetWindowThreadProcessId($h, [ref]$procId)
    if (($pids -contains $procId) -and [Wv.N]::IsWindowVisible($h)) {
        $ex = [int64][Wv.N]::GetWindowLongPtr($h, -20)
        $new = ($ex -bor 0x40000) -band (-bnot 0x80)
        if ($new -ne $ex) {
            [void][Wv.N]::SetWindowLongPtr($h, -20, [IntPtr]$new)
            [void][Wv.N]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
            $script:n++
        }
    }
    return $true
}
[void][Wv.N]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output $script:n
`;
    return runPowerShellCount(script);
}

/** Shared runner for the window helpers: last number printed, or -1. */
function runPowerShellCount(script) {
    return new Promise(resolve => {
        let out = '';
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        child.stdout?.on('data', chunk => { out += chunk; });
        child.on('error', () => resolve(-1));
        child.on('exit', () => {
            const n = Number(String(out).trim().split(/\s+/).filter(Boolean).pop());
            resolve(Number.isFinite(n) ? n : -1);
        });
    });
}

/**
 * Raise our browser window to the foreground.
 *
 * Placement is Chrome's job (see `placeWindowOnScreen`); this is only about the
 * OS deciding which window the user sees. Two measured lessons are baked in:
 *  - a window with no title is one of Chrome's helpers, and raising those was
 *    how the user ended up staring at a blank white window, so untitled windows
 *    are skipped entirely;
 *  - `SetForegroundWindow` alone is refused when the caller is not the foreground
 *    app, so the input queues are attached first, which is the documented bypass.
 * @param {string} profileDir
 * @param {{titleHint?: string|null}} [options] Prefer windows whose title matches
 * @returns {Promise<number>} windows raised
 */
function raiseProfileWindows(profileDir, { titleHint = null } = {}) {
    if (process.platform !== 'win32') return Promise.resolve(-1);
    const base = path.basename(path.resolve(profileDir)).replace(/'/g, "''");
    const hint = (titleHint ?? '').replace(/'/g, "''");
    const script = `
Add-Type -Namespace Wv -Name R -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
'@
$pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*${base}*' } |
    ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { Write-Output 0; exit }
$fg = [Wv.R]::GetForegroundWindow()
$fgThread = [Wv.R]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$script:n = 0
$cb = [Wv.R+EnumWindowsProc]{
    param($h, $l)
    $procId = [uint32]0
    [void][Wv.R]::GetWindowThreadProcessId($h, [ref]$procId)
    if (($pids -contains $procId) -and [Wv.R]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][Wv.R]::GetWindowTextW($h, $sb, 512)
        $title = $sb.ToString()
        if ($title -and $title.Trim().Length -gt 0) {
            if (-not '${hint}' -or $title -like '*${hint}*') {
                [void][Wv.R]::ShowWindow($h, 9)
                $myThread = [Wv.R]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
                [void][Wv.R]::AttachThreadInput($fgThread, $myThread, $true)
                [void][Wv.R]::BringWindowToTop($h)
                [void][Wv.R]::SetForegroundWindow($h)
                [void][Wv.R]::AttachThreadInput($fgThread, $myThread, $false)
                $script:n++
            }
        }
    }
    return $true
}
[void][Wv.R]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output $script:n
`;
    return runPowerShellCount(script);
}

/**
 * @param {{envName?: string|null}} [options] Also consider this env var, e.g.
 *   `JANNY_BROWSER_PATH`, so a per-source path wins over the shared list.
 * @returns {string|null} Path of the browser this process will drive.
 */
export function findBrowserBinary({ envName = null } = {}) {
    const candidates = [...(envName ? [process.env[envName]] : []), ...BROWSER_CANDIDATES];
    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) return candidate;
        } catch { /* keep looking */ }
    }
    return null;
}

/**
 * Minimal CDP session: one page target, Runtime.evaluate with awaitPromise.
 * Deliberately small — the only thing needed is "run this fetch inside the
 * page that already passed Cloudflare".
 */
class CdpPage {
    constructor(ws, sessionId) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.nextId = 1;
        this.pending = new Map();
    }

    static async attach(wsUrl) {
        const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const page = new CdpPage(ws, null);
        ws.on('message', raw => page.onMessage(raw));
        return page;
    }

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
            else resolve(msg.result);
        }
    }

    send(method, params = {}, timeoutMs = 30_000) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (this.sessionId) payload.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, timeoutMs);
        }).catch(error => {
            throw error;
        });
    }

    async evaluate(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        }, timeoutMs);
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || 'page exception');
        }
        return result.result?.value;
    }

    close() {
        try {
            this.ws.close();
        } catch { /* already closed */ }
    }
}

/**
 * One real Chromium: a child process, one CDP page, one window.
 *
 * Every method here is Chrome-specific on purpose. Spawning a child process,
 * reading `DevToolsActivePort` and restyling a window through `SetWindowPos` are
 * exactly the things an embedded engine replaces, so they are kept in one class
 * that another backend can stand in for (EMBEDDED-ENGINE-PLAN, Phase 2). The
 * vault only ever sees: start, page, reveal, park, dispose — plus the page-level
 * CDP methods it drives through `page`.
 */
export class ChromeBackend {
    /**
     * @param {{profileDir: string, host: string, origin: string, label?: string,
     *   chromePath?: string|null, settingName?: string, envName?: string,
     *   headless?: boolean, logger?: {info: Function, warn: Function},
     *   isHeld?: (() => boolean)|null, onExit?: (() => void)|null}} options
     *   `host` matches page targets and is asserted by `waitForPage`; `origin`
     *   is the URL the browser is parked on. `isHeld` is how the engine asks the
     *   session whether a human owns the window: adoption and reveal may only
     *   park what nobody is looking at. `onExit` fires when the child process
     *   dies underneath us.
     */
    constructor({ profileDir, host, origin, label = 'Vault', chromePath = null,
        settingName = 'vaultBrowserPath', envName = 'VAULT_BROWSER_PATH',
        headless = false, logger = console, isHeld = null, onExit = null }) {
        if (!host || !origin) throw new Error('VaultBrowser needs a host and an origin');
        this.host = host;
        this.origin = origin;
        this.label = label;
        this.settingName = settingName;
        this.envName = envName;
        this.logger = logger;
        this.headless = Boolean(headless);
        /** The measured identity applied to a headless page; see the module. */
        this.identity = null;
        /** The Chrome major version `identity` was measured on. */
        this.identityMajor = '';
        this.chromePath = chromePath;
        // Absolute from the start: a relative --user-data-dir makes the browser's
        // own command line relative too, which defeats profile reclaiming.
        this.profileDir = path.resolve(profileDir);
        this.child = null;
        /** The taskbar watcher (Windows only), while one is running. */
        this.taskbarWatch = null;
        /** The attached page; null until start() or adoptExisting() succeeds. */
        this.page = null;
        this.port = null;
        /** The OS window handle, once the page has one. */
        this.windowId = null;
        /** Set once the taskbar style has been applied for this browser run. */
        this.taskbarHidden = false;
        this.isHeld = typeof isHeld === 'function' ? isHeld : () => false;
        this.onExit = typeof onExit === 'function' ? onExit : null;
    }

    /**
     * Start the taskbar watcher. Windows only, best effort, never throws.
     *
     * Called right before the browser spawns, so `Add-Type` compiles while Chrome
     * boots: the first 50 ms tick that sees a window restyles it, instead of the
     * ~1050 ms a taskbar button used to stay visible (measured 2026-11-26).
     * @param {{budgetMs?: number, profileDir?: string}} [options] `profileDir`
     *   defaults to the session profile; the identity measurement passes its own
     *   throwaway profile so that window is styled too.
     * @returns {import('node:child_process').ChildProcess|null}
     */
    startTaskbarWatch({ budgetMs = 8000, profileDir = this.profileDir } = {}) {
        if (process.platform !== 'win32') return null;
        this.stopTaskbarWatch();
        try {
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                taskbarWatchScript(path.basename(profileDir), budgetMs)],
            { stdio: 'ignore', windowsHide: true });
            child.on('error', () => {});
            child.unref?.();
            this.taskbarWatch = child;
            return child;
        } catch {
            return null;
        }
    }

    /** Stop the watcher: a human reveal, or the browser going away. */
    stopTaskbarWatch() {
        const child = this.taskbarWatch;
        this.taskbarWatch = null;
        if (!child) return;
        try { child.kill(); } catch { /* already gone */ }
    }

    /**
     * Put the window on screen for a human step: placed, raised, focused — and
     * deliberately a *normal* window again. A window the user must find and type
     * into is unusable while it has neither a taskbar button nor an Alt-Tab entry
     * (the reported "I cannot Alt-Tab back to it", 2026-11-26). `park()` puts the
     * tool style back when the step ends.
     * @returns {Promise<{revealed: number, running: boolean}>}
     */
    async reveal() {
        // A headless session has nothing to put on screen, so a human step has to
        // hand the profile to a plain window instead; see `escalateToSignIn()`.
        if (this.headless) return this.escalateToSignIn();
        // The watcher would strip the button again for the rest of its budget.
        this.stopTaskbarWatch();
        await this.focusPage();
        // Chrome places its own window. Moving a window that was born at
        // -32000,-32000 with SetWindowPos leaves the compositor holding a stale
        // surface: the renderer paints (verified: first-contentful-paint, a 44 kB
        // frame) while the window itself stays blank white. `Browser.setWindowBounds`
        // goes through Chrome's own window management, which rebuilds the surface.
        const placed = await this.placeWindowOnScreen();
        // A window the user must type into has to behave like a normal window.
        await normalizeProfileWindows(this.profileDir);
        this.taskbarHidden = false;
        const raised = await raiseProfileWindows(this.profileDir, { titleHint: 'janitor' });
        // Belt and braces for the stale surface: a one-pixel resize forces Chrome
        // to reallocate the compositor's output.
        await this.nudgeWindowSize();
        await this.focusPage();
        // Deliberately *not* re-hiding it: the sign-in window is a normal window
        // for as long as the human needs it (taskbar button and Alt-Tab entry
        // included). release() -> park() restores the tool style afterwards.
        this.taskbarHidden = false;
        return { revealed: placed ? 1 : 0, raised, running: this.isRunning() };
    }

    /**
     * Ask Chrome to put its window on screen, in front, at a usable size.
     * @returns {Promise<boolean>} whether a bound was applied
     */
    async placeWindowOnScreen() {
        if (!this.page) return false;
        try {
            const size = await this.page.evaluate(
                '({ w: Math.min(1280, screen.availWidth - 80), h: Math.min(900, screen.availHeight - 80) })',
                { awaitPromise: false, timeoutMs: 5_000 },
            );
            const width = Math.max(600, Math.round(Number(size?.w) || 1200));
            const height = Math.max(500, Math.round(Number(size?.h) || 820));
            const { windowId } = await this.page.send('Browser.getWindowForTarget', {});
            // `normal` first: a maximised or minimised window ignores left/top.
            await this.page.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
            await this.page.send('Browser.setWindowBounds', {
                windowId,
                bounds: { left: 40, top: 40, width, height },
            });
            this.windowId = windowId;
            return true;
        } catch (error) {
            this.logger.warn?.(`[Weaver's Vault] ${this.label}: could not place the window (${error.message})`);
            return false;
        }
    }

    /** One-pixel resize there and back: forces a fresh compositor surface. */
    async nudgeWindowSize() {
        if (!this.page || !this.windowId) return;
        try {
            const { bounds } = await this.page.send('Browser.getWindowBounds', { windowId: this.windowId });
            const width = Math.max(600, Number(bounds?.width) || 1200);
            const height = Math.max(500, Number(bounds?.height) || 820);
            const left = Number(bounds?.left) || 40;
            const top = Number(bounds?.top) || 40;
            await this.page.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { left, top, width: width - 1, height } });
            await new Promise(r => setTimeout(r, 120));
            await this.page.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { left, top, width, height } });
        } catch { /* cosmetic */ }
    }

    /**
     * Park the window again after a human step finishes: offscreen, out of the
     * taskbar, so a lingering session is invisible.
     * @returns {Promise<void>}
     */
    async park() {
        if (this.headless || !this.page) return;
        // `windowId` is only set by `placeWindowOnScreen()`, so a parked window
        // that was never revealed had no id and this method silently did nothing
        // — which is why a browser born on screen (Chrome restores the last
        // placement) stayed there. Ask for the id instead.
        if (!this.windowId) {
            try {
                const { windowId } = await this.page.send('Browser.getWindowForTarget', {});
                this.windowId = windowId;
            } catch { /* no target window yet; hideWindow still applies */ }
        }
        if (this.windowId) {
            try {
                await this.page.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { left: -32000, top: -32000 } });
            } catch { /* cosmetic */ }
        }
        this.taskbarHidden = false;
        await this.hideWindow();
    }

    /**
     * Keep the browser's windows out of the taskbar (Windows, best effort).
     * Cheap enough for session start; never fails a request.
     * @returns {Promise<void>}
     */
    async hideWindow() {
        if (this.headless || this.taskbarHidden) return;
        try {
            const n = await hideProfileWindows(this.profileDir);
            if (n > 0) {
                this.taskbarHidden = true;
                this.logger.info?.(`[Weaver's Vault] ${this.label}: browser window hidden from the taskbar (it keeps rendering offscreen)`);
            }
        } catch { /* cosmetic only */ }
    }

    async start() {
        const binary = this.chromePath ?? findBrowserBinary({ envName: this.envName });
        if (!binary) {
            throw new VaultBrowserUnavailable(
                `No Chrome/Edge binary was found. Set \`${this.settingName}\` (or ${this.envName}) to one.`,
            );
        }
        fs.mkdirSync(this.profileDir, { recursive: true });

        // A headless browser has no window at all, so there is nothing to style —
        // and its identity has to be measured before it starts, while the profile
        // is still free.
        if (this.headless) await this.ensureIdentity(binary);
        else {
            // Started before anything else in the start path, and long before the
            // spawn: the watcher needs ~1.8 s to compile its C# helper (measured) and
            // Chrome has a window up ~0.5 s after spawn, so starting it here is what
            // makes the restyle land on the first tick instead of 1.8 s later. The
            // budget covers a slow start (challenge waits happen after this).
            this.startTaskbarWatch({ budgetMs: 25_000 });
        }

        // A previous run can leave the browser holding the profile lock (a crash
        // skips dispose()). Chrome then refuses to start a second instance on the
        // same profile and the remote-debugging file is stale, so adopt the live
        // session when it still answers — the profile is ours and single-owner.
        const adopted = await this.adoptExisting();
        if (adopted) {
            // The adopted window is parked below; the watcher has no work left.
            this.stopTaskbarWatch();
            return;
        }

        await this.prepareProfile();

        // Spawn and attach live in launch(): they need a real browser, while the
        // lines above are policy decisions that a test can drive with a mock.
        await this.launch(binary);

        // No window to place, so nothing to hide or park; the rest is the same wait.
        if (this.headless) return this.finishHeadlessStart(binary);

        // Keep the window out of the taskbar. The watcher started at the top of
        // start() usually beat us to it (that is the point); this is the
        // fallback for when PowerShell could not start at all.
        await this.hideWindow();
        // Park *before* the wait, not after it: waitForPage() can spend the whole
        // challenge budget (up to two minutes) and until park() runs the window
        // sits wherever Chrome restored its saved placement — mid-desktop after a
        // sign-in, for the entire wait (measured 2026-11-26).
        await this.park();
        const cleared = await this.waitForPage();
        // Safety net: a window created while loading (Chrome restores one after a
        // crash) would not carry the style, and Chrome may restore a placement.
        await this.hideWindow();
        await this.park();
        if (!cleared) {
            // Leave nothing half-solved behind: a challenged page would be reused
            // by the next request and fail the same way.
            await this.dispose();
            throw new VaultBrowserUnavailable(
                'The Cloudflare check did not finish. A Chrome window stays open for a moment — '
                + 'if it shows a verification button, click it once and retry.',
            );
        }
    }

    /**
     * The headless half of `start()`: override the identity, then wait for the
     * page. Split out so `start()` still reads as one sequence of window steps
     * (park, wait, park) for the headful path.
     * @param {string} binary
     * @returns {Promise<void>}
     */
    async finishHeadlessStart(binary) {
        await this.applyHeadlessIdentity(binary);
        if (await this.waitForPage()) return;
        // Leave nothing half-solved behind: a challenged page would be reused by
        // the next request and fail the same way.
        await this.dispose();
        throw new VaultBrowserUnavailable(
            'The Cloudflare check did not finish in the headless browser. Retry, or set '
            + 'VAULT_BROWSER_HEADLESS=0 to run the visible browser instead.',
        );
    }

    /**
     * Take the profile back from a previous run, before anything spawns.
     *
     * Split out of `start()` so a test can drive the start sequence without a
     * browser: this is the only part that touches PowerShell and the filesystem.
     * @returns {Promise<void>}
     */
    async prepareProfile() {
        // Nothing answers on the recorded port, but a previous run's browser can
        // still be alive and holding the profile. Chrome would hand our URL to it
        // and exit 0 with no debugging port — a wedge that looked like Cloudflare
        // never clearing. The profile is exclusive to us, so reclaim it.
        const reclaimed = killProfileBrowsers(this.profileDir);
        if (reclaimed !== 0) {
            this.logger.warn?.(`[Weaver's Vault] ${this.label}: reclaimed the browser profile from a previous run`);
            await new Promise(r => setTimeout(r, 800));
        }

        // Nothing can be holding the profile at this point, so it is safe to clear
        // the "Crashed" exit type that shows the restore bubble on next start.
        repairExitState(this.profileDir);

        // Any lock file left in the profile is now stale — a killed or crashed run.
        for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
            try {
                fs.rmSync(path.join(this.profileDir, name), { force: true, recursive: true });
            } catch { /* best effort */ }
        }
    }

    /**
     * The identity a headless page has to claim, from the cache or freshly
     * measured. Called before the headless browser starts, while the profile is
     * free (measuring needs it).
     * @param {string} binary
     * @returns {Promise<void>}
     */
    async ensureIdentity(binary) {
        const cached = loadCachedIdentity(this.profileDir);
        if (cached) {
            this.identity = cached.reference;
            this.identityMajor = cached.major;
            this.logger.info?.(`[Weaver's Vault] ${this.label}: headless identity reused (Chrome ${cached.major})`);
            return;
        }
        await this.measureIdentity(binary);
    }

    /**
     * Measure the identity with a real Chrome on this machine.
     *
     * The one thing a headless browser must not be asked to describe. The
     * measuring browser is a normal headful launch of the same binary: parked
     * offscreen and out of the taskbar by `start()`, so it is never seen, and it
     * loads only the vault's own origin — no site traffic.
     * @param {string} binary
     * @returns {Promise<void>}
     */
    async measureIdentity(binary) {
        // A throwaway profile on a local `file://` page, headful (it has to be: the
        // screen is part of the identity) but parked and out of the taskbar. No
        // network, so measuring costs the site nothing, and the vault profile is
        // never touched — no cookies opened, no exit state rewritten.
        const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-identity-'));
        const probePage = path.join(probeDir, 'identity-probe.html');
        fs.writeFileSync(probePage, IDENTITY_PROBE_HTML);
        const watcher = this.startTaskbarWatch({ profileDir: probeDir, budgetMs: 20_000 });
        let child = null;
        try {
            child = spawn(binary, [
                '--remote-debugging-port=0',
                `--user-data-dir=${probeDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                // Parked and out of the taskbar: this window exists for ~3 s and
                // must never be seen either.
                '--window-position=-32000,-32000',
                '--window-size=1280,900',
                pathToFileURL(probePage).href,
            ], { stdio: 'ignore', windowsHide: true });
            child.on('error', () => {});
            const port = await this.waitForPort(probeDir, { timeoutMs: 20_000 });
            if (!port) throw new VaultBrowserUnavailable('The browser did not start to measure an identity.');
            const page = await this.attachToPage(port);
            if (!page) throw new VaultBrowserUnavailable('The browser page could not be attached.');
            try {
                const reference = await page.evaluate(IDENTITY_EXPRESSION, { awaitPromise: true, timeoutMs: 20_000 });
                if (!identityIsUsable(reference)) {
                    // A guess here is a fingerprint mismatch, which is worse than the
                    // window this mode exists to avoid. Refuse, loudly.
                    throw new VaultBrowserUnavailable(
                        'The browser could not report a usable identity (no brands, or no screen size), so '
                        + 'the vault stays headful. Set VAULT_BROWSER_HEADLESS=0 to silence this.',
                    );
                }
                const version = await page.send('Browser.getVersion', {}).catch(() => null);
                const product = sanitizeProduct(version?.product ?? '');
                this.identity = reference;
                this.identityMajor = browserMajor(product);
                saveCachedIdentity(this.profileDir, product, reference);
                this.logger.info?.(`[Weaver's Vault] ${this.label}: measured the browser identity (Chrome ${this.identityMajor}, ${reference.screen.width}x${reference.screen.height})`);
            } finally {
                page.close();
            }
        } finally {
            try { child?.kill(); } catch { /* already gone */ }
            if (child?.pid && process.platform === 'win32') {
                spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            }
            try { watcher?.kill(); } catch { /* already gone */ }
            try {
                fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
            } catch { /* a throwaway profile; the OS temp cleaner will get it */ }
        }
    }
    /**
     * Apply the measured identity to the page, so the site sees a real Chrome.
     * @param {string} binary used only if Chrome turned out to have updated
     * @returns {Promise<boolean>} whether the override was accepted
     */
    async applyHeadlessIdentity(binary) {
        if (!this.page) return false;
        const version = await this.page.send('Browser.getVersion', {}).catch(() => null);
        const product = sanitizeProduct(version?.product ?? '');
        const major = browserMajor(product);
        if (major && this.identityMajor && major !== this.identityMajor) {
            // Chrome updated under us: the cached identity claims the old version,
            // and a UA claiming the wrong version is a mismatch. Measure again.
            this.logger.warn?.(`[Weaver's Vault] ${this.label}: Chrome is now ${major}, re-measuring the headless identity`);
            await this.dispose();
            await this.measureIdentity(binary);
            await this.launch(binary);
            return this.applyHeadlessIdentity(binary);
        }
        const applied = await applyIdentity(this.page, this.identity, product);
        if (applied) this.logger.info?.(`[Weaver's Vault] ${this.label}: headless session (Chrome ${major || '?'}, ${this.identity?.screen?.width}x${this.identity?.screen?.height})`);
        else this.logger.warn?.(`[Weaver's Vault] ${this.label}: could not apply the headless identity`);
        return applied;
    }

    /**
     * Hand the profile to a plain window for a human step.
     *
     * A headless browser cannot show a sign-in form, so it is closed, a browser
     * with no flags of ours is opened on the same profile, and the headless
     * session comes back once that window is closed. Cookies live in the profile,
     * so the sign-in survives the swap (verified 2026-11-25).
     * @param {{timeoutMs?: number}} [options]
     * @returns {Promise<{revealed: number, escalated: boolean, closed: boolean, running: boolean}>}
     */
    async escalateToSignIn({ timeoutMs = 10 * 60_000 } = {}) {
        const binary = this.chromePath ?? findBrowserBinary({ envName: this.envName });
        if (!binary) {
            throw new VaultBrowserUnavailable(
                `No Chrome/Edge binary was found. Set \`${this.settingName}\` (or ${this.envName}) to one.`,
            );
        }
        await this.dispose();
        this.logger.info?.(`[Weaver's Vault] ${this.label}: opening a plain window for sign-in`);
        const child = spawn(binary, [
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            this.origin,
        ], { stdio: 'ignore' });
        let closed = false;
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            child.once('exit', () => { clearTimeout(timer); closed = true; resolve(); });
        });
        if (!closed) {
            // The human never came back: close it rather than leave a window and a
            // profile lock behind.
            try {
                if (process.platform === 'win32') {
                    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                } else {
                    child.kill('SIGKILL');
                }
            } catch { /* already gone */ }
        }
        await this.start();
        return { revealed: 1, escalated: true, closed, running: this.isRunning() };
    }

    /**
     * The command line for one launch.
     *
     * Split out of `launch()` so a test can read it without spawning a browser.
     * A headless launch is deliberately minimal: it has no window to place, so
     * the window flags would describe one that does not exist, and the identity
     * that matters is applied over CDP (`applyHeadlessIdentity`).
     * @returns {string[]}
     */
    launchArgs() {
        const args = [
            '--remote-debugging-port=0',
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            // Chrome shows an "unsupported command-line flag" infobar for the flag
            // above, which looks like a broken browser in a window the user is
            // meant to type into. `--test-type` suppresses exactly that banner.
            '--test-type',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            // An unfocused or covered window throttles its timers, which stalls
            // the challenge script until the deadline expires and looks exactly
            // like a dead site. These keep a background window at full speed.
            '--disable-backgrounding-occluded-windows',
            '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
            '--disable-hang-monitor',
            '--no-service-autorun',
            // Belt and braces: never offer "Restore pages?" even if a previous
            // run had to be killed (the exit state is repaired above).
            '--hide-crash-restore-bubble',
        ];
        if (this.headless) {
            args.push('--headless=new');
        } else {
            // Offscreen but *headful*: a parked real window is what a challenge
            // expects when the identity is not ours to claim.
            args.push('--window-position=-32000,-32000', '--window-size=1280,900');
        }
        args.push(this.origin);
        return args;
    }

    /**
     * Spawn the browser, read its debugging port and attach to its page.
     * @param {string} binary
     * @returns {Promise<void>}
     */
    async launch(binary) {
        const args = this.launchArgs();
        this.child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
        let stderrTail = '';
        this.child.stderr?.on('data', chunk => {
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
        });
        let exited = null;
        this.child.on('exit', code => {
            exited = code;
            this.stopTaskbarWatch();
            this.page?.close();
            this.page = null;
            this.child = null;
            this.onExit?.();
        });

        const port = await this.waitForPort(this.profileDir);
        if (!port) {
            this.stopTaskbarWatch();
            const detail = exited !== null ? ` (browser exited with code ${exited}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''})` : '';
            throw new VaultBrowserUnavailable(`The browser did not expose a debugging port in time${detail}.`);
        }

        this.port = port;
        this.page = await this.attachToPage(port);
        if (!this.page) {
            this.stopTaskbarWatch();
            throw new VaultBrowserUnavailable('The browser page could not be attached.');
        }
    }

    /**
     * Wait for a browsing profile to write its debugging port.
     * @param {string} profileDir
     * @param {{timeoutMs?: number}} [options]
     * @returns {Promise<number|null>} the port, or null on timeout
     */
    async waitForPort(profileDir, { timeoutMs = START_TIMEOUT_MS } = {}) {
        const portFile = path.join(profileDir, 'DevToolsActivePort');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(portFile)) {
                try {
                    const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
                    const port = Number(rawPort);
                    if (port > 0) return port;
                } catch {
                    // Chrome creates the file before it finishes writing it: EBUSY
                    // or a half-line (measured 2026-11-25, and it killed a start).
                    // The file appearing is not the port being readable.
                }
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        return null;
    }

    /**
     * Reuse a browser already running on this profile (crash recovery).
     * @returns {Promise<boolean>} true when a session was adopted
     */
    async adoptExisting() {
        const portFile = path.join(this.profileDir, 'DevToolsActivePort');
        if (!fs.existsSync(portFile)) return false;
        let port = 0;
        try {
            const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
            port = Number(rawPort);
        } catch {
            // Locked while Chrome writes it; a fresh launch is the right answer.
            return false;
        }
        if (!(port > 0)) return false;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
            if (!response.ok) return false;
        } catch {
            return false;
        }
        const page = await this.attachToPage(port);
        if (!page) return false;
        this.port = port;
        this.page = page;
        // The adopted instance may still be mid-challenge; waitForPage covers it.
        await this.waitForPage();
        // Adoption is the common case — every request after the first reuses the
        // running browser — and it used to skip both the taskbar style and the
        // offscreen move. A window left on screen by a reveal therefore stayed on
        // screen for the rest of the session and then vanished with the idle
        // teardown: "the Chrome window appears and disappears after 30 seconds".
        // Parking is safe here because a human step holds the window; only an
        // unheld window is put back offscreen.
        if (this.headless) {
            // An adopted headless page carries no identity (it lives in the
            // renderer), so a session created by an older run has to be given one.
            await this.applyHeadlessIdentity(this.chromePath ?? findBrowserBinary({ envName: this.envName }));
        } else if (this.isHeld()) await this.hideWindow();
        else await this.park();
        this.logger.info?.(`[Weaver's Vault] ${this.label}: adopted the running browser session`);
        return true;
    }

    /** Find the page target that sits on our host and attach to it. */
    async attachToPage(port) {
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`);
                const targets = await response.json();
                const page = targets.find(t => t.type === 'page' && String(t.url).includes(this.host))
                    ?? targets.find(t => t.type === 'page');
                if (page?.webSocketDebuggerUrl) {
                    const session = await CdpPage.attach(page.webSocketDebuggerUrl);
                    await session.send('Runtime.enable').catch(() => {});
                    await this.focusPage(session);
                    return session;
                }
            } catch { /* browser still booting */ }
            await new Promise(r => setTimeout(r, 200));
        }
        return null;
    }

    /**
     * Glaze's `_waitForPage`: poll until the document is real, not the
     * "Just a moment…" interstitial. Checking `window._cf_chl_opt` rather than
     * the cookie also returns at once when Cloudflare never challenged us.
     */
    async waitForPage(timeoutMs = null) {
        const budget = timeoutMs ?? (this.hasSolvedBefore() ? CHALLENGE_TIMEOUT_WARM_MS : CHALLENGE_TIMEOUT_MS);
        const startedAt = Date.now();
        const deadline = startedAt + budget;
        let lastFocus = startedAt;
        while (Date.now() < deadline) {
            try {
                const ready = await this.page.evaluate(
                    `document.readyState === "complete" && !window._cf_chl_opt && location.hostname === ${JSON.stringify(this.host)}`,
                    { awaitPromise: false, timeoutMs: 5_000 },
                );
                if (ready === true) {
                    this.logger.info?.(`[Weaver's Vault] ${this.label}: browser session ready`);
                    this.markSolved();
                    return true;
                }
            } catch { /* mid-navigation */ }
            // Re-assert focus while waiting: a window that loses the foreground
            // mid-challenge would otherwise stall for the whole budget.
            if (Date.now() - lastFocus > 5_000) {
                lastFocus = Date.now();
                await this.focusPage();
            }
            await new Promise(r => setTimeout(r, 400));
        }
        this.logger.warn?.(`[Weaver's Vault] ${this.label}: challenge not cleared in time`);
        return false;
    }

    /** Whether this profile has cleared the challenge before (marker file). */
    hasSolvedBefore() {
        return fs.existsSync(path.join(this.profileDir, 'challenge-solved.marker'));
    }

    markSolved() {
        try {
            fs.writeFileSync(path.join(this.profileDir, 'challenge-solved.marker'), new Date().toISOString());
        } catch { /* advisory only */ }
    }

    /**
     * Raise the page and tell it that it is focused.
     *
     * Without this a background window throttles its timers and Cloudflare's
     * interstitial never finishes, which from the outside is indistinguishable
     * from a dead site. Both calls are best-effort.
     * @param {CdpPage} [session]
     */
    async focusPage(session = this.page) {
        if (!session) return;
        await session.send('Page.bringToFront').catch(() => {});
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }

    async dispose() {
        this.stopTaskbarWatch();
        this.page?.close();
        this.page = null;
        const child = this.child;
        const port = this.port;
        this.child = null;
        this.port = null;
        this.taskbarHidden = false;
        this.holdUntil = 0;
        this.stickyHold = false;

        // Ask nicely first: a killed browser marks the profile as crashed and the
        // next launch shows "Restore pages? Chrome didn't shut down correctly."
        const closed = await closeBrowserGracefully(port);
        if (child) {
            const gone = closed && await this.waitForExit(child, 5000);
            if (!gone && !child.killed) {
                try {
                    if (process.platform === 'win32') {
                        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                    } else {
                        child.kill('SIGKILL');
                    }
                } catch { /* already gone */ }
            }
        }
        // Chrome writes "Crashed" while it runs and does not always flush the
        // clean value on the way out (measured: Crashed/exited_cleanly true after
        // a polite close). The exit *was* orderly, so record that ourselves.
        repairExitState(this.profileDir);
    }

    /**
     * Wait for the browser process to exit on its own.
     * @param {import('node:child_process').ChildProcess} child
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    waitForExit(child, timeoutMs) {
        if (child.exitCode !== null) return Promise.resolve(true);
        return new Promise(resolve => {
            const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
            const onExit = () => { clearTimeout(timer); resolve(true); };
            child.once('exit', onExit);
        });
    }

    /** Whether a session is currently up (no start attempt). */
    isRunning() {
        return Boolean(this.child && this.page);
    }
}
