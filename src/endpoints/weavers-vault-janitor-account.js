/**
 * Weaver's Vault — JanitorAI account state: snapshot, dirt detection, restore.
 *
 * The capture has to force the account onto a throwaway proxy preset so the site
 * assembles a prompt for the character instead of talking to the user's real
 * model. Glaze restores in a `finally`, which a killed process defeats: it leaves
 * a dummy preset selected, `source: 'proxy'` and `context_length: 0`, and from
 * then on *every* normal chat has no context. That is the damage this file is
 * here to prevent, so the snapshot is taken **before** any mutation and written
 * to disk, and the restore is available as an explicit action afterwards.
 *
 * Measured shape of `GET /hampter/api-settings` (2026-11-24, signed in):
 *
 *     {
 *       legacy_config: {...}, materialized: true, prompts: [20],
 *       proxy_configs: [{ id, client_id, name, api_url, api_key, model, created_at }],
 *       settings: {
 *         selected_proxy_config_id, source, generation_settings: {...context_length},
 *         openai_model, claude_model, bad_words: [], …
 *       }
 *     }
 *
 * The selection fields are **under `settings`**, not top-level. `/hampter/personas`
 * answers 404 (measured), so v1 creates no persona at all — see the capture module.
 *
 * AGPL-3.0 — part of Loreweaver, forked from SillyTavern.
 */

/**
 * Is this a real number?
 *
 * `Number(null) === 0` and `Number('') === 0`, so a plain `Number.isFinite(Number(v))`
 * reports "numeric" for a missing context length and the restore would then put
 * back `0` — a contextless account, the exact damage this file guards against.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumeric(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

/** A preset this extension created: the site would never point at loopback. */
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+\//;

/**
 * Is this preset one of ours?
 *
 * The marker is the loopback URL: a real preset points at a provider. The
 * `client_id` cannot be the marker because JanitorAI burns each one permanently
 * (`409 API_SETTINGS_PROXY_CONFIG_CONFLICT`), so ours is always new.
 * @param {{api_url?: unknown}} preset
 * @returns {boolean}
 */
export function janitorIsOwnPreset(preset) {
    return LOOPBACK_URL.test(String(preset?.api_url ?? ''));
}

/**
 * A throwaway preset standing in for the real provider.
 *
 * Randomised on purpose — a predictable preset is fingerprintable — and
 * `client_id` is fresh every run because the site permanently burns it.
 * @param {{random?: () => number, port?: number}} [options]
 * @returns {{api_key: string, api_url: string, model: string, name: string, prompt_id: null, client_id: string}}
 */
export function janitorDummyPreset({ random = Math.random, port = null } = {}) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const str = (length, alphabet = chars) => {
        let out = '';
        for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length)] ?? alphabet[0];
        return out;
    };
    const portNumber = port ?? (8001 + Math.floor(random() * 57000));
    const hex = () => Math.floor(random() * 16).toString(16);
    const uuid = `${str(8, '0123456789abcdef')}-${str(4, '0123456789abcdef')}-4${str(3, '0123456789abcdef')}-a${str(3, '0123456789abcdef')}-${str(12, '0123456789abcdef')}`;
    return {
        api_key: `sk-${str(48)}`,
        api_url: `http://127.0.0.1:${portNumber}/v1/chat/completions`,
        model: 'gpt-4o',
        name: `${str(12)}`,
        prompt_id: null,
        // `hex` is unused by the original shape; kept out of the object.
        client_id: uuid,
    };
}

/**
 * The fields the capture must put back, read out of an api-settings payload.
 * @param {unknown} apiSettings
 * @param {{takenAt?: string}} [options]
 * @returns {{
 *   takenAt: string,
 *   selectedProxyConfigId: string|null,
 *   source: string|null,
 *   generationSettings: Record<string, unknown>|null,
 *   contextLength: number|null,
 *   hadOwnPresets: boolean,
 *   presetIds: string[],
 * }}
 */
export function janitorAccountSnapshot(apiSettings, { takenAt = new Date().toISOString() } = {}) {
    const settings = apiSettings?.settings && typeof apiSettings.settings === 'object' ? apiSettings.settings : {};
    const presets = Array.isArray(apiSettings?.proxy_configs) ? apiSettings.proxy_configs : [];
    const generation = settings.generation_settings && typeof settings.generation_settings === 'object'
        ? { ...settings.generation_settings }
        : null;
    const contextLength = generation && isNumeric(generation.context_length)
        ? Number(generation.context_length)
        : null;
    return {
        takenAt,
        selectedProxyConfigId: settings.selected_proxy_config_id ?? null,
        source: settings.source ?? null,
        generationSettings: generation,
        contextLength,
        // "Had own presets" decides the restore: an account with none is left on
        // the site's own model instead of on a null selection.
        hadOwnPresets: presets.some(preset => !janitorIsOwnPreset(preset)),
        presetIds: presets.map(preset => String(preset?.id ?? '')).filter(Boolean),
    };
}

/**
 * Exactly what differs between the snapshot and the live account.
 *
 * This is what the UI shows after a killed capture: field, what it was, what it
 * is now. An empty array means the account is as it was.
 * @param {ReturnType<typeof janitorAccountSnapshot>|null} snapshot
 * @param {unknown} apiSettings
 * @returns {Array<{field: string, expected: unknown, actual: unknown}>}
 */
export function janitorAccountDiff(snapshot, apiSettings) {
    if (!snapshot) return [];
    const live = janitorAccountSnapshot(apiSettings, { takenAt: snapshot.takenAt });
    const diff = [];
    // A field the snapshot never had cannot be mismatched: an account that had no
    // selection, no `source` and no `context_length` (measured on a fresh account)
    // would otherwise report three permanent "differences" and never read clean.
    if (snapshot.selectedProxyConfigId !== null
        && String(snapshot.selectedProxyConfigId) !== String(live.selectedProxyConfigId ?? '')) {
        diff.push({ field: 'selected_proxy_config_id', expected: snapshot.selectedProxyConfigId, actual: live.selectedProxyConfigId });
    }
    if (snapshot.source !== null && String(snapshot.source) !== String(live.source ?? '')) {
        diff.push({ field: 'source', expected: snapshot.source, actual: live.source });
    }
    if (snapshot.contextLength !== null && snapshot.contextLength !== live.contextLength) {
        diff.push({ field: 'generation_settings.context_length', expected: snapshot.contextLength, actual: live.contextLength });
    }
    return diff;
}

/**
 * Presets this extension left behind: the durable half of a killed capture.
 * @param {unknown} apiSettings
 * @returns {Array<{id: string, url: string}>}
 */
export function janitorStrayPresets(apiSettings) {
    const presets = Array.isArray(apiSettings?.proxy_configs) ? apiSettings.proxy_configs : [];
    return presets
        .filter(preset => janitorIsOwnPreset(preset))
        .map(preset => ({ id: String(preset?.id ?? ''), url: String(preset?.api_url ?? '') }))
        .filter(preset => preset.id);
}

/** The context length Glaze restores to when the snapshot had none. */
export const JANITOR_DEFAULT_CONTEXT_LENGTH = 4096;

/**
 * The patches that put the account back.
 *
 * Rule for rule from Glaze's `_restoreProfile`, including the two fallbacks that
 * exist so a restore can never leave a chat contextless:
 *  - the selection is only restored when the account had its own presets,
 *    otherwise it is cleared and the site's own model takes over (`source: 'janitor'`);
 *  - a snapshot without a numeric `context_length` (missing, `null` or `''`) is
 *    restored to 4096, never to 0 — and `Number(null)` alone would have said 0.
 * @param {ReturnType<typeof janitorAccountSnapshot>|null} snapshot
 * @returns {{selected: string|null, source: string, generationSettings: Record<string, unknown>|null}}
 */
export function janitorRestorePlan(snapshot) {
    // An account with no generation settings at all still needs a context length
    // patched back: the capture set it to 0, and leaving it there is the
    // contextless-account damage. "Original + 4096" with no original means a
    // settings object holding just that.
    const generation = snapshot?.generationSettings ? { ...snapshot.generationSettings } : {};
    const hasNumericContext = isNumeric(generation.context_length);
    if (!hasNumericContext) generation.context_length = JANITOR_DEFAULT_CONTEXT_LENGTH;
    const hasAnything = Object.keys(generation).length > 0;
    return {
        selected: snapshot?.hadOwnPresets ? (snapshot?.selectedProxyConfigId ?? null) : null,
        source: snapshot?.hadOwnPresets ? (snapshot?.source ?? 'proxy') : 'janitor',
        generationSettings: hasAnything ? generation : null,
    };
}

/**
 * Human-readable reason the capture refuses to start.
 *
 * A dirty account means an earlier capture died half-way. Stacking a second
 * mutation on top makes the restore ambiguous, so this refuses until the user
 * restores — the one case where refusing is safer than proceeding.
 * @param {{diff: Array<object>, strays: Array<object>}|null} state
 * @returns {string}
 */
export function janitorDirtyReason(state) {
    if (!state) return '';
    const parts = [];
    if (state.diff?.length) {
        parts.push(state.diff.map(item => `${item.field}: ${JSON.stringify(item.expected)} → ${JSON.stringify(item.actual)}`).join('; '));
    }
    if (state.strays?.length) {
        parts.push(`${state.strays.length} leftover capture preset(s)`);
    }
    if (!parts.length) return '';
    return `The account is still in capture state from an interrupted import (${parts.join('; ')}). Restore it before importing again.`;
}
