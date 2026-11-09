// Loreweaver sync: UI status block in the User Settings panel.
// Injects itself; hidden entirely when sync is disabled on this instance.
import { getRequestHeaders, getSettings, is_send_press } from '../script.js';

const MODULE_NAME = 'loreweaver-sync-status';

/** Injected once. */
let injected = false;

/** settings.json hash as last seen; a change means sync replaced the file. */
let lastSettingsHash = null;

/** Re-applying settings concurrently with this flag would loop; guards it. */
let reloadingSettings = false;

/**
 * Format the last-run result into a short human line.
 * @param {object|null} lastRun
 */
function describeLastRun(lastRun) {
    if (!lastRun) {
        return 'No sync yet';
    }
    if (lastRun.offline) {
        return 'Hub unreachable (offline)';
    }
    if (!lastRun.ok) {
        return `Errors: ${lastRun.errors?.length ?? 0}`;
    }
    const parts = [];
    if (lastRun.pushed) {
        parts.push(`${lastRun.pushed} pushed`);
    }
    if (lastRun.pulled) {
        parts.push(`${lastRun.pulled} pulled`);
    }
    if (lastRun.deleted) {
        parts.push(`${lastRun.deleted} deleted`);
    }
    if (lastRun.conflicts?.length) {
        parts.push(`${lastRun.conflicts.length} conflicts`);
    }
    const ago = lastRun.finishedAt ? ` · ${Math.round((Date.now() - lastRun.finishedAt) / 1000)}s ago` : '';
    return parts.length ? `${parts.join(', ')}${ago}` : `In sync${ago}`;
}

/**
 * Build the block DOM once and attach handlers.
 */
function buildBlock() {
    const block = document.createElement('div');
    block.id = 'lw-sync-status-block';
    block.classList.add('flex-container', 'flexFlowColumn');
    block.innerHTML = `
        <h4 class="title_restorable">
            <span>Sync</span>
            <div class="flex-container">
                <div id="lw-sync-now" class="menu_button menu_button_icon margin0" title="Sync now" data-i18n="[title]Sync now">
                    <i class="fa-solid fa-rotate"></i>
                </div>
            </div>
        </h4>
        <div class="flex-container alignitemscenter" style="gap: 8px;">
            <i id="lw-sync-status-icon" class="fa-fw fa-solid fa-circle-question"></i>
            <span id="lw-sync-status-text" class="flex1">Checking…</span>
        </div>
        <details id="lw-sync-conflicts" style="display: none;">
            <summary id="lw-sync-conflicts-summary" style="cursor: pointer;"></summary>
            <div id="lw-sync-conflict-list" class="flex-container flexFlowColumn" style="max-height: 12em; overflow-y: auto; font-size: 0.85em; opacity: 0.85; gap: 2px; padding-top: 4px; word-break: break-all;"></div>
        </details>
    `;
    block.style.marginBottom = '10px';
    block.querySelector('#lw-sync-now').addEventListener('click', onSyncNow);
    return block;
}

/**
 * Sync replaced settings.json on disk: re-fetch and re-apply it so the
 * running UI stops overwriting the synced file with a stale copy (the
 * old silent ping-pong). Skipped during an active generation.
 */
async function maybeReloadSettings(newHash) {
    if (!newHash || reloadingSettings || newHash === lastSettingsHash) {
        return;
    }
    const firstObservation = lastSettingsHash === null;
    lastSettingsHash = newHash;
    // First observation is just the baseline, not a change.
    if (firstObservation || is_send_press) {
        return;
    }
    reloadingSettings = true;
    try {
        await getSettings();
        console.info('[' + MODULE_NAME + '] Synced settings changed on disk; settings re-applied.');
    } catch (err) {
        console.warn('[' + MODULE_NAME + '] Failed to re-apply synced settings:', err);
    } finally {
        reloadingSettings = false;
    }
}

/** Update the status icon and text from a status response. */
function renderStatus(data) {
    const icon = document.querySelector('#lw-sync-status-icon');
    const text = document.querySelector('#lw-sync-status-text');
    const conflictList = document.querySelector('#lw-sync-conflict-list');
    const conflictBox = document.querySelector('#lw-sync-conflicts');
    const conflictSummary = document.querySelector('#lw-sync-conflicts-summary');
    if (!icon || !text) {
        return;
    }
    if (!data || data.enabled === false) {
        document.querySelector('#lw-sync-status-block')?.remove();
        injected = false;
        return;
    }
    const lastRun = data.lastRun ?? null;
    text.textContent = describeLastRun(lastRun);
    void maybeReloadSettings(data.settingsHash);
    if (!lastRun) {
        icon.className = 'fa-fw fa-solid fa-circle-question';
    } else if (lastRun.offline) {
        icon.className = 'fa-fw fa-solid fa-cloud-bolt warning-color';
    } else if (!lastRun.ok) {
        icon.className = 'fa-fw fa-solid fa-triangle-exclamation warning-color';
    } else if (lastRun.conflicts?.length) {
        icon.className = 'fa-fw fa-solid fa-circle-exclamation warning-color';
    } else {
        icon.className = 'fa-fw fa-solid fa-circle-check success-color';
    }
    // Conflicts listing (lazy, only when present).
    if (conflictList) {
        fetch('/api/sync-status/conflicts', { headers: getRequestHeaders() })
            .then(r => (r.ok ? r.json() : { conflicts: [] }))
            .then(({ conflicts }) => {
                if (conflictBox) {
                    conflictBox.style.display = conflicts.length ? '' : 'none';
                }
                if (conflictSummary) {
                    conflictSummary.textContent = `${conflicts.length} conflict cop${conflicts.length === 1 ? 'y' : 'ies'} kept`;
                }
                conflictList.textContent = '';
                for (const conflict of conflicts) {
                    const row = document.createElement('div');
                    // Show the original file path; strip ".<device>.<timestamp>.conflict".
                    row.textContent = conflict.path.replace(/\.[^./]+\.\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z\.conflict$/, '');
                    row.title = `${conflict.path}\n${new Date(conflict.mtime).toLocaleString()}`;
                    conflictList.appendChild(row);
                }
            })
            .catch(() => { /* ignore */ });
    }
}

/** Refresh the displayed status. */
export async function refreshSyncStatus() {
    if (injected) {
        try {
            const res = await fetch('/api/sync-status', { headers: getRequestHeaders() });
            const data = await res.json();
            renderStatus(data);
        } catch { /* ignore */ }
    }
}

async function onSyncNow() {
    try {
        const res = await fetch('/api/sync-status/run', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        const { result } = await res.json();
        if (result) {
            renderStatus({ enabled: true, lastRun: result });
            toastr.info(describeLastRun(result), 'Sync');
        }
    } catch (err) {
        toastr.error(String(err), 'Sync failed');
    }
}

/** Entry: inject the block once the settings panel exists. */
export function initSyncStatus() {
    const panel = document.querySelector('#user-settings-block-content');
    if (!panel || injected) {
        return;
    }
    // Ask the server first; if sync is disabled, do not inject anything.
    fetch('/api/sync-status', { headers: getRequestHeaders() })
        .then(r => r.json())
        .then(data => {
            if (!data || data.enabled === false) {
                return;
            }
            // Full-width row above the settings columns, not a column inside them.
            panel.parentElement.insertBefore(buildBlock(), panel);
            injected = true;
            renderStatus(data);
        })
        .catch(() => { /* ignore */ });
    // Periodic refresh while the settings panel exists.
    setInterval(refreshSyncStatus, 30000);
}
