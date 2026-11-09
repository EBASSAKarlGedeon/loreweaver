// Loreweaver sync: path validation, allow/deny lists.
// Shared by the sync engine (client) and the hub router.
import path from 'node:path';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';

/**
 * Directories synced (names relative to data/<handle>/).
 * Derived from USER_DIRECTORY_TEMPLATE so renames there stay in one place.
 */
export const SYNCED_DIRS = [
    USER_DIRECTORY_TEMPLATE.chats,
    USER_DIRECTORY_TEMPLATE.groupChats,
    USER_DIRECTORY_TEMPLATE.characters,
    USER_DIRECTORY_TEMPLATE.groups,
    USER_DIRECTORY_TEMPLATE.worlds,
    USER_DIRECTORY_TEMPLATE.avatars,
    USER_DIRECTORY_TEMPLATE.backgrounds,
    USER_DIRECTORY_TEMPLATE.themes,
    USER_DIRECTORY_TEMPLATE.movingUI,
    USER_DIRECTORY_TEMPLATE.quickreplies,
    USER_DIRECTORY_TEMPLATE.instruct,
    USER_DIRECTORY_TEMPLATE.context,
    USER_DIRECTORY_TEMPLATE.sysprompt,
    USER_DIRECTORY_TEMPLATE.reasoning,
    USER_DIRECTORY_TEMPLATE.novelAI_Settings,
    USER_DIRECTORY_TEMPLATE.koboldAI_Settings,
    USER_DIRECTORY_TEMPLATE.openAI_Settings,
    USER_DIRECTORY_TEMPLATE.textGen_Settings,
    USER_DIRECTORY_TEMPLATE.files,
    USER_DIRECTORY_TEMPLATE.userImages,
    USER_DIRECTORY_TEMPLATE.comfyWorkflows,
].sort();

/** Root-level file synced (relative to data/<handle>/). */
export const SYNCED_ROOT_FILES = ['settings.json'];

/**
 * Hard deny list. Config may narrow the allow list, never widen past this.
 * Matches whole path segments: 'thumbnails' matches 'thumbnails/x.png'.
 */
export const DENY_DIRS = [
    USER_DIRECTORY_TEMPLATE.thumbnails,
    USER_DIRECTORY_TEMPLATE.vectors,
    USER_DIRECTORY_TEMPLATE.backups,
    USER_DIRECTORY_TEMPLATE.extensions,
    USER_DIRECTORY_TEMPLATE.assets,
    'sync-trash',
    'sync-conflicts',
];

/** Never synced regardless of location. Paths are normalised to '/' separators. */
export const DENY_FILE_PATTERNS = [/(^|\/)secrets/i, /(^|\/)\.git/, /(^|\/)Thumbs\.db$/i, /(^|\/)desktop\.ini$/i, /\.tmp$/i, /\.partial$/i];

/**
 * Normalise a sync-relative path. Accepts '/' or '\' separators.
 * @param {string} relPath Path relative to data/<handle>/, e.g. 'chats/foo.jsonl'
 * @returns {string} Normalised path with '/' separators, no leading/trailing slash
 * @throws {Error} On absolute paths, traversal, empty or malformed input
 */
export function normalizeSyncPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) {
        throw new Error('invalid path');
    }
    // Reject control characters anywhere in the path.
    for (const ch of relPath) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
            throw new Error('invalid path');
        }
    }
    const forward = relPath.replaceAll('\\', '/');
    // Reject Windows drive letters and UNC prefixes before path logic sees them.
    if (/^[a-zA-Z]:/.test(forward) || forward.startsWith('//')) {
        throw new Error('invalid path');
    }
    const segments = [];
    for (const seg of forward.split('/')) {
        if (seg === '' || seg === '.') {
            continue;
        }
        if (seg === '..') {
            throw new Error('traversal rejected');
        }
        // Windows-reserved device names.
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(seg)) {
            throw new Error('invalid path');
        }
        segments.push(seg);
    }
    if (segments.length === 0) {
        throw new Error('invalid path');
    }
    return segments.join('/');
}

/**
 * Check whether a normalised sync path is allowed by the allow/deny lists.
 * Assumes the input already passed normalizeSyncPath.
 * @param {string} relPath Normalised sync path
 * @param {(string[]) => boolean} [isAllowedDir] Optional extra allow-list filter (receives the first segment)
 * @returns {boolean}
 */
export function isSyncPathAllowed(relPath, isAllowedDir) {
    const first = relPath.split('/')[0];
    // Files with '/' are inside a synced dir; files without are root-level.
    // SYNCED_DIRS contains multi-segment dirs (e.g. 'user/files'), so match by prefix.
    if (relPath.includes('/')) {
        const inSyncedDir = SYNCED_DIRS.some(dir => relPath.startsWith(dir + '/'));
        if (!inSyncedDir) {
            return false;
        }
    } else {
        if (!SYNCED_ROOT_FILES.includes(relPath)) {
            return false;
        }
    }
    if (isAllowedDir && !isAllowedDir(first)) {
        return false;
    }
    if (DENY_DIRS.includes(first)) {
        return false;
    }
    for (const re of DENY_FILE_PATTERNS) {
        if (re.test(relPath)) {
            return false;
        }
    }
    return true;
}

/**
 * Validate and normalise a raw sync path, checking the allow/deny lists.
 * @param {string} relPath Raw path as received over the wire
 * @param {(string[]) => boolean} [isAllowedDir] Optional extra allow-list filter
 * @returns {string} Normalised path
 * @throws {Error} If the path is malformed or not allowed
 */
export function validateSyncPath(relPath, isAllowedDir) {
    const normalized = normalizeSyncPath(relPath);
    if (!isSyncPathAllowed(normalized, isAllowedDir)) {
        throw new Error('path not allowed');
    }
    return normalized;
}

/**
 * Resolve a normalised sync path against a data root, verifying containment.
 * Defense in depth: even though validateSyncPath rejects traversal, the final
 * filesystem path is re-checked with isPathUnderParent semantics.
 * @param {string} dataRoot Absolute path to data/<handle>/
 * @param {string} relPath Normalised sync path
 * @returns {string} Absolute filesystem path
 * @throws {Error} If the resolved path escapes the data root
 */
export function resolveSyncPath(dataRoot, relPath) {
    const abs = path.resolve(dataRoot, relPath);
    const rel = path.relative(path.resolve(dataRoot), abs);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error('path escapes data root');
    }
    return abs;
}
