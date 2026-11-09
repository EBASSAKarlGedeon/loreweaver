// Loreweaver sync: scheduler — start/stop, config, mutex, debounce.
import { getConfigValue } from '../util.js';
import { createSyncEngine } from './engine.js';
import { pruneRetention } from './retention.js';

/** @type {{running: boolean, dirty: boolean, timer: NodeJS.Timeout | null, initialTimer: NodeJS.Timeout | null, rerunTimer: NodeJS.Timeout | null}} */
const state = {
    running: false,
    dirty: false,
    timer: null,
    initialTimer: null,
    rerunTimer: null,
};

/** Last run result, for the UI. @type {object|null} */
export let lastRunResult = null;

/** Read sync config with safe fallbacks (never exits when config is unset). */
function readSyncConfig() {
    const get = (key, fallback) => {
        try {
            return getConfigValue(key, fallback);
        } catch {
            return fallback;
        }
    };
    const handles = get('sync.handles', ['default-user']);
    return {
        enabled: !!get('sync.enabled', false),
        role: String(get('sync.role', 'client')),
        hubUrl: String(get('sync.hubUrl', '')).replace(/\/+$/, ''),
        token: String(get('sync.token', '')),
        deviceName: String(get('sync.deviceName', '')),
        intervalSeconds: Math.max(10, Number(get('sync.intervalSeconds', 60))),
        handles: Array.isArray(handles) ? handles.map(String) : ['default-user'],
        retentionDays: Number(get('sync.retentionDays', 30)),
        // Device name whose settings.json wins leaf conflicts on every device.
        // Empty = default (hub wins). E.g. set to 'pc' on the PC config only.
        settingsAuthoritativeDevice: String(get('sync.settingsAuthoritativeDevice', '')),
        // Opt-ins widening the deny list on this device (hub also enforces its
        // own). Accept the string 'true' from env-var overrides as well as the
        // real boolean from config.yaml.
        syncExtensions: get('sync.syncExtensions', false) === true || get('sync.syncExtensions', false) === 'true',
        syncSecrets: get('sync.syncSecrets', false) === true || get('sync.syncSecrets', false) === 'true',
    };
}

/**
 * Run one sync pass for all configured handles, honouring the mutex.
 * If a run is already in progress, mark dirty so a rerun happens after.
 * @returns {Promise<object|null>} Aggregated result, or null when sync is disabled
 */
export async function runSyncOnce() {
    if (state.running) {
        state.dirty = true;
        return lastRunResult;
    }
    state.running = true;
    try {
        const config = readSyncConfig();
        if (!config.enabled) {
            return lastRunResult;
        }
        // Prune trash and conflict copies on every role; these dirs are
        // excluded from sync so this never touches synced data.
        if (typeof globalThis.DATA_ROOT === 'string') {
            try {
                await pruneRetention(globalThis.DATA_ROOT, config.handles, config.retentionDays);
            } catch (err) {
                console.error('Sync retention failed:', err?.message ?? err);
            }
        }
        if (config.role !== 'client' || !config.hubUrl || !config.token) {
            return lastRunResult;
        }
        let aggregated = null;
        for (const handle of config.handles) {
            try {
                const engine = createSyncEngine({
                    dataRoot: globalThis.DATA_ROOT,
                    handle,
                    hubUrl: config.hubUrl,
                    token: config.token,
                    deviceName: config.deviceName,
                    settingsWinner: config.deviceName && config.settingsAuthoritativeDevice === config.deviceName ? 'local' : 'hub',
                    allowExtensions: config.syncExtensions,
                    allowSecrets: config.syncSecrets,
                });
                const result = await engine();
                aggregated = aggregated ?? {
                    pushed: 0, pulled: 0, deleted: 0, errors: [], conflicts: [],
                    ok: true, offline: false, handles: {}, finishedAt: 0,
                };
                aggregated.pushed += result.pushed;
                aggregated.pulled += result.pulled;
                aggregated.deleted += result.deleted;
                aggregated.errors.push(...result.errors);
                aggregated.conflicts.push(...result.conflicts.map(c => c.path));
                aggregated.ok = aggregated.ok && result.ok;
                aggregated.offline = result.offline;
                aggregated.handles[handle] = result;
            } catch (err) {
                aggregated = aggregated ?? {
                    pushed: 0, pulled: 0, deleted: 0, errors: [], conflicts: [],
                    ok: false, offline: false, handles: {}, finishedAt: 0,
                };
                aggregated.ok = false;
                aggregated.errors.push(String(err?.message ?? err));
            }
        }
        if (aggregated) {
            aggregated.finishedAt = Date.now();
        }
        lastRunResult = aggregated;
        return aggregated;
    } finally {
        state.running = false;
        if (state.dirty) {
            state.dirty = false;
            // Rerun once to catch changes made during the run.
            state.rerunTimer = setTimeout(() => { void runSyncOnce(); }, 1000);
            state.rerunTimer.unref?.();
        }
    }
}

/**
 * Start the scheduler: an initial run shortly after startup, then a
 * debounced interval. Runs on the client (sync engine) and on the hub
 * (retention pruning only — the hub syncs via its request-time rescan).
 */
export function start() {
    const config = readSyncConfig();
    if (!config.enabled) {
        return;
    }
    if (state.timer) {
        return; // already running
    }
    // Initial run after a short delay so the server finishes booting.
    state.initialTimer = setTimeout(() => { void runSyncOnce(); }, 5000);
    state.initialTimer.unref?.();
    state.timer = setInterval(() => { void runSyncOnce(); }, config.intervalSeconds * 1000);
    // Do not keep the process alive just for sync.
    state.timer.unref?.();
}

/** Stop the scheduler (tests, shutdown). */
export function stop() {
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
    if (state.initialTimer) {
        clearTimeout(state.initialTimer);
        state.initialTimer = null;
    }
    if (state.rerunTimer) {
        clearTimeout(state.rerunTimer);
        state.rerunTimer = null;
    }
    state.running = false;
    state.dirty = false;
}

/** Test helper: reset module state and last result. */
export function _resetForTests() {
    stop();
    lastRunResult = null;
}
