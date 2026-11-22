/**
 * M5 · DataCat (datacat.run) Client API — pure port of Glaze's
 * `lib/features/catalog/services/datacat/*` (AGPL-3.0).
 *
 * Everything here is side-effect free and dependency free so the request
 * shaping and the card reader can be unit-tested without a server, a secret
 * store or a network. The route layer in weavers-vault.js owns I/O.
 *
 * Contract notes that cost Glaze real debugging time and are preserved:
 *  - `installationId` is a required *body* field on all four device-flow POSTs
 *    (link start/token, verification start/token), not just a header. Sending
 *    only the header is a 400 and makes every flow fail.
 *  - The lease header alone is refused: it must be accompanied by the
 *    installation id, or the server reports `verificationReason: "missing"`.
 *  - The transfer action is `character-import`. The vendored contract says
 *    `character_transfer` and the live server 400s on it, so the value is read
 *    from `/capabilities` when advertised.
 */

export const DATACAT_BASE = 'https://datacat.run/api/client/v1';
export const DATACAT_CLIENT_NAME = 'Weaver\'s Vault';
export const DATACAT_MAX_OFFSET = 10000;
export const DATACAT_MAX_TAG_LIMIT = 500;
export const DATACAT_NSFW_TAG_ID = 2;
export const DATACAT_TRANSFER_ACTION = 'character-import';
export const DATACAT_LEASE_CHARACTER_BUDGET = 20;

export const DATACAT_CLIENT_ID_MISSING_MESSAGE =
    'DataCat needs a client id before it can be browsed. Paste one in the DataCat settings.';

/** Installation id contract: 16–160 chars of [A-Za-z0-9._:-]. */
export function isValidInstallationId(id) {
    return typeof id === 'string'
        && id.length >= 16
        && id.length <= 160
        && /^[A-Za-z0-9._:-]+$/.test(id);
}

export function makeInstallationId(randomBytes) {
    // crypto.randomUUID() output is a valid id by construction (36 chars,
    // hyphens only), but the shape is spelled out so a caller-supplied
    // generator can be tested too.
    const hex = [...randomBytes(16)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The body every device-flow POST carries. `extra` merges last so a caller can
 * add `deviceCode` or `action`.
 */
export function deviceBody(installationId, extra = {}) {
    return {
        installationId,
        clientName: DATACAT_CLIENT_NAME,
        clientVersion: '1.0.0',
        ...extra,
    };
}

/**
 * Header set for a request.
 * @param {{clientId?: string, userToken?: string, lease?: string,
 *          installationId?: string, withInstallationId?: boolean}} auth
 */
export function datacatHeaders(auth = {}) {
    const headers = { Accept: 'application/json' };
    if (auth.clientId) headers['X-Datacat-Client-Id'] = auth.clientId;
    if (auth.userToken) headers.Authorization = `Bearer ${auth.userToken}`;
    if (auth.lease) headers['X-Datacat-Verification-Lease'] = auth.lease;
    // A linked user token is only usable together with the installation id it
    // was bound to, and a lease silently degrades to "missing" without it.
    if (auth.withInstallationId || auth.userToken) {
        if (auth.installationId) headers['X-Datacat-Installation-Id'] = auth.installationId;
    }
    return headers;
}

/**
 * Builds `base + path?query`, dropping null/empty values and joining lists with
 * commas (every list param is comma-separated, not repeated).
 */
export function datacatUrl(pathname, query = {}) {
    const parts = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined) continue;
        const text = Array.isArray(value) ? value.join(',') : String(value);
        if (text === '') continue;
        parts.push(`${key}=${encodeURIComponent(text)}`);
    }
    return parts.length ? `${DATACAT_BASE}${pathname}?${parts.join('&')}` : `${DATACAT_BASE}${pathname}`;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * `/capabilities`, with the documented defaults for anything absent. A failed
 * read is not fatal: the defaults are what the API has always answered with.
 */
export function parseCapabilities(json) {
    const paging = json?.paging ?? {};
    const features = json?.features ?? {};
    const security = json?.securityCheck ?? json?.verification ?? {};
    const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const maxPageSize = int(paging.maxPageSize, 24);
    const actions = Array.isArray(security.actions) ? security.actions.filter(a => typeof a === 'string' && a) : [];
    const leaseSeconds = int(security.leaseTtlSeconds, 0);
    const feature = (name) => (typeof features[name] === 'boolean' ? features[name] : true);
    return {
        defaultPageSize: int(paging.defaultPageSize, maxPageSize),
        maxPageSize,
        listing: feature('listing'),
        tagBrowsing: feature('tagBrowsing'),
        social: feature('social'),
        securityCheckEnabled: security.enabled !== false,
        verificationActions: actions,
        leaseTtlSeconds: leaseSeconds > 0 ? leaseSeconds : 1800,
    };
}

export function verificationAction(caps) {
    return caps?.verificationActions?.length ? caps.verificationActions[0] : DATACAT_TRANSFER_ACTION;
}

// ---------------------------------------------------------------------------
// Sort / window
// ---------------------------------------------------------------------------

export const DATACAT_SORT_FIELDS = ['fresh', 'score', 'chat_count', 'messages_per_chat', 'first_published'];
export const DATACAT_WINDOWS = ['all', 'week', '24h'];

/** Pre-Client-API sort keys still sitting in a saved preference. */
const LEGACY_SORTS = {
    recent: ['fresh', 'all'],
    score_week: ['score', 'week'],
    score_24h: ['score', '24h'],
    chat_count_week: ['chat_count', 'week'],
    chat_count_24h: ['chat_count', '24h'],
};

/**
 * Resolves a stored sort/window pair. A current field always wins over the
 * legacy table: `fresh` is both today's field and yesterday's windowless label,
 * and reading it as the legacy key would pin the feed to all-time.
 */
export function resolveSort(sort, window) {
    if (DATACAT_SORT_FIELDS.includes(sort)) {
        return { field: sort, window: DATACAT_WINDOWS.includes(window) ? window : 'all' };
    }
    const legacy = LEGACY_SORTS[sort];
    if (legacy) return { field: legacy[0], window: legacy[1] };
    return { field: DATACAT_SORT_FIELDS[0], window: 'all' };
}

// ---------------------------------------------------------------------------
// Listing requests
// ---------------------------------------------------------------------------

/**
 * Query for `/characters` (plain browse and search are the same endpoint).
 * @param {{query?: string, offset?: number, limit?: number, sort?: string,
 *          window?: string, tagIds?: number[], nsfw?: boolean, maxPageSize?: number}} opts
 */
export function charactersQuery(opts = {}) {
    const sort = resolveSort(opts.sort, opts.window);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 24, Number(opts.maxPageSize) || 24));
    const offset = Math.max(0, Math.min(Number(opts.offset) || 0, DATACAT_MAX_OFFSET));
    return {
        endpoint: '/characters',
        query: {
            search: opts.query || null,
            tagIds: Array.isArray(opts.tagIds) && opts.tagIds.length ? opts.tagIds.slice(0, 24) : null,
            blockedTagIds: opts.nsfw ? null : [DATACAT_NSFW_TAG_ID],
            sort: sort.field,
            limit,
            offset,
        },
    };
}

/**
 * Query for `/fresh`, which pages its two windows on separate offsets and takes
 * no tag/NSFW parameters at all — filters are applied to the rows instead.
 */
export function freshQuery(opts = {}) {
    const sort = resolveSort(opts.sort, opts.window);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 24, Number(opts.maxPageSize) || 24));
    const offset = Math.max(0, Math.min(Number(opts.offset) || 0, DATACAT_MAX_OFFSET));
    const is24h = sort.window === '24h';
    return {
        endpoint: '/fresh',
        query: {
            sort: sort.field,
            limit,
            offset24: is24h ? offset : 0,
            offsetWeek: is24h ? 0 : offset,
        },
        windowKey: is24h ? 'last24h' : 'thisWeek',
    };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * One `CharacterSummary` → the extension's catalog row shape (mirrors
 * `datacatItemFromSummary`). The SFW/NSFW chip is derived from the `nsfw` flag
 * rather than prepended from a tag that may or may not be present.
 */
export function normalizeSummary(json = {}) {
    const nsfw = json.nsfw === true;
    const tags = [];
    for (const t of Array.isArray(json.tags) ? json.tags : []) {
        const name = typeof t === 'string' ? t : String(t?.name ?? t?.slug ?? '');
        if (name) tags.push(name);
    }
    const creator = json.creator ?? {};
    const stats = json.stats ?? {};
    const name = String(json.name ?? '');
    const chatName = String(json.chatName ?? '');
    return {
        id: String(json.id ?? ''),
        name: name || chatName || 'Unknown',
        avatarUrl: json.avatarUrl ?? json.image?.url ?? '',
        description: json.description ?? '',
        tags: [...new Set([nsfw ? 'NSFW' : 'SFW', ...tags])],
        tokens: Number(json.totalTokens ?? 0) || 0,
        chatCount: Number(stats.chats ?? 0) || 0,
        messageCount: Number(stats.messages ?? 0) || 0,
        creator: String(creator.name ?? ''),
        creatorId: String(creator.id ?? ''),
        sourceKind: String(json.sourceKind ?? ''),
        nsfw,
        source: 'datacat',
    };
}

/**
 * Applies the filters a listing could not be asked for server-side: adult rows
 * when NSFW is off, and rows missing a required tag. Only ever removes — the
 * paging cursor is left as the server set it, so a short page stays short.
 */
export function applyClientFilters(items, { nsfw = false, requiredTagNames = [] } = {}) {
    if (nsfw && !requiredTagNames.length) return items;
    const required = requiredTagNames.map(t => t.toLowerCase());
    return items.filter(item => {
        if (!nsfw && item.nsfw) return false;
        if (!required.length) return true;
        const tags = new Set(item.tags.map(t => t.toLowerCase()));
        return required.every(t => tags.has(t));
    });
}

/** Reads `{characters, paging}` (or a `/fresh` window object) into rows + cursor. */
export function parseListing(data = {}, charactersKey = 'characters') {
    const paging = data.paging ?? {};
    const rows = Array.isArray(data[charactersKey]) ? data[charactersKey] : [];
    const items = rows.map(normalizeSummary);
    const offset = Number(paging.offset ?? 0) || 0;
    return {
        items,
        total: Number(paging.total ?? 0) || 0,
        hasMore: Boolean(paging.hasMore),
        nextOffset: Number(paging.nextOffset ?? offset + items.length) || 0,
    };
}

/**
 * A Character Card V2 body → the extension's card shape. Accepts the bare
 * `{spec, data}` envelope, a `{card: …}` wrapper and a `chara_card_v2_json`
 * wrapper — which one arrives is not worth a caller's attention.
 */
export function cardToCharacter(body = {}, { id = '', sourceKind = '' } = {}) {
    const envelope = body?.card && typeof body.card === 'object'
        ? body.card
        : (body?.chara_card_v2_json && typeof body.chara_card_v2_json === 'object' ? body.chara_card_v2_json : body);
    const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data : (envelope ?? {});

    const first = String(data.first_mes ?? '');
    const alternates = [];
    const seen = new Set([first.trim()]);
    for (const g of Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []) {
        if (typeof g === 'string' && g.trim() && !seen.has(g.trim())) {
            alternates.push(g);
            seen.add(g.trim());
        }
    }

    const name = String(data.name ?? '');
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: name || 'Unknown',
            description: String(data.description ?? ''),
            personality: String(data.personality ?? ''),
            scenario: String(data.scenario ?? ''),
            first_mes: first,
            mes_example: String(data.mes_example ?? ''),
            creator_notes: String(data.creator_notes ?? ''),
            system_prompt: String(data.system_prompt ?? ''),
            post_history_instructions: String(data.post_history_instructions ?? ''),
            alternate_greetings: alternates,
            tags: (Array.isArray(data.tags) ? data.tags : []).filter(t => typeof t === 'string' && t),
            creator: String(data.creator ?? ''),
            character_version: String(data.character_version ?? ''),
            extensions: {
                ...(typeof data.extensions === 'object' && data.extensions ? data.extensions : {}),
                vault_source: 'datacat',
                vault_full_path: id,
                vault_url: id ? `https://datacat.run/characters/${encodeURIComponent(id)}` : '',
                ...(sourceKind ? { vault_datacat_source_kind: sourceKind } : {}),
            },
            character_book: data.character_book ?? undefined,
        },
    };
}

// ---------------------------------------------------------------------------
// Lease store (in-memory, like Glaze's DatacatLeaseStore)
// ---------------------------------------------------------------------------

/**
 * Holds the short-lived transfer lease between downloads. One lease covers a
 * number of distinct characters until it expires, so a batch import asks the
 * user to verify once. In memory only: a lease outlives neither the process nor
 * its own expiry.
 */
export class LeaseStore {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.token = null;
        this.expiresAt = 0;
        this.budget = DATACAT_LEASE_CHARACTER_BUDGET;
        this.characters = new Set();
    }

    /** A lease usable for `characterId`, or null when verification is needed. */
    leaseFor(characterId) {
        if (!this.token) return null;
        // A lease with 2s left is one the server will have retired by the time
        // the request lands; asking a moment early beats a guaranteed rejection.
        if (this.now() > this.expiresAt - 10000) return null;
        if (!this.characters.has(characterId) && this.characters.size >= this.budget) return null;
        return this.token;
    }

    store(token, expiresAt, maxUniqueCharacters) {
        this.token = token;
        this.expiresAt = expiresAt;
        this.budget = Number.isFinite(maxUniqueCharacters) && maxUniqueCharacters > 0
            ? maxUniqueCharacters
            : DATACAT_LEASE_CHARACTER_BUDGET;
        this.characters.clear();
    }

    noteUsed(characterId) {
        this.characters.add(characterId);
    }

    invalidate() {
        this.token = null;
        this.expiresAt = 0;
        this.budget = DATACAT_LEASE_CHARACTER_BUDGET;
        this.characters.clear();
    }

    get remainingBudget() {
        return this.token ? this.budget - this.characters.size : 0;
    }
}

/** Reads a device flow (link or verification) out of the API's answer. */
export function parseDeviceFlow(json = {}) {
    const flowId = String(json.linkId ?? json.verificationId ?? '');
    const uri = String(
        json.authorizationUriComplete
        ?? json.verificationUriComplete
        ?? json.authorizationUri
        ?? json.verificationUri
        ?? '',
    );
    const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
        id: flowId,
        deviceCode: String(json.deviceCode ?? ''),
        userCode: json.userCode ?? null,
        uri,
        expiresIn: int(json.expiresIn, 600),
        // The contract's examples poll every 3s; a zero/missing interval spins.
        interval: Math.max(1, int(json.interval, 3)),
    };
}

/**
 * Classifies a failed API answer. `pending` is the server saying "not approved
 * yet" (the contract says 409, the live server uses 428) and is a reason to wait
 * rather than an error; `verificationRequired` means a lease had to be spent.
 */
export function classifyError(status, json = {}) {
    const error = json?.error;
    const code = String(error?.code ?? json?.code ?? '');
    const message = String(error?.message ?? json?.message ?? json?.error ?? '');
    const reason = String(error?.verificationReason ?? json?.verificationReason ?? '');
    const isClientNotApproved = code === 'client_not_approved' || /client.+not.+approved/i.test(message);
    return {
        status,
        code,
        message: message || `DataCat HTTP ${status}`,
        verificationRequired: status === 428
            || code === 'verification_required'
            || reason === 'required'
            || reason === 'missing',
        pending: status === 409 || status === 428,
        isForbidden: status === 403,
        isUnauthorized: status === 401,
        isClientNotApproved,
    };
}
