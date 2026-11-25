/**
 * Weaver's Vault — shared browser driver for sources that need a real page.
 *
 * One instance per origin, ported from Glaze's `JannyWebViewProxy` and
 * `janitor_webview_proxy.dart` (AGPL-3.0). jannyai.com sits behind a Cloudflare
 * managed challenge, and `cf_clearance` is
 * bound to the TLS fingerprint of whoever solved it — so replaying cookies from
 * Node cannot work (`403 cf-mitigated: challenge`, measured 2026-11-23). A real
 * Chromium solves the challenge just by loading the page, and a `fetch()` run
 * inside that page keeps the same fingerprint and cookie jar, so it passes.
 *
 * Same lifecycle as Glaze's proxy: started on demand, parked on the origin,
 * serialized requests, torn down after an idle TTL. Implemented over CDP with
 * `ws` (already a dependency) so no browser-automation package is pulled in.
 *
 * Verified on this machine 2026-11-23: headless Chrome is rejected by the
 * challenge, headful Chrome with a persistent profile passes — hence the
 * offscreen window below. Chrome is used via `channel: chrome` semantics: the
 * installed browser, a dedicated profile dir, no user profile touched.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const IDLE_TTL_MS = 30_000;
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

export class VaultBrowserUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'VaultBrowserUnavailable';
    }
}

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
 * One browser + one parked page, per Glaze's proxy:
 * `_ensureStarted` → `_waitForPage` → `_rawFetch` (reload + retry once on a
 * challenge) → idle shutdown.
 */
export class VaultBrowser {
    /**
     * @param {{profileDir: string, host: string, origin: string, label?: string,
     *   chromePath?: string|null, settingName?: string, envName?: string,
     *   headless?: boolean, logger?: {info: Function, warn: Function}}} options
     *   `host` matches page targets and is asserted by `waitForPage`; `origin`
     *   is the URL the browser is parked on. Everything else is per-source only
     *   for messages.
     */
    constructor({ profileDir, host, origin, label = 'Vault', chromePath = null,
        settingName = 'vaultBrowserPath', envName = 'VAULT_BROWSER_PATH',
        headless = false, logger = console }) {
        if (!host || !origin) throw new Error('VaultBrowser needs a host and an origin');
        this.host = host;
        this.origin = origin;
        this.label = label;
        this.settingName = settingName;
        this.envName = envName;
        /** Set once the taskbar style has been applied for this browser run. */
        this.taskbarHidden = false;
        /** DevTools port of the running browser (for a graceful shutdown). */
        this.port = null;
        // Absolute from the start: a relative --user-data-dir makes the browser's
        // own command line relative too, which defeats profile reclaiming.
        this.profileDir = path.resolve(profileDir);
        this.chromePath = chromePath;
        this.headless = headless;
        this.logger = logger;
        this.child = null;
        this.page = null;
        this.starting = null;
        this.gate = Promise.resolve();
        this.pending = 0;
        this.idleTimer = null;
        this.targets = new Map();
        /** Epoch ms until which the idle teardown must not fire. */
        this.holdUntil = 0;
        /** A hold that only its own deadline can end (a human mid-form). */
        this.stickyHold = false;
        /** Identifiers of document-start scripts currently installed. */
        this.initScripts = [];
    }

    /**
     * Keep the session alive across a human step (sign-in, a manual check).
     *
     * The idle TTL is 30 s, which is right for a fetch and wrong for a Google
     * login: measured, the window closed before it could be used. A held session
     * survives until `release()` or the hold expires.
     * @param {number} [ttlMs]
     */
    /**
     * Keep the session alive for a human step.
     *
     * A normal hold is cancelled by `release()`, which is what the sign-in flow
     * wants: hold while the login page is up, release once it worked. A *sticky*
     * hold lasts until its own deadline no matter what other requests say — a form
     * a human is filling must not close because a status poll called `release()`
     * (measured: `/janitor/account` did exactly that and killed the window 30 s
     * after the persona wall was shown).
     * @param {number} ttlMs
     * @param {{sticky?: boolean}} options
     */
    hold(ttlMs = 15 * 60_000, { sticky = false } = {}) {
        this.holdUntil = Date.now() + Math.max(1_000, Number(ttlMs) || 0);
        this.stickyHold = Boolean(sticky);
        this.scheduleIdleShutdown();
    }

    /** Give the session back to the idle teardown. */
    release() {
        // A sticky hold belongs to a human mid-task; only its deadline ends it.
        if (this.stickyHold && Date.now() < this.holdUntil) return;
        this.holdUntil = 0;
        this.stickyHold = false;
        // The human step is done, so the window goes back offscreen; otherwise a
        // signed-in session leaves a normal window on the desktop.
        this.park().catch(() => {});
        this.scheduleIdleShutdown();
    }

    /** Serialize every request, exactly like Glaze's `_gate`. */
    enqueue(task) {
        this.pending++;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const run = this.gate.then(task).finally(() => {
            this.pending--;
            this.scheduleIdleShutdown();
        });
        this.gate = run.catch(() => {});
        return run;
    }

    scheduleIdleShutdown() {
        if (this.pending > 0) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        const held = Math.max(0, this.holdUntil - Date.now());
        this.idleTimer = setTimeout(() => {
            if (this.pending !== 0) return;
            // A hold that expired while this timer ran is no hold at all.
            if (this.holdUntil > Date.now()) {
                this.scheduleIdleShutdown();
                return;
            }
            this.dispose().catch(() => {});
        }, IDLE_TTL_MS + held);
        this.idleTimer.unref?.();
    }

    /**
     * GET a URL from inside the parked page.
     * @param {string} url
     * @param {{accept?: string, timeoutMs?: number, headers?: Record<string,string>|null}} [options]
     *   `accept` must be the type the endpoint serves: JanitorAI's API is JSON;
     *   `headers` carries an Authorization bearer when the source needs one.
     * @returns {Promise<{status: number, body: string, challenged: boolean}>}
     */
    fetchText(url, { accept = 'text/html,application/xhtml+xml,*/*', timeoutMs = 40_000, headers = null } = {}) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let result = await this.rawFetch(url, { accept, timeoutMs, headers });
            if (result.challenged) {
                this.logger.warn?.(`[Weaver's Vault] ${this.label}: challenge on fetch — reloading session`);
                await this.reload();
                result = await this.rawFetch(url, { accept, timeoutMs, headers });
            }
            return result;
        });
    }

    /**
     * Install a script that runs before any page script, on every navigation.
     *
     * `Page.addScriptToEvaluateOnNewDocument` is the only way to hook `fetch`
     * before the site's own bundle keeps a reference to it — installing it after
     * load is too late for the JanitorAI capture, which wraps the network calls
     * that produce the assembled prompt.
     * @param {string} source
     * @returns {Promise<string|null>} the identifier to remove it again
     */
    async addInitScript(source) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            // `Page.enable` first, and this is not decoration: without it the call
            // below returns an identifier and the script is never applied, so the
            // page silently has none of our functions (measured — the same call
            // with Page.enable defined __glazeSend, without it nothing existed).
            await this.page.send('Page.enable', {}, 15_000);
            // `send` lives on the page connection; the session has no such method
            // (the same mistake as `browser.evaluate`, see PITFALLS #15).
            const result = await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source }, 15_000);
            const identifier = result?.identifier ?? null;
            if (!this.initScripts) this.initScripts = [];
            if (identifier) this.initScripts.push(identifier);
            return identifier;
        });
    }

    /** Remove every script installed by `addInitScript`. */
    async clearInitScripts() {
        const identifiers = Array.isArray(this.initScripts) ? [...this.initScripts] : [];
        this.initScripts = [];
        for (const identifier of identifiers) {
            try {
                await this.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, 10_000);
            } catch { /* the page may be gone */ }
        }
        return identifiers.length;
    }

    /**
     * Run an expression in the parked page.
     *
     * Queued like a fetch, so it never races a navigation, and it starts the
     * session if needed. `evaluate` itself lives on the page connection, not on
     * this class — reaching for `browser.evaluate` is a mistake this method
     * exists to prevent (it failed with "browser.evaluate is not a function").
     * @param {string} expression
     * @param {{timeoutMs?: number}} [options]
     * @returns {Promise<unknown>}
     */
    evaluateInPage(expression, { timeoutMs = 30_000 } = {}) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            return this.page.evaluate(expression, { timeoutMs });
        });
    }

    async rawFetch(url, { accept = 'text/html,application/xhtml+xml,*/*', timeoutMs = 40_000, headers = null } = {}) {
        // JanitorAI's API ignores cookies and wants the Supabase session as a
        // bearer token (measured: 401 with cookies, 200 with the same header), so
        // callers must be able to add headers.
        const extra = headers && typeof headers === 'object' ? headers : {};
        const expression = `(() => {
            return fetch(${JSON.stringify(url)}, {
                headers: Object.assign({ "Accept": ${JSON.stringify(accept)} }, ${JSON.stringify(extra)}),
                credentials: "include",
            }).then(async r => ({
                status: r.status,
                body: await r.text(),
                challenged: r.headers.get("cf-mitigated") === "challenge",
            })).catch(e => ({ status: -1, body: String(e), challenged: false }));
        })()`;
        try {
            const value = await this.page.evaluate(expression, { timeoutMs });
            const status = Number(value?.status ?? -1);
            const body = String(value?.body ?? '');
            const challenged = value?.challenged === true
                || ((status === 403 || status === 503) && body.includes('window._cf_chl_opt'));
            return { status, body, challenged };
        } catch (error) {
            this.logger.warn?.(`[Weaver's Vault] ${this.label} fetch failed: ${error.message}`);
            return { status: -1, body: String(error.message ?? error), challenged: false };
        }
    }

    async ensureStarted() {
        if (this.page) return;
        if (this.starting) return this.starting;
        this.starting = this.start().catch(error => {
            this.starting = null;
            throw error;
        });
        return this.starting;
    }

    /**
     * Bring the browser to the screen so a human can finish a check by hand.
     * @returns {Promise<{revealed: number, running: boolean}>}
     */
    async reveal() {
        await this.ensureStarted();
        // A revealed window belongs to a human step, and an unheld window is
        // closed by the 30 s idle teardown — the "appears and disappears after
        // about 30 seconds" report. Give the step its own budget; `release()`
        // ends it early when the step works, and `park()` takes the window back
        // offscreen afterwards.
        if (!this.isHeld()) this.hold(3 * 60_000);
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
        // A revealed window is on screen and in front, so it does not need a
        // taskbar button as well — and leaving one is exactly what the user sees
        // as a stray Chrome icon while using the vault. Measured 2026-11-26 on the
        // live janitor window: after reveal() the extended style was 0x00240100
        // (WS_EX_APPWINDOW, tool=False), i.e. a taskbar button, and the only code
        // that ever put TOOLWINDOW back was release()->park(). A sticky hold (the
        // persona wall) blocks release() for its whole TTL, so the button then sat
        // there for 20 minutes. hideWindow() only restyles: it neither moves nor
        // hides the window, so the human can keep typing into it.
        this.taskbarHidden = false;
        await this.hideWindow();
        // The shell can add the button a beat after the window is shown, so apply
        // it once more after things settle (hideWindow's no-op branch re-toggles
        // the style, which is what forces the shell to re-evaluate).
        setTimeout(() => { this.hideWindow().catch(() => {}); }, 1_500).unref?.();
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

    /** Whether a human step currently owns the window. */
    isHeld() {
        return Boolean(this.holdUntil) && Date.now() < this.holdUntil;
    }

    /**
     * Park the window again after a human step finishes: offscreen, out of the
     * taskbar, so a lingering session is invisible.
     * @returns {Promise<void>}
     */
    async park() {
        if (!this.page) return;
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
        if (this.taskbarHidden) return;
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

        // A previous run can leave the browser holding the profile lock (a crash
        // skips dispose()). Chrome then refuses to start a second instance on the
        // same profile and the remote-debugging file is stale, so adopt the live
        // session when it still answers — the profile is ours and single-owner.
        const adopted = await this.adoptExisting();
        if (adopted) return;

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
            // Offscreen but *headful*: Cloudflare rejects headless Chrome
            // (measured), and a real window is what Glaze's WebView2 provides.
            '--window-position=-32000,-32000',
            '--window-size=1280,900',
            this.origin,
        ];
        if (this.headless) args.splice(args.length - 1, 0, '--headless=new');

        this.child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
        let stderrTail = '';
        this.child.stderr?.on('data', chunk => {
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
        });
        let exited = null;
        this.child.on('exit', code => {
            exited = code;
            this.page?.close();
            this.page = null;
            this.child = null;
            this.starting = null;
        });

        const portFile = path.join(this.profileDir, 'DevToolsActivePort');
        const deadline = Date.now() + START_TIMEOUT_MS;
        let port = null;
        while (Date.now() < deadline) {
            if (fs.existsSync(portFile)) {
                const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
                port = Number(rawPort);
                if (port > 0) break;
            }
            await new Promise(r => setTimeout(r, 150));
        }
        if (!port) {
            const detail = exited !== null ? ` (browser exited with code ${exited}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''})` : '';
            throw new VaultBrowserUnavailable(`The browser did not expose a debugging port in time${detail}.`);
        }

        this.port = port;
        this.page = await this.attachToPage(port);
        if (!this.page) {
            throw new VaultBrowserUnavailable('The browser page could not be attached.');
        }

        // Keep the window out of the taskbar. Applied per window, so it must run
        // after the window exists; re-applied below in case the page creates
        // another one while loading.
        await this.hideWindow();
        const cleared = await this.waitForPage();
        // A window created while loading (Chrome restores one on a crash) would
        // not carry the style yet.
        await this.hideWindow();
        // And put it back offscreen by CDP, not by trusting `--window-position`:
        // Chrome restores the last placement it saved for the profile, so a reveal
        // in an earlier session makes every later session born on screen. Measured
        // 2026-11-26: the window appeared mid-desktop for its whole 30 s lifetime.
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
     * Reuse a browser already running on this profile (crash recovery).
     * @returns {Promise<boolean>} true when a session was adopted
     */
    async adoptExisting() {
        const portFile = path.join(this.profileDir, 'DevToolsActivePort');
        if (!fs.existsSync(portFile)) return false;
        const [rawPort] = String(fs.readFileSync(portFile, 'utf8')).split('\n');
        const port = Number(rawPort);
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
        if (this.isHeld()) await this.hideWindow();
        else await this.park();
        this.logger.info?.(`[Weaver's Vault] ${this.label}: adopted the running browser session`);
        return true;
    }

    /**
     * Transcode an image to PNG inside the browser.
     *
     * Some source CDNs answer WebP regardless of Accept headers (jannyai's did,
     * measured 2026-11-23) while a character card must be a PNG, and no image
     * library is
     * installed. The bytes are fetched by Node (the CDN sends no CORS headers, so
     * an in-page fetch is refused) and handed over as a data: URL, which does not
     * taint the canvas, so the decode costs one round trip and no dependency.
     * @param {string} dataUrl e.g. `data:image/webp;base64,...`
     * @param {{maxEdge?: number}} [options] Downscale cap; a 1024² WebP becomes a
     *   ~1.4 MB PNG, which is wasteful for a card that syncs between devices.
     * @returns {Promise<Buffer|null>}
     */
    convertImageToPng(dataUrl, { maxEdge = 768 } = {}) { 
        return this.enqueue(async () => {
            await this.ensureStarted();
            const expression = `(async () => {
                try {
                    const image = new Image();
                    image.src = ${JSON.stringify(dataUrl)};
                    await image.decode();
                    const cap = ${Number(maxEdge) || 0};
                    const scale = cap > 0 ? Math.min(1, cap / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
                    const width = Math.max(1, Math.round(image.naturalWidth * scale));
                    const height = Math.max(1, Math.round(image.naturalHeight * scale));
                    const canvas = new OffscreenCanvas(width, height);
                    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
                    const png = await canvas.convertToBlob({ type: 'image/png' });
                    const bytes = new Uint8Array(await png.arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                    }
                    return { width, height, base64: btoa(binary) };
                } catch (error) {
                    return { error: String(error && error.message || error) };
                }
            })()`;
            try {
                const result = await this.page.evaluate(expression, { timeoutMs: 30_000 });
                if (!result?.base64) {
                    this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion failed: ${result?.error ?? 'no data'}`);
                    return null;
                }
                const buffer = Buffer.from(result.base64, 'base64');
                if (buffer.length < 8 || buffer.subarray(1, 4).toString() !== 'PNG') {
                    this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion produced a non-PNG`);
                    return null;
                }
                return buffer;
            } catch (error) {
                this.logger.warn?.(`[Weaver's Vault] ${this.label} avatar conversion error: ${error.message}`);
                return null;
            }
        });
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

    /**
     * Move the parked page to another URL on the same origin and wait for it.
     * Used by the sign-in flow (the browser is parked on the origin, sign-in
     * lives at `/login`).
     * @param {string} url
     * @returns {Promise<boolean>} whether the page became ready
     */
    async navigate(url) {
        await this.enqueue(async () => {
            await this.ensureStarted();
            try {
                await this.page.evaluate(`location.href = ${JSON.stringify(url)}`, { awaitPromise: false, timeoutMs: 10_000 });
            } catch { /* navigation destroys the context */ }
            await new Promise(r => setTimeout(r, 800));
            await this.waitForPage();
        });
        return Boolean(this.page);
    }

    /**
     * A PNG of what the page currently shows, base64.
     *
     * Diagnostics only: when a capture fails, the page is the evidence. Screenshots
     * of the desktop are useless here (other windows cover ours), so this goes
     * through CDP.
     * @returns {Promise<string>}
     */
    screenshot() {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const result = await this.page.send('Page.captureScreenshot', { format: 'png' }, 30_000);
            return String(result?.data ?? '');
        });
    }

    /**
     * A real mouse click at viewport coordinates.
     *
     * `Input.dispatchMouseEvent` produces *trusted* events, which is the whole
     * point: the ported WebView script has to fake a click with `element.click()`
     * and type with a React setter trick, and JanitorAI's editor ignores both —
     * the composer kept the text and the Send button stayed disabled. CDP can do
     * what a WebView cannot.
     * @param {number} x
     * @param {number} y
     */
    clickPoint(x, y) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const point = { x: Math.round(Number(x)), y: Math.round(Number(y)), button: 'left', clickCount: 1 };
            await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, 15_000);
            await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, 15_000);
            return true;
        });
    }

    /**
     * Type text into the focused element as a trusted insertion.
     * @param {string} text
     */
    insertText(text) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            await this.page.send('Input.insertText', { text: String(text ?? '') }, 30_000);
            return true;
        });
    }

    /**
     * A trusted key press (Enter/Escape), with the key codes legacy handlers read.
     * @param {{key: string, code?: string, windowsVirtualKeyCode?: number, text?: string}} options
     */
    pressKey({ key, code = null, windowsVirtualKeyCode = null, text = '' }) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const base = {
                key,
                code: code ?? key,
                windowsVirtualKeyCode: windowsVirtualKeyCode ?? null,
                nativeVirtualKeyCode: windowsVirtualKeyCode ?? null,
            };
            await this.page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text }, 15_000);
            await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 15_000);
            return true;
        });
    }

    /**
     * Forget everything the site stored for one origin: cookies and web storage.
     *
     * Signing out of a site is not just "delete the cookie": JanitorAI keeps the
     * Supabase session in chunked cookies *and* a large persisted store in
     * `localStorage`, and a stale store survives a cookie wipe. Clearing the
     * origin's storage as well is what makes a genuine account switch possible
     * without throwing away the whole Chrome profile.
     * @param {string} origin e.g. `https://janitorai.com`
     * @returns {Promise<{cookies: boolean, storage: boolean}>}
     */
    async clearOriginSession(origin) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let cookies = false;
            let storage = false;
            try {
                await this.page.send('Network.clearBrowserCookies', {}, 15_000);
                cookies = true;
            } catch { /* reported below */ }
            try {
                await this.page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }, 15_000);
                storage = true;
            } catch { /* reported below */ }
            return { cookies, storage };
        });
    }

    /**
     * Reload the page that is currently loaded.
     *
     * Distinct from `reload()`, which navigates to the *origin* to re-run a Cloudflare
     * challenge. The capture needs this one: JanitorAI caches the selected proxy
     * preset in its client store, so a chat is loaded twice — and reloading it to
     * the origin instead silently replaced the chat with the home page, which is
     * how "composer never appeared" happened with a page that had no composer in
     * it at all.
     * @returns {Promise<boolean>}
     */
    async reloadPage() {
        await this.enqueue(async () => {
            await this.ensureStarted();
            try {
                await this.page.send('Page.reload', {}, 15_000);
            } catch { /* a reload destroys the context by design */ }
            await new Promise(r => setTimeout(r, 800));
            await this.waitForPage();
        });
        return Boolean(this.page);
    }

    /** Re-run the managed challenge from the origin (Glaze's `_reload`). */
    async reload() {
        if (!this.page) return;
        try {
            await this.page.evaluate(`location.href = ${JSON.stringify(this.origin)}`, { awaitPromise: false, timeoutMs: 10_000 });
        } catch { /* navigation destroys the context */ }
        await new Promise(r => setTimeout(r, 800));
        await this.waitForPage();
    }

    async dispose() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.page?.close();
        this.page = null;
        this.starting = null;
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

/**
 * One browser per source key, created lazily with the caller's profile directory
 * (mirrors Glaze's singleton proxy, but keyed so two sources cannot evict each
 * other).
 * @type {Map<string, VaultBrowser>}
 */
const sessions = new Map();

/**
 * @param {string} key source key, e.g. `'janny'`
 * @param {{profileDir: string, host: string, origin: string, label?: string,
 *   chromePath?: string|null, settingName?: string, envName?: string,
 *   logger?: object}} options
 * @returns {VaultBrowser}
 */
export function getVaultBrowser(key, options) {
    const existing = sessions.get(key);
    if (existing && existing.profileDir === options.profileDir) return existing;
    if (existing) {
        // A different profile means the old instance can never be reused; left
        // running it would hold the old profile's lock and keep a window alive.
        sessions.delete(key);
        existing.dispose().catch(() => {});
    }
    const browser = new VaultBrowser(options);
    sessions.set(key, browser);
    return browser;
}

/**
 * @param {string|null} key source key, or null to dispose every session
 */
export async function disposeVaultBrowser(key = null) {
    const keys = key ? [key] : [...sessions.keys()];
    const pending = [];
    for (const k of keys) {
        const browser = sessions.get(k);
        if (!browser) continue;
        sessions.delete(k);
        pending.push(browser.dispose());
    }
    await Promise.all(pending);
}
