// Loreweaver sync: per-key 3-way merge for settings.json.
//
// settings.json is rewritten wholesale by the frontend on every change, so
// whole-file last-writer-wins makes devices clobber each other's settings
// (themes, extensions, personas reset). Instead, on conflict, merge keys:
// - unchanged on one side since the common ancestor -> take the other side
// - changed on both sides -> hub wins (Rule B, per key)
// - device-local keys always keep this device's value (they describe this
//   device's environment, not user preference).
// Arrays and leaves are taken wholesale; nested plain objects merge deeply.

/** Root-level synced settings file. */
export const SETTINGS_PATH = 'settings.json';

/** Top-level settings keys that are per-device and never synced. */
export const DEVICE_LOCAL_KEYS = ['api_server', 'active_character', 'active_group', 'selected_button'];

/** Plain-object check (arrays are treated as leaves). */
function isPlainObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural equality via JSON (key order significant but sources write consistently). */
function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Recursively merge one node. `pathKey` is '' at the root.
 * @param {any} base Value from the common ancestor (may be undefined)
 * @param {any} local Value from the local device
 * @param {any} hub Value from the hub
 * @param {string} pathKey
 * @param {string[]} conflicts Output: keys where both sides changed
 * @param {'hub'|'local'} winner Who wins a both-changed leaf key
 */
function mergeNode(base, local, hub, pathKey, conflicts, winner) {
    if (isPlainObj(local) && isPlainObj(hub)) {
        const out = {};
        const keys = new Set([...Object.keys(local), ...Object.keys(hub)]);
        for (const k of keys) {
            const b = base && isPlainObj(base) ? base[k] : undefined;
            const l = local[k];
            const h = hub[k];
            // Device-local keys: this device's value always wins at root level.
            if (pathKey === '' && DEVICE_LOCAL_KEYS.includes(k)) {
                out[k] = l !== undefined ? l : h;
                continue;
            }
            // Deleted on one side, unchanged on the other: deletion wins.
            if (l === undefined && b !== undefined && sameJson(b, h)) {
                continue; // local deleted, hub unchanged
            }
            if (h === undefined && b !== undefined && sameJson(b, l)) {
                continue; // hub deleted, local unchanged
            }
            if (l === undefined) {
                out[k] = h; // absent locally: keep hub's (no data loss)
                continue;
            }
            if (h === undefined) {
                out[k] = l; // absent on hub: keep local's
                continue;
            }
            if (sameJson(l, h)) {
                out[k] = l; // same on both
                continue;
            }
            if (sameJson(b, l)) {
                out[k] = h; // local unchanged since base: hub's change wins
                continue;
            }
            if (sameJson(b, h)) {
                out[k] = l; // hub unchanged since base: local's change wins
                continue;
            }
            // Both changed, differently.
            if (isPlainObj(l) && isPlainObj(h)) {
                out[k] = mergeNode(b, l, h, pathKey ? `${pathKey}.${k}` : k, conflicts, winner);
                continue;
            }
            const leafWinner = winner === 'local' ? l : h;
            out[k] = leafWinner; // leaf conflict: configured winner, key recorded
            conflicts.push(pathKey ? `${pathKey}.${k}` : k);
        }
        return out;
    }
    return hub; // non-object (or type mismatch): hub wins
}

/**
 * Merge settings.json buffers 3-way.
 * @param {Buffer|null} baseBuf Last-synced settings content (null when unknown)
 * @param {Buffer} localBuf Local settings content
 * @param {Buffer} hubBuf Hub settings content
 * @param {'hub'|'local'} [winner] Who wins a both-changed leaf key (default 'hub').
 *   Set to 'local' when the device is the designated authority (e.g. the
 *   owner's PC overwrites hub settings).
 * @returns {{ok: boolean, content?: Buffer, conflictKeys?: string[]}} ok:false when any buffer is unparseable
 */
export function mergeSettingsBuffers(baseBuf, localBuf, hubBuf, winner = 'hub') {
    try {
        const base = baseBuf ? JSON.parse(baseBuf.toString('utf-8')) : undefined;
        const local = JSON.parse(localBuf.toString('utf-8'));
        const hub = JSON.parse(hubBuf.toString('utf-8'));
        if (!isPlainObj(local) || !isPlainObj(hub)) {
            return { ok: false };
        }
        /** @type {string[]} */
        const conflicts = [];
        const merged = mergeNode(base, local, hub, '', conflicts, winner);
        return {
            ok: true,
            content: Buffer.from(JSON.stringify(merged, null, 4) + '\n', 'utf-8'),
            conflictKeys: conflicts,
        };
    } catch {
        return { ok: false };
    }
}
