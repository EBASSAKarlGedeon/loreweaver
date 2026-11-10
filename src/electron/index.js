import { app, BrowserWindow } from 'electron';
import path from 'path';
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

/** @type {string} The URL to load in the window. */
let appUrl;

/** @type {BrowserWindow|null} The splash window shown while the server boots. */
let splashWindow = null;

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        height: 160,
        width: 420,
        frame: false,
        resizable: false,
        fullscreenable: false,
        center: true,
        backgroundColor: '#16181d',
        title: 'Loreweaver',
    });
    // A data: URL keeps the splash self-contained — no files to load.
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
        <html><head><meta charset="utf-8"><style>
            body { margin: 0; height: 100vh; display: flex; flex-direction: column;
                   align-items: center; justify-content: center; gap: 14px;
                   background: #16181d; color: #f4f4f6;
                   font-family: system-ui, 'Segoe UI', sans-serif; user-select: none; }
            .mark { width: 44px; height: 44px; border-radius: 12px; display: flex;
                    align-items: center; justify-content: center;
                    background: linear-gradient(120deg, #ff4d5e, #d92c42);
                    color: #fff; font-size: 20px; }
            .name { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
            .status { font-size: 12px; color: rgba(244,244,246,0.55); }
        </style></head>
        <body>
            <div class="mark">&#10022;</div>
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

function startServer() {
    return new Promise((_resolve, _reject) => {
        serverEvents.addListener(EVENT_NAMES.SERVER_STARTED, ({ url }) => {
            appUrl = url.toString();
            createSillyTavernWindow();
        });
        const sillyTavernRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
