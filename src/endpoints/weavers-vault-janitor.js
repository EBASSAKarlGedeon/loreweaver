/**
 * Weaver's Vault — JanitorAI source logic.
 *
 * Ported from Glaze 0.10.1 (`janitor_provider.dart`, `janitor_extractor.dart`,
 * `janitor_session.dart`). Reference notes for every behaviour here are in
 * `docs/janitor-source/`, and the live measurements that shaped them are in
 * that folder's INDEX.md.
 *
 * Everything in this file is pure: no network, no browser, no disk. The capture
 * pipeline lives in `weavers-vault-janitor-capture.js` and the session in
 * `weavers-vault-janitor-browser.js`.
 *
 * Measured 2026-11-24 against janitorai.com:
 *  - `/hampter/*` answers JSON anonymously with **no** Cloudflare challenge.
 *  - A `showdefinition: false` card returns `personality`, `scenario`,
 *    `first_message`, `example_dialogs`, `scripts` as `null` and every
 *    `token_counts.*` as 0 — only the HTML bio survives. 0 of 102 cards across
 *    three sorts had a visible definition, so reading alone imports nothing.
 *  - `/hampter/tags` is a bare array (not `{data:[…]}`) of 53 tags.
 *  - Sorts that work: `trending24`, `trending`, `latest`, `popular`
 *    ("Popular all time"); `sort=all` is a 400.
 */

export const JANITOR_HOST = 'janitorai.com';
export const JANITOR_ORIGIN = 'https://janitorai.com/';
export const JANITOR_LOGIN_URL = 'https://janitorai.com/login';
export const JANITOR_API = 'https://janitorai.com/hampter';

/**
 * The sorts the site actually accepts. Anything else is rejected rather than
 * forwarded: `sort=all` returns 400 (measured), so a typo would look like a
 * broken source instead of a bad parameter.
 */
export const JANITOR_SORTS = Object.freeze(['trending24', 'trending', 'latest', 'popular']);

/** @returns {string} a sort the site accepts, defaulting to `trending24`. */
export function janitorSortParam(value) {
    const wanted = String(value ?? '').trim();
    return JANITOR_SORTS.includes(wanted) ? wanted : 'trending24';
}

/**
 * Build a listing URL. Mirrors the parameters Glaze's provider sends, all of
 * which the site accepts (measured): `page`, `mode`, `sort`, `search`,
 * `tag_id[]`, `custom_tags[]`, `user_id[]`.
 * @param {{page?: number, sort?: string, search?: string, tagIds?: Array<number|string>, customTags?: string[], userIds?: string[], mode?: string}} options
 * @returns {string}
 */
export function janitorSearchUrl({
    page = 1, sort = 'trending24', search = '', tagIds = [], customTags = [], userIds = [], mode = 'all',
} = {}) {
    const params = new URLSearchParams();
    params.set('page', String(Math.max(1, Number(page) || 1)));
    params.set('mode', mode === 'sfw' ? 'sfw' : 'all');
    params.set('sort', janitorSortParam(sort));
    const query = String(search ?? '').trim();
    if (query) params.set('search', query);
    for (const id of Array.isArray(tagIds) ? tagIds : []) {
        const clean = String(id ?? '').trim();
        if (/^[1-9]\d*$/.test(clean)) params.append('tag_id[]', clean);
    }
    for (const tag of Array.isArray(customTags) ? customTags : []) {
        const clean = String(tag ?? '').trim();
        if (clean) params.append('custom_tags[]', clean);
    }
    for (const id of Array.isArray(userIds) ? userIds : []) {
        const clean = String(id ?? '').trim();
        if (clean) params.append('user_id[]', clean);
    }
    return `${JANITOR_API}/characters?${params.toString()}`;
}

/** @returns {string} canonical detail URL for one character. */
export function janitorCharacterUrl(id) {
    const clean = String(id ?? '').trim();
    if (!/^[0-9a-f-]{8,}$/i.test(clean)) throw new Error('A JanitorAI character id is required.');
    return `${JANITOR_API}/characters/${clean}`;
}

export const JANITOR_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

/**
 * Resolve a card's avatar to a URL.
 *
 * The payload's `avatar` is a bare CDN key (`"OGVQcCrx4bguJ-8eKoXm9.webp"`), not
 * a URL — fetched as-is it throws, which silently fell back to the default
 * avatar for every card. Glaze's `resolveJanitorAvatar` is the contract:
 * `http…` unchanged, leading `/` under the CDN root, no slash under
 * `/bot-avatars/`, anything else under the CDN root, all with `?width=400`.
 * @param {unknown} avatar
 * @returns {string} a URL, or '' when there is no avatar
 */
export function janitorAvatarUrl(avatar) {
    const raw = String(avatar ?? '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return `https://ella.janitorai.com${raw}?width=400`;
    if (!raw.includes('/')) return `${JANITOR_IMAGE_BASE}${raw}?width=400`;
    return `https://ella.janitorai.com/${raw}?width=400`;
}

/** @returns {string} the public page a user would open in a browser. */
export function janitorPublicUrl(id) {
    return `https://janitorai.com/characters/${String(id ?? '').trim()}`;
}

/**
 * Why a card cannot be imported, or null when it can.
 *
 * `is_proxy_enabled: false` is not cosmetic: the capture drives the site's own
 * proxy path, so those cards answer 403 (Glaze: `allow_proxy` false ⇒ 403) and
 * the whole browser dance would be wasted. Measured on 2026-11-24: 10–24 of
 * every 34 cards per sort. Detected up front, never discovered afterwards.
 * @param {Record<string, any>} meta detail payload (or listing row)
 * @returns {'missing'|'deleted'|'private'|'unproxyable'|null}
 */
export function janitorBlockReason(meta) {
    if (!meta || typeof meta !== 'object') return 'missing';
    if (meta.is_deleted === true || meta.is_force_remove === true) return 'deleted';
    if (meta.is_public === false) return 'private';
    const proxy = meta.is_proxy_enabled ?? meta.allow_proxy;
    if (proxy === false) return 'unproxyable';
    return null;
}

/**
 * Whether the definition is readable without the capture.
 *
 * Glaze: `showdefinition == true` **and** a non-empty `personality` or
 * `scenario` (janitor_extractor.dart). Both halves matter — a card can advertise
 * `showdefinition` and still send empty fields.
 * @param {Record<string, any>|null|undefined} meta
 * @returns {boolean}
 */
export function janitorDefinitionPublic(meta) {
    if (!meta || typeof meta !== 'object') return false;
    if (meta.showdefinition !== true) return false;
    const filled = value => typeof value === 'string' && value.trim().length > 0;
    return filled(meta.personality) || filled(meta.scenario);
}

/**
 * Classify a card for the UI and for the import route.
 * @param {Record<string, any>|null|undefined} meta
 * @returns {'public'|'closed'|'unproxyable'|'deleted'|'private'|'missing'}
 */
export function janitorCardState(meta) {
    const blocked = janitorBlockReason(meta);
    if (blocked) return blocked;
    return janitorDefinitionPublic(meta) ? 'public' : 'closed';
}

/**
 * Strip tags from the catalog bio, Glaze's `_htmlToText`.
 *
 * Only a fallback: the browser-side converter (public/scripts/extensions/
 * weavers-vault/janitor-html.js) keeps the formatting. This exists so an
 * import can never carry raw markup into a field when the converter is
 * unavailable.
 * @param {string} html
 * @returns {string}
 */
export function janitorHtmlToText(html) {
    return String(html ?? '')
        .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Comparison key for a tag: letters and digits only, lowercased.
 *
 * JanitorAI's curated tags are emoji-prefixed (`👩‍🦰 Female`) while custom tags are
 * free text (`Female`, `attackontitan`), so raw equality keeps both and the card
 * ends up with two chips for one concept.
 * @param {string} tag
 * @returns {string}
 */
export function janitorTagKey(tag) {
    return String(tag ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Map a detail payload to card fields, exactly as Glaze does.
 *
 * The one that matters: the card body is `personality`, **not** the listing's
 * `description` (which is only the public bio and goes to `creator_notes`).
 * Glaze leaves the emitted `personality` empty, since the body already holds it.
 * @param {Record<string, any>} meta
 * @param {{body?: string}} [overrides] `body` is the recovered definition text
 *   (capture path); when absent the public `personality`/`scenario` are used.
 * @returns {{name: string, description: string, personality: string, scenario: string,
 *   first_mes: string, mes_example: string, creator_notes: string, creator: string,
 *   creatorId: string, tags: string[], alternate_greetings: string[]}}
 */
/** Keep the first spelling of each tag, comparing by `janitorTagKey`. */
function dedupeTags(tags) {
    const seen = new Set();
    const out = [];
    for (const tag of tags) {
        const key = janitorTagKey(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

export function janitorCardFields(meta, { body = '' } = {}) {
    const source = meta && typeof meta === 'object' ? meta : {};
    const text = value => (typeof value === 'string' ? value : '');
    const firstMessages = Array.isArray(source.first_messages)
        ? source.first_messages.filter(item => typeof item === 'string' && item.trim())
        : [];
    const primaryFirst = text(source.first_message) || firstMessages[0] || '';
    const tags = [
        ...(Array.isArray(source.tags) ? source.tags.map(tag => (typeof tag === 'string' ? tag : tag?.name ?? tag?.slug ?? '')) : []),
        ...(Array.isArray(source.custom_tags) ? source.custom_tags.filter(tag => typeof tag === 'string') : []),
    ].map(tag => String(tag).trim()).filter(Boolean);

    return {
        name: text(source.name) || text(source.chat_name),
        // The body: recovered text when we have it, otherwise the public one.
        description: text(body) || text(source.personality),
        // Glaze always emits an empty personality; the body already carries it.
        personality: '',
        scenario: text(source.scenario),
        first_mes: primaryFirst,
        mes_example: text(source.example_dialogs) || text(source.mes_example),
        // The listing `description` is a public bio, never the card body.
        creator_notes: janitorHtmlToText(text(source.description)),
        creator: text(source.creator_name) || text(source.creator),
        creatorId: text(source.creator_id),
        tags: dedupeTags(tags),
        alternate_greetings: [...new Set(firstMessages.slice(1).filter(Boolean))],
    };
}

/**
 * The finished card, provenance included.
 *
 * The provenance rides *inside* the PNG the same way it does for JannyAI: the
 * import path then never has to stamp afterwards, and stamping is precisely
 * where imports used to get blanked (see PITFALLS). `vault_url` is the canonical
 * public page, so a provenance-based cleanup can match one file exactly.
 * @param {Record<string, any>} meta detail payload
 * @param {{body?: string, avatarUrl?: string, retrievedAt?: string}} [options]
 * @returns {{spec: string, spec_version: string, data: Record<string, any>}}
 */
export function janitorCardCharacter(meta, { body = '', avatarUrl = '', retrievedAt = new Date().toISOString() } = {}) {
    const id = String(meta?.id ?? '').trim();
    const fields = janitorCardFields(meta, { body });
    const counts = meta?.token_counts && typeof meta.token_counts === 'object' ? meta.token_counts : {};
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            ...fields,
            system_prompt: '',
            post_history_instructions: '',
            character_book: null,
            character_version: '',
            extensions: {
                vault_source: 'janitor',
                vault_full_path: id,
                vault_url: janitorPublicUrl(id),
                janitor: {
                    characterId: id,
                    creatorId: fields.creatorId,
                    totalTokens: Number(counts.total_tokens ?? meta?.total_tokens ?? 0) || 0,
                    showDefinition: meta?.showdefinition === true,
                    proxyEnabled: (meta?.is_proxy_enabled ?? meta?.allow_proxy) !== false,
                    avatarUrl: String(avatarUrl || meta?.avatar || ''),
                    retrievedAt,
                },
            },
        },
    };
}

/**
 * Read the signed-in account out of `/hampter/profiles/mine`.
 *
 * Verified shape (measured): the payload is an object with `id`/`handle`/`name`
 * variants depending on the endpoint version, so accept all three rather than
 * pinning one.
 * @param {unknown} payload
 * @returns {{signedIn: boolean, name: string, id: string}}
 */
export function janitorAccount(payload) {
    const source = payload && typeof payload === 'object' ? (payload.data && typeof payload.data === 'object' ? payload.data : payload) : null;
    if (!source) return { signedIn: false, name: '', id: '' };
    const id = String(source.id ?? source.user_id ?? '').trim();
    // `user_name` is the handle the site shows on reviews and profiles; an account
    // whose display `name` is empty reports as nameless without it (measured on a
    // second account: 200 with a real id, name '').
    // First *non-empty* candidate: `??` alone does not skip `name: ''`, which is
    // exactly the shape a second account had (200, real id, empty display name).
    const name = [source.name, source.display_name, source.handle, source.username, source.user_name]
        .map(value => String(value ?? '').trim())
        .find(value => value.length > 0) ?? '';
    return { signedIn: Boolean(id || name), name, id };
}

/**
 * Turn a failed read into something the UI can act on.
 *
 * `signed-out` is separate from `challenge` on purpose: the account is the fix
 * for one and the browser window is the fix for the other, and telling the user
 * the wrong one wastes their time.
 * @param {{status: number, body?: string, challenged?: boolean}} result
 * @returns {{code: string, status: number, message: string}}
 */
export function classifyJanitorError({ status, body = '', challenged = false } = {}) {
    if (challenged) {
        return {
            code: 'janitor_challenge',
            status: 403,
            message: 'JanitorAI asked for a browser check that has not finished. Show the browser window, finish it there, then retry.',
        };
    }
    if (status === 401 || status === 403) {
        return {
            code: 'janitor_signed_out',
            status: 401,
            message: 'JanitorAI needs you to sign in. Use "Sign in to JanitorAI", finish in the window, then retry.',
        };
    }
    if (status === 429) {
        return {
            code: 'janitor_rate_limited',
            status: 429,
            message: 'JanitorAI is rate limiting this connection. Wait a little before retrying.',
        };
    }
    if (status === 404) {
        return {
            code: 'janitor_missing',
            status: 404,
            message: 'JanitorAI does not know this character (404). It may have been deleted.',
        };
    }
    if (status <= 0) {
        return {
            code: 'janitor_unreachable',
            status: 502,
            message: `JanitorAI could not be reached${body ? `: ${String(body).slice(0, 160)}` : '.'}`,
        };
    }
    return {
        code: 'janitor_error',
        status: 502,
        message: `JanitorAI answered HTTP ${status}.`,
    };
}

/**
 * Normalise one listing row into the shape the vault grid expects.
 *
 * The listing row carries no definition and no tag names — only `tag_id`s, a
 * blurb in `description`, and `showdefinition`/`is_proxy_enabled` flags — so the
 * card can say "closed" before anything is imported.
 * @param {Record<string, any>} row
 * @returns {object}
 */
export function normalizeJanitorRow(row) {
    const source = row && typeof row === 'object' ? row : {};
    const stats = source.stats && typeof source.stats === 'object' ? source.stats : {};
    const id = String(source.id ?? '').trim();
    const cardTags = [];
    const customTags = Array.isArray(source.custom_tags) ? source.custom_tags : [];
    const tagIds = Array.isArray(source.tags) ? source.tags.map(tag => String(tag?.id ?? tag ?? '')).filter(Boolean) : [];
    return {
        source: 'janitor',
        id,
        name: String(source.name ?? '').trim(),
        url: janitorPublicUrl(id),
        // Public bio, HTML: the converter keeps its formatting for creator notes.
        blurb: String(source.description ?? '').slice(0, 600),
        avatar: janitorAvatarUrl(source.avatar ?? source.image),
        creator: String(source.creator_name ?? source.creator ?? ''),
        creatorId: String(source.creator_id ?? ''),
        tags: cardTags,
        customTags,
        tagIds,
        nsfw: source.is_nsfw === true,
        // A listing row carries `total_tokens`; a detail payload carries it under
        // `token_counts` and leaves the flat field undefined (measured: a public
        // card reported 0 tokens while token_counts.total_tokens was 2742).
        tokens: Number(
            source.total_tokens
            ?? stats.total_tokens
            ?? (source.token_counts && source.token_counts.total_tokens)
            ?? 0,
        ) || 0,
        chats: Number(stats.chat ?? 0) || 0,
        messages: Number(stats.message ?? 0) || 0,
        showDefinition: source.showdefinition === true,
        proxyEnabled: (source.is_proxy_enabled ?? source.allow_proxy) !== false,
    };
}
