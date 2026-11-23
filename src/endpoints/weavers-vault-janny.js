/**
 * Weaver's Vault — JannyAI (jannyai.com) adapter, pure logic.
 *
 * Ported from Glaze (AGPL-3.0) `lib/features/catalog/services/janny_provider.dart`
 * and `janny_webview_proxy.dart`. Kept free of I/O so every contract detail is
 * unit-testable: URL shaping, Meilisearch request bodies, the Astro island
 * parser, hit normalisation and the card mapping.
 *
 * Transport split, exactly like Glaze:
 *  - search: plain HTTPS to `search.jannyai.com` (a Meilisearch instance that is
 *    NOT behind Cloudflare), authorised by a public bearer token.
 *  - detail: the character page is behind a Cloudflare managed challenge, so it
 *    must be fetched from inside a real Chromium (see
 *    weavers-vault-janny-browser.js). This module only parses the HTML.
 *  - images: `image.jannyai.com` is unchallenged.
 */

export const JANNY_BASE = 'https://jannyai.com';
export const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
export const JANNY_INDEX = 'janny-characters';
export const JANNY_IMAGE_CDN = 'https://image.jannyai.com/bot-avatars/';

/**
 * Public search token shipped inside jannyai.com's own bundle, kept as a
 * fallback for when scraping a fresh one is impossible. Glaze ships the same
 * constant; when the site rotates it, searches answer 401/403 and the status
 * endpoint reports that instead of failing silently.
 */
export const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';

export const JANNY_CLOSED_MESSAGE =
    'JannyAI refused the request. Its character pages sit behind a Cloudflare managed challenge, which needs a real browser session — check Settings → Weaver\'s Vault → JannyAI.';

/** Sort presets Glaze exposes, mapped to Meilisearch sort clauses. */
export const JANNY_SORTS = {
    newest: ['createdAtStamp:desc'],
    oldest: ['createdAtStamp:asc'],
    tokens_desc: ['totalToken:desc'],
    tokens_asc: ['totalToken:asc'],
    relevant: [],
};

/**
 * Headers the instant-meilisearch client sends. Glaze sends exactly these; the
 * `x-meilisearch-client` value is what the site's own frontend sends, so the
 * index treats us as a first-party client.
 * @param {string} token Bearer search token
 */
export function jannySearchHeaders(token) {
    return {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_BASE,
        'Referer': `${JANNY_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };
}

/**
 * One `multi-search` body. Only what is actually read is asked for: Glaze used
 * to request facets/highlight/crop and each was one more clause the backend
 * could reject with a 400 when its index configuration changed.
 * @param {{query?: string, page?: number, filters?: string[], sort?: string[]}} options
 */
export function jannySearchBody({ query = '', page = 1, filters = [], sort = [] } = {}) {
    return {
        queries: [{
            indexUid: JANNY_INDEX,
            q: query,
            ...(filters.length ? { filter: filters.join(' AND ') } : {}),
            hitsPerPage: 40,
            page,
            ...(sort.length ? { sort } : {}),
        }],
    };
}

/**
 * Degradation ladder for a search. The NSFW clause is never dropped — it is the
 * user's own setting about what they are willing to see — while sort and the
 * token/tag filters are preferences, so a rejected search is retried plainly
 * instead of dying outright.
 * @param {{query?: string, page?: number, nsfw?: boolean, minTokens?: number, maxTokens?: number, tagIds?: (string|number)[], sort?: string}} options
 * @returns {object[]} Bodies to try in order
 */
export function jannySearchAttempts({
    query = '',
    page = 1,
    nsfw = true,
    minTokens = 0,
    maxTokens = 100000,
    tagIds = [],
    sort = 'newest',
} = {}) {
    const mandatory = [];
    if (!nsfw) mandatory.push('isNsfw = false');

    const minTok = minTokens > 0 ? minTokens : 29;
    const preferred = [`totalToken >= ${minTok}`];
    if (maxTokens < 100000) preferred.push(`totalToken <= ${maxTokens}`);
    for (const id of tagIds) preferred.push(`tagIds = ${id}`);

    const sortArr = JANNY_SORTS[sort] ?? JANNY_SORTS.newest;

    const attempts = [jannySearchBody({ query, page, filters: [...mandatory, ...preferred], sort: sortArr })];
    if (sortArr.length) {
        attempts.push(jannySearchBody({ query, page, filters: [...mandatory, ...preferred], sort: [] }));
    }
    if (preferred.length) {
        attempts.push(jannySearchBody({ query, page, filters: mandatory, sort: [] }));
    }
    return attempts;
}

/**
 * First result page of a `multi-search` answer.
 * @param {any} json Parsed response
 * @returns {{hits: object[], total: number, page: number, totalPages: number}}
 */
export function parseJannyMultiSearch(json) {
    const result = json?.results?.[0] ?? {};
    return {
        hits: Array.isArray(result.hits) ? result.hits : [],
        total: Number(result.totalHits ?? 0) || 0,
        page: Number(result.page ?? 1) || 1,
        totalPages: Number(result.totalPages ?? 1) || 1,
    };
}

/**
 * Slug the site uses in character URLs. Identical to Glaze's `_slugify`, then
 * prefixed with `character-` when absent — the page route is
 * `/characters/{id}_{slug}` and the slug is derived from the name.
 * @param {string} text
 */
export function jannySlugify(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

/**
 * Character page URL. The path segment is `{id}_{slug}`; the slug is cosmetic
 * for the route but derived the same way Glaze does so the request matches.
 * @param {string} id Character id (UUID)
 * @param {string} [name]
 */
export function jannyCharacterUrl(id, name = '') {
    let slug = jannySlugify(name || id);
    if (slug && !slug.startsWith('character-')) slug = `character-${slug}`;
    return `${JANNY_BASE}/characters/${String(id).trim()}${slug ? `_${slug}` : ''}`;
}

/** Avatar URL as stored in a hit/document. */
export function resolveJannyAvatar(url) {
    if (!url) return null;
    const value = String(url);
    if (value.startsWith('http')) return value;
    if (!value.includes('/')) return `${JANNY_IMAGE_CDN}${value}`;
    return value;
}

/** Strip tags + the entities the site's own rich text uses. */
export function stripJannyHtml(html) {
    return String(html ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
}

/**
 * Decode one value of an Astro `props` blob, which serialises everything as
 * `[type, data]` pairs: 0 = object, 1 = array, anything else = literal.
 * @param {any} value
 */
export function decodeAstroValue(value) {
    if (!Array.isArray(value)) return value;
    const [type, data] = value;
    if (type === 0) {
        if (data && typeof data === 'object') {
            const decoded = {};
            for (const [key, raw] of Object.entries(data)) decoded[key] = decodeAstroValue(raw);
            return decoded;
        }
        return data;
    }
    if (type === 1 && Array.isArray(data)) return data.map(decodeAstroValue);
    return data;
}

/** The two island selectors Glaze tries, most specific first. */
export function findJannyPropsBlob(html) {
    const source = String(html ?? '');
    const specific = source.match(/astro-island[^>]*component-export="CharacterButtons"[^>]*props="([^"]+)"/);
    if (specific) return specific[1];
    const loose = source.match(/astro-island[^>]*props="([^"]*character[^"]*)"/);
    return loose ? loose[1] : null;
}

/**
 * Parse a character page into the site's own record.
 * @param {string} html Page HTML fetched from inside a real browser session
 * @returns {{character: object, imageUrl: string|null, creatorUsername: string|null}|null}
 */
export function parseJannyCharacterPage(html) {
    const blob = findJannyPropsBlob(html);
    if (!blob) return null;

    const decoded = blob
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");

    let props;
    try {
        props = JSON.parse(decoded);
    } catch {
        return null;
    }

    const character = decodeAstroValue(props.character);
    if (!character || typeof character !== 'object') return null;

    const imageUrl = decodeAstroValue(props.imageUrl);
    const creatorMatch = String(html).match(/Creator:\s*(?:<\/[^>]+>\s*)?<a[^>]*>@?([^<]+)<\/a>/);

    return {
        character,
        imageUrl: typeof imageUrl === 'string' && imageUrl ? resolveJannyAvatar(imageUrl) : null,
        creatorUsername: creatorMatch ? creatorMatch[1].trim() : null,
    };
}

/**
 * Search hit → list item for the extension. The index carries no definition
 * (measured 2026-11-23), only the blurb, so this is display data only.
 * @param {object} hit
 */
export function normalizeJannyHit(hit) {
    const isNsfw = hit?.isNsfw === true;
    return {
        id: String(hit?.id ?? ''),
        name: String(hit?.name ?? 'Unknown').trim() || 'Unknown',
        description: stripJannyHtml(hit?.description),
        avatarUrl: resolveJannyAvatar(hit?.avatar),
        tokens: Number(hit?.totalToken ?? 0) || 0,
        tagIds: Array.isArray(hit?.tagIds) ? hit.tagIds : [],
        nsfw: isNsfw,
        tags: [isNsfw ? 'NSFW' : 'SFW'],
        createdAt: Number(hit?.createdAtStamp ?? 0) || 0,
        source: 'janny',
    };
}

/**
 * The site's record → a `chara_card_v2` card, with the field remapping Glaze
 * documents: Janny keeps the prompt body in `personality` and the public blurb
 * in `description`, so the definition becomes ST's `description` and the blurb
 * becomes `creator_notes`.
 * @param {object} character Parsed Astro character object
 * @param {{id?: string, imageUrl?: string|null, creatorUsername?: string|null, tags?: string[]}} [extra]
 */
export function jannyCardFromCharacter(character, extra = {}) {
    const id = String(extra.id ?? character?.id ?? '').trim();
    const name = String(character?.name ?? 'Unknown').trim() || 'Unknown';
    const creator = String(extra.creatorUsername ?? character?.creatorName ?? character?.creatorId ?? '').trim();
    const firstMes = String(character?.firstMessage ?? '');
    // The island carries real tag names (`tags: [{id, name}]`); ids alone would
    // force the UI to translate them.
    const islandTags = Array.isArray(character?.tags)
        ? character.tags.map(tag => (typeof tag === 'string' ? tag : tag?.name)).filter(Boolean)
        : [];
    const tags = [
        ...(Array.isArray(extra.tags) ? extra.tags.filter(Boolean) : []),
        ...islandTags,
    ].filter((tag, index, all) => all.indexOf(tag) === index);

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            // See layout note: personality = prompt body, description = blurb.
            description: String(character?.personality ?? ''),
            personality: '',
            scenario: String(character?.scenario ?? ''),
            first_mes: firstMes,
            mes_example: String(character?.exampleDialogs ?? ''),
            creator_notes: stripJannyHtml(character?.description),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: null,
            tags: [
                character?.isNsfw === true ? 'NSFW' : 'SFW',
                ...tags.filter(t => t !== 'NSFW' && t !== 'SFW'),
            ],
            creator,
            character_version: '',
            extensions: {
                vault_source: 'janny',
                vault_full_path: id,
                vault_url: id ? `${JANNY_BASE}/characters/${id}` : JANNY_BASE,
                janny: {
                    characterId: id,
                    creatorId: String(character?.creatorId ?? ''),
                    totalToken: Number(character?.totalToken ?? 0) || 0,
                    isNsfw: character?.isNsfw === true,
                    avatarUrl: extra.imageUrl ?? resolveJannyAvatar(character?.avatar),
                    retrievedAt: new Date().toISOString(),
                },
            },
        },
    };
}

/**
 * Whether a fetched page is Cloudflare's interstitial rather than the site.
 * @param {number} status
 * @param {string} body
 */
export function isJannyChallenge(status, body) {
    if (status === 403 || status === 503) return true;
    const text = String(body ?? '');
    return text.includes('window._cf_chl_opt') || text.includes('cf-mitigated');
}

/**
 * Human-readable cause for a non-OK answer, so the UI can say what to do.
 * @param {number} status
 * @param {string} [body]
 */
export function classifyJannyError(status, body = '') {
    if (status === 401 || status === 403) {
        return {
            code: 'janny_auth',
            message: 'JannyAI refused the search token (it was probably rotated). Refresh it in Settings → Weaver\'s Vault → JannyAI.',
        };
    }
    if (status === 400) {
        return { code: 'janny_bad_query', message: `JannyAI rejected the query: ${stripJannyHtml(body).slice(0, 180) || 'no detail'}` };
    }
    if (status === 429) {
        return { code: 'janny_rate_limited', message: 'JannyAI is rate limiting. Wait a moment and try again.' };
    }
    if (isJannyChallenge(status, body)) {
        return { code: 'janny_challenge', message: JANNY_CLOSED_MESSAGE };
    }
    return { code: 'janny_error', message: `JannyAI answered HTTP ${status}.` };
}
