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
 * Move the browser windows onto the screen and to the front.
 *
 * The window is parked offscreen *and* marked as a tool window, so it has no
 * taskbar button and cannot be reached — which is what we want until a challenge
 * needs one human click. On those failures the user must be able to see and
 * click it, so this brings it back: normal size, centred, foreground, still a
 * tool window (it disappears from the taskbar again as soon as it closes).
 * @param {string} profileDir
 * @returns {Promise<number>} windows revealed
 */
function revealProfileWindows(profileDir) {
    if (process.platform !== 'win32') return Promise.resolve(-1);
    const base = path.basename(path.resolve(profileDir)).replace(/'/g, "''");
    const script = `
Add-Type -Namespace Wv -Name V -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@
Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [Math]::Min(1200, [int]($area.Width * 0.8))
$hh = [Math]::Min(860, [int]($area.Height * 0.85))
$x = [int]($area.X + ($area.Width - $w) / 2)
$y = [int]($area.Y + ($area.Height - $hh) / 2)
$pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*${base}*' } |
    ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { Write-Output 0; exit }
$script:n = 0
$cb = [Wv.V+EnumWindowsProc]{
    param($h, $l)
    $procId = [uint32]0
    [void][Wv.V]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($pids -contains $procId) {
        [void][Wv.V]::ShowWindow($h, 9)          # SW_RESTORE
        [void][Wv.V]::SetWindowPos($h, [IntPtr](-1), $x, $y, $w, $hh, 0x40)  # HWND_TOP | SWP_SHOWWINDOW
        [void][Wv.V]::SetForegroundWindow($h)
        $script:n++
    }
    return $true
}
[void][Wv.V]::EnumWindows($cb, [IntPtr]::Zero)
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
        this.idleTimer = setTimeout(() => {
            if (this.pending === 0) this.dispose().catch(() => {});
        }, IDLE_TTL_MS);
        this.idleTimer.unref?.();
    }

    /**
     * GET a URL from inside the parked page.
     * @param {string} url
     * @returns {Promise<{status: number, body: string, challenged: boolean}>}
     */
    fetchText(url) {
        return this.enqueue(async () => {
            await this.ensureStarted();
            let result = await this.rawFetch(url);
            if (result.challenged) {
                this.logger.warn?.(`[Weaver's Vault] ${this.label}: challenge on fetch — reloading session`);
                await this.reload();
                result = await this.rawFetch(url);
            }
            return result;
        });
    }

    async rawFetch(url) {
        const expression = `(() => {
            return fetch(${JSON.stringify(url)}, {
                headers: { "Accept": "text/html,application/xhtml+xml,*/*" },
                credentials: "include",
            }).then(async r => ({
                status: r.status,
                body: await r.text(),
                challenged: r.headers.get("cf-mitigated") === "challenge",
            })).catch(e => ({ status: -1, body: String(e), challenged: false }));
        })()`;
        try {
            const value = await this.page.evaluate(expression, { timeoutMs: 40_000 });
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
        await this.focusPage();
        const revealed = await revealProfileWindows(this.profileDir);
        // Showing the window must not put it back in the taskbar: the tool-window
        // style only affects the shell's lists, so the user can still see and
        // click it while it stays out of the taskbar (measured: revealing alone
        // gave it a button again).
        await hideProfileWindows(this.profileDir);
        this.taskbarHidden = true;
        return { revealed, running: this.isRunning() };
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
