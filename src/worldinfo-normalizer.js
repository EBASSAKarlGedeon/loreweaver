const NUMERIC_KEY_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isNumericKey(key) {
    return NUMERIC_KEY_PATTERN.test(key) && Number.isSafeInteger(Number(key));
}

/**
 * The world editor looks entries up with `data.entries[entry.uid]`.
 * A missing or mismatched uid therefore hides the entry even though the file parsed fine.
 * Repair that invariant in memory, without dropping or merging any entry.
 *
 * String uids are preserved when they address their own key (the closed-lorebook format).
 * A mismatched uid is reused when it does not collide with another entry; otherwise the
 * entry falls back to its existing object key, and the old key is kept in
 * `extensions.legacy_id` when the key itself has to change.
 *
 * @template T
 * @param {T} worldInfo
 * @returns {T}
 */
export function normalizeWorldInfoUids(worldInfo) {
    if (!isPlainObject(worldInfo)) return worldInfo;

    const source = worldInfo.entries;
    if (!Array.isArray(source) && !isPlainObject(source)) return worldInfo;

    const items = [];
    if (Array.isArray(source)) {
        source.forEach((entry, index) => {
            if (entry !== undefined) items.push({ key: String(index), entry });
        });
    } else {
        for (const [key, entry] of Object.entries(source)) {
            items.push({ key, entry });
        }
    }

    const sourceKeys = new Set(items.map((item) => item.key));
    const claimed = new Set();
    const resolved = new Map();
    let nextUid = 0;

    const claim = (uid) => {
        claimed.add(String(uid));
        return uid;
    };

    const nextFreeUid = () => {
        while (claimed.has(String(nextUid)) || sourceKeys.has(String(nextUid))) {
            nextUid++;
        }
        const uid = nextUid;
        nextUid++;
        claimed.add(String(uid));
        return uid;
    };

    // 1. Keep entries that already satisfy the editor's lookup contract.
    for (const item of items) {
        const entry = item.entry;
        if (!isPlainObject(entry)) continue;
        if (entry.uid === undefined || entry.uid === null) continue;
        if (typeof entry.uid !== 'string' && typeof entry.uid !== 'number') continue;
        if (String(entry.uid) === item.key) {
            resolved.set(item, entry.uid);
            claim(entry.uid);
        }
    }

    // 2. Re-key to an existing uid when nothing else owns that key.
    for (const item of items) {
        if (resolved.has(item)) continue;
        const entry = item.entry;
        if (!isPlainObject(entry)) continue;
        if (entry.uid === undefined || entry.uid === null) continue;
        if (typeof entry.uid !== 'string' && typeof entry.uid !== 'number') continue;

        const uid = String(entry.uid);
        if (claimed.has(uid)) continue;
        if (sourceKeys.has(uid) && uid !== item.key) continue;

        resolved.set(item, entry.uid);
        claim(entry.uid);
    }

    // 3. Missing or conflicting uid: use the object key, then a free integer.
    for (const item of items) {
        if (resolved.has(item)) continue;
        const entry = item.entry;
        if (!isPlainObject(entry)) continue;

        let uid;
        if (!claimed.has(item.key)) {
            uid = isNumericKey(item.key) ? Number(item.key) : item.key;
        } else {
            uid = nextFreeUid();
        }

        resolved.set(item, uid);
        claim(uid);
    }

    const normalized = Object.create(null);
    for (const item of items) {
        const entry = item.entry;
        if (!isPlainObject(entry)) {
            normalized[item.key] = entry;
            continue;
        }

        const uid = resolved.get(item);
        if (String(entry.uid) !== String(uid)) {
            entry.uid = uid;
        }
        if (String(uid) !== item.key) {
            if (!isPlainObject(entry.extensions)) entry.extensions = {};
            if (entry.extensions.legacy_id === undefined) {
                entry.extensions.legacy_id = item.key;
            }
        }

        normalized[String(uid)] = entry;
    }

    worldInfo.entries = normalized;
    return worldInfo;
}
