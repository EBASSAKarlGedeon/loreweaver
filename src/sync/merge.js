// Loreweaver sync: conflict merge rules (spec section 7).
// Rule A: chat JSONL prefix fast-forward. Rule B fallback is last-writer-wins
// with the loser preserved (implemented in the engine).

/**
 * @typedef {Object} MergePlan
 * @property {'fast-forward'|'hub'|'local'|'manual'} action
 *   fast-forward: one side is a strict prefix of the other; take the longer side.
 *   hub: take the hub version (Rule B fallback).
 *   local: keep the local version and push it (delete-vs-edit).
 *   manual: cannot auto-merge; keep both and report.
 * @property {Buffer|null} content Content to write (fast-forward result or winning side)
 * @property {string} [headerSource] Which side's header won (for fast-forward)
 */

const CHAT_EXTENSIONS = new Set(['.jsonl']);

/** Check if a path is a chat file (chats/ or group chats/, .jsonl). */
export function isChatPath(relPath) {
    const dot = relPath.lastIndexOf('.');
    const ext = dot === -1 ? '' : relPath.slice(dot).toLowerCase();
    return (relPath.startsWith('chats/') || relPath.startsWith('group chats/')) && CHAT_EXTENSIONS.has(ext);
}

/**
 * Split a chat JSONL buffer into header line + message lines.
 * Tolerates missing or malformed headers: if line 1 is not a chat_metadata
 * object, the whole file is treated as messages.
 * @param {Buffer} buffer
 * @returns {{header: string, messages: string[]}}
 */
export function splitChatLines(buffer) {
    const text = buffer.toString('utf-8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop(); // trailing newline artifact
    }
    if (lines.length === 0) {
        return { header: '', messages: [] };
    }
    let header = lines[0];
    let messages = lines.slice(1);
    let headerOk = false;
    try {
        const parsed = JSON.parse(lines[0]);
        headerOk = typeof parsed === 'object' && parsed !== null && ('chat_metadata' in parsed);
    } catch { /* not JSON */ }
    if (!headerOk) {
        return { header: '', messages: lines };
    }
    return { header, messages };
}

/**
 * Rebuild a chat file from a header and message lines.
 * @param {string} header
 * @param {string[]} messages
 * @returns {Buffer}
 */
export function joinChatLines(header, messages) {
    const parts = [];
    if (header) {
        parts.push(header, ...messages);
    } else {
        parts.push(...messages);
    }
    return Buffer.from(parts.join('\n') + '\n', 'utf-8');
}

/**
 * Rule A: chat prefix merge.
 * If one version's message lines are a strict prefix of the other's, the
 * longer side wins (the "continued on another device" case). Header comes
 * from the winning side. Otherwise null (no auto-merge possible).
 * @param {Buffer} localBuffer
 * @param {Buffer} hubBuffer
 * @returns {null | {action: 'fast-forward', content: Buffer, winner: 'local'|'hub', reason: 'prefix-local'|'prefix-hub'|'equal'}}
 */
export function chatPrefixMerge(localBuffer, hubBuffer) {
    const local = splitChatLines(localBuffer);
    const hub = splitChatLines(hubBuffer);
    const a = local.messages;
    const b = hub.messages;

    // Empty on one side: treat as prefix (empty is a prefix of anything).
    if (a.length === 0 && b.length === 0) {
        // Both empty: nothing to fast-forward; hub copy wins as-is.
        return { action: 'fast-forward', content: hubBuffer, winner: 'hub', reason: 'equal' };
    }

    // Check prefix in both directions.
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) {
            return null; // diverged
        }
    }

    const winner = a.length > b.length ? 'local' : 'hub';
    const content = winner === 'local' ? localBuffer : hubBuffer;
    return {
        action: 'fast-forward',
        content,
        winner,
        reason: a.length === b.length ? 'equal' : (winner === 'local' ? 'prefix-local' : 'prefix-hub'),
    };
}

/**
 * Full merge entry point for one conflicted path. Returns a plan for the engine.
 * @param {string} relPath
 * @param {Buffer|null} localBuffer null = deleted locally
 * @param {Buffer|null} hubBuffer null = deleted on hub
 * @returns {MergePlan}
 */
export function planMerge(relPath, localBuffer, hubBuffer) {
    if (localBuffer && hubBuffer) {
        if (isChatPath(relPath)) {
            const plan = chatPrefixMerge(localBuffer, hubBuffer);
            if (plan) {
                return plan;
            }
            return { action: 'hub', content: hubBuffer, headerSource: undefined };
        }
        return { action: 'hub', content: hubBuffer };
    }
    if (localBuffer && !hubBuffer) {
        // Delete on hub, edit locally: edit wins.
        return { action: 'local', content: localBuffer };
    }
    if (!localBuffer && hubBuffer) {
        // Deleted locally, edited on hub: pull the hub version.
        return { action: 'hub', content: hubBuffer };
    }
    // Deleted on both sides: nothing to do.
    return { action: 'manual', content: null };
}
