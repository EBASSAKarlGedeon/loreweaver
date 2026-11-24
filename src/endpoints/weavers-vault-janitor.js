import { convertJanitorBio } from './weavers-vault-janitor-html.js';

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
 * Only a fallback: `janitorBioToNotes` converts the bio with
 * `weavers-vault-janitor-html.js` and keeps its formatting. This exists so that
 * a bio the converter cannot parse still reaches the card as readable text
 * rather than as raw markup.
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

/**
 * A listing row → the grid's item shape.
 *
 * The vault's grid, kebab menu and detail path all key items by `fullPath` and
 * read `avatarUrl`/`description`/`chatCount`; JannyAI's hits use exactly those
 * names (see `normalizeJannyHit`). Aliasing here keeps the renderer free of
 * per-source branches instead of teaching it a second vocabulary.
 * @param {object} row
 */
export function normalizeJanitorHit(row) {
    const item = normalizeJanitorRow(row);
    const created = Date.parse(String(row?.created_at ?? ''));
    return {
        ...item,
        fullPath: item.id,
        // The grid draws a one-line blurb as text; the HTML belongs to the sheet.
        description: janitorHtmlToText(item.blurb),
        avatarUrl: item.avatar,
        chatCount: item.chats,
        createdAt: Number.isFinite(created) ? created : 0,
    };
}

/**
 * Resolve the sheet's tag *names* to the site's numeric tag ids.
 *
 * The filter sheet is source-agnostic and stores names (the user picks what the
 * site calls a tag, e.g. "⚔️ Enemies to Lovers"); the listing API only accepts
 * `tag_id[]` numbers. Unknown names are dropped and reported, so a stale
 * selection cannot turn into a silent no-op filter.
 * @param {string[]} names
 * @param {Array<{id: number|string, name: string, slug: string}>} catalog
 * @returns {{ids: string[], unknown: string[]}}
 */
export function resolveJanitorTagIds(names, catalog) {
    const ids = [];
    const unknown = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const lower = name.toLowerCase();
        const found = (catalog ?? []).find(tag =>
            String(tag.name ?? '').toLowerCase() === lower
            || String(tag.slug ?? '').toLowerCase() === lower);
        if (found) ids.push(String(found.id));
        else unknown.push(name);
    }
    return { ids: [...new Set(ids)], unknown };
}

/**
 * The bio, converted and credited.
 *
 * The author name is passed in; the profile URL is taken from the bio's own
 * profile link, exactly as janitor2st.py's `_extract_author` does — the detail
 * payload carries no profile URL (`creator_display_prefs` is null, measured), so
 * inventing `https://janitorai.com/profiles/<uuid>` would ship a dead link.
 * @param {string} html
 * @param {string} author
 * @returns {string}
 */
export function janitorBioToNotes(html, author = '') {
    const source = String(html ?? '').trim();
    if (!source) return '';
    try {
        return convertJanitorBio(source, { author }).html;
    } catch (error) {
        // A bio the converter cannot read must still reach the card as text.
        console.warn("[Weaver's Vault] janitor bio conversion failed, using plain text:", error.message);
        return janitorHtmlToText(source);
    }
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
        // The listing `description` is a public bio, never the card body. It keeps
        // its formatting: the converter is a port of the user's own janitor2st.py
        // (see janitor-html.js), which is what ~40 manual conversions settled on.
        creator_notes: janitorBioToNotes(text(source.description), text(source.creator_name) || text(source.creator)),
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
    const customTags = Array.isArray(source.custom_tags) ? source.custom_tags : [];
    // The site sends full tag objects (`{id, name: "👨 Male", slug}`), not ids, so
    // leaving `tags` empty made every grid card render without its chips.
    const cardTags = Array.isArray(source.tags)
        ? source.tags.map(tag => String((tag && typeof tag === 'object' ? tag.name ?? tag.slug : tag) ?? '').trim()).filter(Boolean)
        : [];
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

// ─── Lorebooks (`scripts[]`) — S8 ────────────────────────────────────────────
//
// Measured 2026-11-26, 15 requests total. A character's `scripts[]` entry:
//
//   {"type":"lorebook","id":"47c1eed5-f087-4777-a8ed-e37f0c3990b5",
//    "title":"Heroes and Villains","description":"Information about heroes and
//    Villains in this RPG","theme":"red","user_id":"…","user_name":"1Reika2",
//    "is_public":true,"updated_at":"2026-08-08T18:57:45.762+00:00",
//    "message_count":51336}
//
// and `GET /hampter/script/{id}` answers 200 with a `script` field that is a
// JSON **array inside a string**; its entries carry
// `category,content,enabled,id,key,keysRaw,minMessages,priority,probability,
//  insertion_order,keywordsRaw,constant`.
//
// Two measured facts drive the classification below:
//   * `is_public:false` books cannot be downloaded — the same route answers
//     404 {"message":"script not found"} — so they are closed, and no request
//     is spent proving it.
//   * a transport failure is NOT a closed book. Glaze's `!accessible && !isJs`
//     folds every failure into "private"; here a failure stays a failure with
//     its reason, so the UI can say what broke.

/** Script `type`s that denote a lorebook (measured: `lorebook`; `advanced` is
 *  Glaze's newer Nine-API shape and is kept so it is classified, not dropped). */
export const JANITOR_SCRIPT_TYPES = Object.freeze(['lorebook', 'advanced']);

/**
 * One lorebook (`script`) record. Measured: a public book answers 200 here with
 * the entries as a JSON array inside `script`; a private one answers 404
 * `{"message":"script not found"}`.
 * @param {string} id script id from the card's `scripts[]`
 * @returns {string}
 */
export function janitorScriptUrl(id) {
    return `${JANITOR_API}/script/${encodeURIComponent(String(id ?? ''))}`;
}

/**
 * The lorebook references attached to a character.
 * @param {any} meta a `/hampter/characters/{id}` payload
 * @returns {Array<{id: string, title: string, description: string, type: string, isPublic: boolean}>}
 */
export function janitorLorebookRefs(meta) {
    const scripts = meta?.scripts;
    // A card with no books sends `scripts: []` (measured); a closed card may
    // send null. Both mean "no books".
    if (!Array.isArray(scripts)) return [];
    const seen = new Set();
    const out = [];
    for (const script of scripts) {
        if (!script || typeof script !== 'object') continue;
        const id = String(script.id ?? '').trim();
        if (!id || seen.has(id)) continue;
        const type = String(script.type ?? '').trim().toLowerCase();
        if (!JANITOR_SCRIPT_TYPES.includes(type)) continue;
        seen.add(id);
        out.push({
            id,
            title: String(script.title ?? '').trim(),
            description: String(script.description ?? '').trim(),
            type,
            // Guard against a site that sends 0/1 or "true" instead of a boolean.
            isPublic: script.is_public !== false && script.is_public !== 0 && script.is_public !== 'false',
        });
    }
    return out;
}

/** Keys of a JanitorAI entry, in the order Glaze accepts them. */
function janitorKeysOf(value) {
    if (Array.isArray(value)) {
        return value.map(k => String(k ?? '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map(k => k.trim()).filter(Boolean);
    }
    return [];
}

function janitorNumberOf(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pull the entries (or the JavaScript source) out of a `/hampter/script/{id}`
 * record. Measured: `script` is a string holding a JSON array. A "advanced" /
 * Nine-API book ships JavaScript instead — that shape is UNMEASURED, so it is
 * detected defensively (anything non-JSON is treated as source) rather than
 * assumed.
 * @param {any} record
 * @returns {{entries: any[], jsSource: string}}
 */
export function janitorScriptEntries(record) {
    const raw = record?.script;
    if (Array.isArray(raw)) return { entries: raw, jsSource: '' };
    if (typeof raw !== 'string') return { entries: [], jsSource: '' };
    const text = raw.trim();
    if (!text) return { entries: [], jsSource: '' };
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? { entries: parsed, jsSource: '' } : { entries: [], jsSource: '' };
    } catch {
        // Not JSON: script source (the scripted/advanced path).
        return { entries: [], jsSource: text };
    }
}

/**
 * Classify one lorebook reference against its fetch result.
 *
 * `kind` is one of:
 *   `public`   — structured entries, convertible with no LLM
 *   `scripted` — public source that is JavaScript; needs an LLM rebuild
 *   `closed`   — the site says we cannot have it (private, or empty)
 *   `failed`   — we could not find out; `reason` says what broke
 *
 * `failed` is never collapsed into `closed`: a transport error is reported as a
 * transport error. Glaze's `!accessible && !isJs` hides exactly this.
 * @param {{id: string, title: string, isPublic: boolean}} ref
 * @param {{status?: number, body?: string, challenged?: boolean, error?: Error|string|null}} [result]
 * @returns {{id: string, title: string, kind: 'public'|'scripted'|'closed'|'failed',
 *            reason: string, entries: any[], jsSource: string, entryCount: number}}
 */
export function classifyJanitorLorebook(ref, result = {}) {
    const base = {
        id: String(ref?.id ?? ''),
        title: String(ref?.title ?? '').trim(),
        entries: [],
        jsSource: '',
        entryCount: 0,
    };
    // Known-private books are closed on the ref's own word — no request spent.
    if (ref?.isPublic === false) return { ...base, kind: 'closed', reason: 'private' };

    const status = Number(result?.status ?? 0);
    const body = String(result?.body ?? '');

    if (result?.error || status === -1) {
        return { ...base, kind: 'failed', reason: 'transport' };
    }
    if (result?.challenged) {
        return { ...base, kind: 'failed', reason: 'challenge' };
    }
    if (status === 401 || status === 403) {
        // A public book must not need an identity: this is our session, not the book.
        return { ...base, kind: 'failed', reason: 'signed-out' };
    }
    if (status === 429) {
        return { ...base, kind: 'failed', reason: 'rate-limited' };
    }
    if (status === 404) {
        // Measured bodies: a record we may not have is
        // {"message":"script not found","statusCode":404} (47 bytes), a missing
        // route is Express's "Cannot GET …". Either way a *public* ref that 404s
        // is a contract failure, never "closed".
        const denied = /script not found/i.test(body);
        return { ...base, kind: 'failed', reason: denied ? 'script-denied' : 'script-missing' };
    }
    if (status < 200 || status >= 300) {
        return { ...base, kind: 'failed', reason: status >= 500 ? 'server' : `http-${status}` };
    }

    let record = null;
    try {
        record = JSON.parse(body);
    } catch {
        return { ...base, kind: 'failed', reason: 'unparseable' };
    }

    const { entries, jsSource } = janitorScriptEntries(record);
    if (jsSource) return { ...base, kind: 'scripted', reason: '', jsSource };
    const usable = entries.filter(entry => String(entry?.content ?? entry?.text ?? '').trim());
    if (!usable.length) {
        // The site answered and the book has nothing to convert.
        return { ...base, kind: 'closed', reason: 'no-entries' };
    }
    return {
        ...base,
        kind: 'public',
        reason: '',
        entries,
        entryCount: usable.length,
        // Measured: the ref already carries the description, so the book's own
        // HTML page (which Glaze fetches and double-decodes) is not needed.
        description: String(record?.description ?? '').trim() || String(ref?.description ?? '').trim(),
    };
}

/**
 * `<character> — <book>`, the World Info name the plan asks for.
 * @param {string} characterName
 * @param {string} bookTitle
 * @returns {string}
 */
export function janitorLorebookName(characterName, bookTitle) {
    const character = String(characterName ?? '').trim();
    const book = String(bookTitle ?? '').trim();
    if (!character) return book || 'JanitorAI Lorebook';
    if (!book) return character;
    return `${character} — ${book}`;
}

/**
 * Where a JanitorAI entry goes, in characterBook vocabulary (`before_char` /
 * `after_char`) — what `convertCharacterBook` understands.
 *
 * Measured entries carry neither `position` nor `placement`, so the default is
 * "after". `placement`/`placementPosition` are honoured when a book sends them
 * (they write the entry into a card field; the nearest SillyTavern slot is the
 * same side of the definition). Depth is not expressible in a characterBook
 * entry, so an `at_depth` position degrades to "after" — as in Glaze's converter.
 */
function janitorCharacterBookPosition(entry) {
    const placement = entry?.placement;
    if (placement != null && placement !== 'default') {
        return String(entry?.placementPosition ?? '').toLowerCase() === 'before'
            ? 'before_char'
            : 'after_char';
    }
    const position = entry?.position;
    if (typeof position === 'number') {
        return [0, 2, 4].includes(position) ? 'before_char' : 'after_char';
    }
    if (typeof position === 'string') {
        const p = position.toLowerCase();
        if (p === 'before_char' || p === 'before_character') return 'before_char';
    }
    return 'after_char';
}

/**
 * JanitorAI script entries → a characterBook-shaped book.
 *
 * The shape is deliberate: the client feeds this to the host's own
 * `convertCharacterBook` (world-info.js:5498) and then `saveWorldInfo`, exactly
 * as the chub lorebook path does. SillyTavern's entry template therefore stays
 * the single source of truth for what a World Info entry contains — a hand-built
 * entry would silently miss every field ST adds next.
 *
 * `id` is assigned by index: JanitorAI entry ids are UUIDs (measured), while
 * `convertCharacterBook` uses `entry.id` as the numeric `uid`.
 * @param {any[]} entries
 * @param {{name?: string}} [options]
 * @returns {{name: string, entries: object[]}}
 */
export function janitorScriptToCharacterBook(entries, { name = '' } = {}) {
    const out = [];
    const source = Array.isArray(entries) ? entries : [];
    for (const entry of source) {
        if (!entry || typeof entry !== 'object') continue;
        const content = String(entry.content ?? entry.text ?? '').trim();
        if (!content) continue;
        const constant = entry.constant === true;
        const rawProbability = janitorNumberOf(entry.probability);
        // JanitorAI sends 100; older books send a fraction. The contract is
        // 0-100 either way (the same rule Glaze applies).
        const probability = rawProbability == null
            ? 100
            : Math.max(0, Math.min(100, rawProbability > 0 && rawProbability <= 1
                ? Math.round(rawProbability * 100)
                : Math.round(rawProbability)));
        const index = out.length;
        const extensions = { display_index: index };
        if (rawProbability != null) extensions.probability = probability;
        if (entry.case_sensitive !== undefined) extensions.case_sensitive = entry.case_sensitive === true;
        if (entry.match_whole_words !== undefined) extensions.match_whole_words = entry.match_whole_words === true;
        if (entry.prevent_recursion !== undefined) extensions.prevent_recursion = entry.prevent_recursion === true;
        if (entry.exclude_recursion !== undefined) extensions.exclude_recursion = entry.exclude_recursion === true;

        out.push({
            id: index,
            keys: janitorKeysOf(entry.key ?? entry.keys ?? entry.keysRaw ?? entry.keywords),
            secondary_keys: janitorKeysOf(entry.keysecondary ?? entry.secondary_keys ?? entry.keySecondary),
            comment: String(entry.comment ?? entry.title ?? entry.name ?? entry.category ?? `Entry ${index}`).trim(),
            content,
            enabled: entry.enabled !== false && entry.disable !== true,
            constant,
            selective: !constant,
            insertion_order: janitorNumberOf(entry.insertion_order ?? entry.priority ?? entry.order) ?? 100,
            position: janitorCharacterBookPosition(entry),
            extensions,
        });
    }
    return { name: String(name ?? ''), entries: out };
}

