import { app, BrowserWindow } from 'electron';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { serverEvents, EVENT_NAMES } from '../server-events.js';

// The desktop app opens its own window; never also spawn a browser tab.
// '=' style so yargs parses it as a boolean false, which wins over the
// config value in the merged command line arguments.
process.argv.push('--browserLaunchEnabled=false');

const cliArguments = yargs(process.argv)
    .usage('Usage: <your-start-script> [options]')
    .option('width', {
        type: 'number',
        default: 800,
        describe: 'The width of the window',
    })
    .option('height', {
        type: 'number',
        default: 600,
        describe: 'The height of the window',
    })
    .parseSync();

/** @type {string} The Loreweaver repository root (src/electron -> ../..). */
const sillyTavernRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string} The URL to load in the window. */
let appUrl;

/** @type {BrowserWindow|null} The splash window shown while the server boots. */
let splashWindow = null;

function createSplashWindow() {
    // The real Loreweaver logo, inlined as base64 so the splash stays self-contained.
    const logoBase64 = readFileSync(path.join(sillyTavernRoot, 'public/img/logo.png')).toString('base64');
    splashWindow = new BrowserWindow({
        height: 160,
        width: 420,
        frame: false,
        resizable: false,
        fullscreenable: false,
        center: true,
        backgroundColor: '#16181d',
        title: 'Loreweaver',
        // Show only once the content has actually painted, otherwise the window
        // can come up as a blank rectangle and be destroyed before first paint.
        show: false,
    });
    splashWindow.once('ready-to-show', () => splashWindow?.show());
    // A data: URL keeps the splash self-contained — no files to load.
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
        <html><head><meta charset="utf-8"><style>
            body { margin: 0; height: 100vh; display: flex; flex-direction: column;
                   align-items: center; justify-content: center; gap: 14px;
                   background: #16181d; color: #f4f4f6;
                   font-family: system-ui, 'Segoe UI', sans-serif; user-select: none; }
            .mark { width: 44px; height: 44px; object-fit: contain; }
            .name { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
            .status { font-size: 12px; color: rgba(244,244,246,0.55); }
        </style></head>
        <body>
            <img class="mark" src="data:image/png;base64,${logoBase64}" alt="">
            <div class="name">Loreweaver</div>
            <div class="status">Starting server&hellip;</div>
        </body></html>`));
}

function closeSplashWindow() {
    if (!splashWindow) return;
    splashWindow.destroy(); // no close animation; the main window is ready to take over
    splashWindow = null;
}

function createSillyTavernWindow() {
    if (!appUrl) {
        console.error('The server has not started yet.');
        return;
    }
    new BrowserWindow({
        height: cliArguments.height,
        width: cliArguments.width,
    }).loadURL(appUrl);
    // The app window is up and loading — the splash has done its job.
    closeSplashWindow();
}

// Diagnostic: report what Chromium decided about hardware acceleration.
// 'disabled' or 'software' anywhere here explains intermittent UI lag
// (rendering fell back to the CPU instead of the GPU).
async function logGpuStatus() {
    try {
        const features = app.getGPUFeatureStatus();
        const lines = Object.entries(features)
            .filter(([, status]) => status !== 'enabled')
            .map(([feature, status]) => `    ${feature}: ${status}`);
        console.log('GPU feature status:');
        console.log(lines.length ? lines.join('\n') : '    all features enabled (full GPU acceleration)');
        const gpu = app.getGPUInfo('complete');
        const gpus = Array.isArray(gpu?.gpuDevices) ? gpu.gpuDevices.map(d => d.active ? `${d.deviceString ?? d.vendorId}/${d.deviceId} (active)` : d.deviceString).filter(Boolean) : [];
        console.log(`GPU device${gpus.length === 1 ? '' : 's'}: ${gpus.join('; ') || 'unknown'}`);
    } catch (error) {
        console.warn('GPU diagnostics unavailable:', error.message);
    }
}

function startServer() {
    return new Promise((_resolve, _reject) => {
        serverEvents.addListener(EVENT_NAMES.SERVER_STARTED, ({ url }) => {
            appUrl = url.toString();
            createSillyTavernWindow();
        });
        process.chdir(sillyTavernRoot);
        import('../server-global.js');
    });
}

app.whenReady().then(() => {
    // Splash goes up immediately, before the (slow) server boot starts.
    createSplashWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createSillyTavernWindow();
        }
    });

    startServer();
    // GPU init finishes shortly after startup; report too early and we get stale info.
    setTimeout(logGpuStatus, 5000);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
