import express from 'express';
import fetch from 'node-fetch';

import { readSecret, SECRET_KEYS } from './secrets.js';

/**
 * Weaver's Vault — character library backend.
 *
 * Proxies character-sharing sites so the browser extension never talks to them
 * directly (CORS, key safety, caching). Source adapters are ported from Glaze
 * (https://github.com/hydall/Glaze, AGPL-3.0) — see docs/vault/glaze-sources-survey.md.
 *
 * M1 scope: chub.ai (search / tags / character detail).
 */

export const router = express.Router();

// Cosplay as Chrome — the same lesson Glaze learned: default server UAs get
// blocked or degraded answers from these APIs.
const VAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const CHUB_API = 'https://api.chub.ai';
const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars/';

// ---------------------------------------------------------------------------
// Small TTL cache. These are public listings; short TTLs keep browsing snappy
// without hammering the sources. Keys are serialized request descriptors, so
// different users never share cached results carrying account-specific data.
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL = { search: 120_000, tags: 6 * 3600_000, character: 3600_000 };

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key, value, ttl) {
    if (cache.size > 500) cache.clear(); // crude bound; listings are small
    cache.set(key, { expires: Date.now() + ttl, value });
}

function vaultChubHeaders(apiKey) {
    const headers = {
        'Accept': 'application/json',
        'User-Agent': VAULT_UA,
        'Origin': 'https://chub.ai',
        'Referer': 'https://chub.ai/',
    };
    // Glaze: the site's own account key rides as BOTH of these headers.
    if (apiKey) {
        headers['CH-API-KEY'] = apiKey;
        headers['samwise'] = apiKey;
    }
    return headers;
}

async function chubFetchJson(url, apiKey) {
    const response = await fetch(url, { headers: vaultChubHeaders(apiKey) });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = new Error(`chub.ai answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        err.status = response.status;
        throw err;
    }
    return response.json();
}

// ---------------------------------------------------------------------------
// Normalizers (ported from Glaze chub_provider.dart _normalizeNode /
// chubCharacterData). Chub's field layout is idiosyncratic:
//   node.personality  → card body (description)   def.tavern_personality → V2 personality
//   def.description   → storefront tagline  → creator notes
//   def.first_message / def.alternate_greetings → greetings
// ---------------------------------------------------------------------------

export function normalizeChubNode(node) {
    const fullPath = node.fullPath ?? node.full_path ?? '';
    const creator = String(fullPath).split('/')[0] || 'unknown';
    const topics = Array.isArray(node.topics) ? node.topics : [];
    const isTopicNsfw = topics.some(t => String(t).toLowerCase() === 'nsfw');
    const tags = topics.filter(t => {
        const lower = String(t).toLowerCase();
        return lower !== 'nsfw' && lower !== 'sfw';
    });
    const tokens = Number(node.nTokens ?? node.n_tokens ?? 0);
    const chatCount = Number(node.nChats ?? node.n_chats ?? 0);
    return {
        id: String(fullPath),
        name: node.name ?? 'Unknown',
        avatarUrl: node.avatar_url ?? node.max_res_url ?? `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`,
        description: node.tagline ?? '',
        tags,
        tokens,
        chatCount,
        creator,
        nsfw: Boolean(node.nsfw ?? node.is_nsfw) || isTopicNsfw,
        nsfl: Boolean(node.nsfl ?? node.is_nsfl),
        source: 'chub',
        fullPath: String(fullPath),
    };
}

export function chubCharacterData(node) {
    const def = node.definition ?? {};
    const fullPath = node.fullPath ?? node.full_path ?? '';
    const creator = String(fullPath).split('/')[0] || 'unknown';
    const topics = Array.isArray(node.topics) ? node.topics : [];
    const isTopicNsfw = topics.some(t => String(t).toLowerCase() === 'nsfw');
    const tags = [
        isTopicNsfw ? 'NSFW' : 'SFW',
        ...topics.filter(t => {
            const lower = String(t).toLowerCase();
            return lower !== 'nsfw' && lower !== 'sfw';
        }),
    ];
    const first = typeof def.first_message === 'string' ? def.first_message : '';
    const seen = new Set([first.trim()]);
    const alternates = (Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [])
        .filter(g => typeof g === 'string' && g.trim() && !seen.has(g.trim()));
    return {
        spec: 'chara_card_v2',
        data: {
            name: def.name ?? node.name ?? 'Unknown',
            // See layout note above: personality=body, tavern_personality=V2 field.
            description: def.personality ?? '',
            personality: def.tavern_personality ?? '',
            scenario: def.scenario ?? '',
            first_mes: first,
            mes_example: def.example_dialogs ?? '',
            creator_notes: def.description ?? node.tagline ?? '',
            system_prompt: def.system_prompt ?? '',
            post_history_instructions: def.post_history_instructions ?? '',
            alternate_greetings: alternates,
            tags,
            creator,
            character_version: '',
            creator_notes_multilingual: {},
            extensions: {
                vault_source: 'chub',
                vault_full_path: String(fullPath),
            },
            // Embedded lorebook passes through as-is when present; the importer
            // converts it into a native worldbook.
            character_book: def.embedded_lorebook ?? undefined,
        },
    };
}

// Sort keys (Glaze _sortMap): chub's own sort param + optional recency window.
const CHUB_SORTS = {
    popular: { sort: 'download_count' },
    trending_week: { sort: 'download_count', maxDaysAgo: '7' },
    trending_24h: { sort: 'download_count', maxDaysAgo: '1' },
    latest: { sort: 'id' },
    rating: { sort: 'star_count' },
    updated: { sort: 'last_activity_at' },
};

function buildChubSearchQuery(body) {
    const {
        query = '', page = 1, limit = 24, sort = 'popular',
        nsfw = false, nsfl = false,
        topics = [], excludetopics = [],
        minTokens = 0, maxTokens = 100000,
        flags = {},
    } = body ?? {};
    const entry = CHUB_SORTS[sort] ?? CHUB_SORTS.popular;
    const parts = [
        `first=${Math.min(Number(limit) || 24, 200)}`,
        `page=${Number(page) || 1}`,
        `sort=${entry.sort}`,
        `nsfw=${Boolean(nsfw)}`,
        `nsfl=${Boolean(nsfl)}`,
        'include_forks=true',
        `min_tokens=${Number(minTokens) > 0 ? Number(minTokens) : 50}`,
        'venus=false',
    ];
    if (entry.maxDaysAgo) parts.push(`max_days_ago=${entry.maxDaysAgo}`);
    if (query) parts.push(`search=${encodeURIComponent(query)}`);
    if (Number(maxTokens) < 100000) parts.push(`max_tokens=${Number(maxTokens)}`);
    if (Array.isArray(topics) && topics.length) parts.push(`topics=${topics.map(encodeURIComponent).join(',')}`);
    if (Array.isArray(excludetopics) && excludetopics.length) parts.push(`excludetopics=${excludetopics.map(encodeURIComponent).join(',')}`);
    // Chub-only content flags, mapped straight onto the site's own params.
    for (const [flag, param] of [
        ['nsfwOnly', 'nsfw_only'], ['requireImages', 'require_images'],
        ['requireLore', 'require_lore'], ['requireCustomPrompt', 'require_custom_prompt'],
        ['requireExampleDialogues', 'require_example_dialogues'],
        ['requireAlternateGreetings', 'require_alternate_greetings'],
        ['recommendedVerified', 'recommended_verified'], ['excludeMine', 'exclude_mine'],
        ['inclusiveOr', 'inclusive_or'],
    ]) {
        if (flags[flag]) parts.push(`${param}=true`);
    }
    if (Number(flags.minAiRating) > 0) parts.push(`min_ai_rating=${Number(flags.minAiRating)}`);
    if (Number(flags.minTags) > 0) parts.push(`min_tags=${Number(flags.minTags)}`);
    return parts.join('&');
}

router.post('/chub/search', async (req, res) => {
    try {
        const apiKey = readSecret(req.user.directories, SECRET_KEYS.CHUB) || undefined;
        const qs = buildChubSearchQuery(req.body);
        const cacheKey = `chub:search:${JSON.stringify(req.body)}:${apiKey ? 'key' : 'anon'}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json(cached);
        const data = await chubFetchJson(`${CHUB_API}/search?${qs}`, apiKey);
        const container = data?.data ?? {};
        const nodes = data?.nodes ?? container.nodes ?? [];
        const result = {
            items: nodes.map(normalizeChubNode),
            total: container.count ?? data?.total ?? nodes.length,
            hasMore: Boolean(container.cursor ?? data?.cursor),
        };
        cacheSet(cacheKey, result, CACHE_TTL.search);
        return res.json(result);
    } catch (error) {
        console.warn('[Weaver\'s Vault] chub search failed:', error.message);
        return res.status(error.status === 403 ? 502 : 500).json({ error: error.message });
    }
});

router.post('/chub/tags', async (req, res) => {
    try {
        const apiKey = readSecret(req.user.directories, SECRET_KEYS.CHUB) || undefined;
        const search = String(req.body?.search ?? '').trim();
        const limit = Math.min(Number(req.body?.limit) || 40, 500);
        const cacheKey = `chub:tags:${search}:${limit}:${apiKey ? 'key' : 'anon'}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json(cached);
        const payload = { limit, sort: 'n_projects', nsfw: true, nsfl: true };
        if (search) payload.search = search;
        const response = await fetch(`${CHUB_API}/tags`, {
            method: 'POST',
            headers: { ...vaultChubHeaders(apiKey), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`chub.ai tags answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        const data = await response.json();
        // Tag index answer shapes: {tags: [...]} or a bare array; each tag may be
        // a string or {name|value, n_projects|count}. Normalize name-only.
        const raw = Array.isArray(data) ? data : (data?.tags ?? data?.data?.tags ?? []);
        // parseChubTags (chub_provider.dart): names lowercased and de-duped
        // (chub matches `topics` without regard to case), then a stable sort by
        // usage count desc with the server's order breaking ties.
        const seen = new Set();
        const entries = [];
        raw.forEach(t => {
            const name = String(typeof t === 'string' ? t : (t.name ?? t.value ?? t.topic ?? '')).trim().toLowerCase();
            if (!name || seen.has(name)) return;
            seen.add(name);
            entries.push({ name, count: (typeof t === 'object' && t ? Number(t.n_projects ?? t.total_projects_count ?? t.count ?? 0) : 0) || 0 });
        });
        const tags = entries
            .map((e, i) => ({ e, i }))
            .sort((a, b) => (b.e.count - a.e.count) || (a.i - b.i))
            .map(({ e }) => e.count ? { name: e.name, count: e.count } : { name: e.name });
        cacheSet(cacheKey, { tags }, CACHE_TTL.tags);
        return res.json({ tags });
    } catch (error) {
        console.warn('[Weaver\'s Vault] chub tags failed:', error.message);
        return res.status(error.status === 403 ? 502 : 500).json({ error: error.message });
    }
});

router.get('/chub/character', async (req, res) => {
    try {
        const fullPath = String(req.query.fullPath ?? '').trim();
        if (!fullPath || fullPath.includes('..') || fullPath.includes('\\')) {
            return res.status(400).json({ error: 'fullPath required (creator/character)' });
        }
        const apiKey = readSecret(req.user.directories, SECRET_KEYS.CHUB) || undefined;
        const cacheKey = `chub:char:${fullPath}:${apiKey ? 'key' : 'anon'}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json(cached);
        // full=true pulls the definition block (card body, greetings, lorebook).
        const data = await chubFetchJson(
            `${CHUB_API}/api/characters/${encodeURIComponent(fullPath)}?full=true`,
            apiKey,
        );
        const node = data?.node ?? data;
        const result = { character: chubCharacterData(node) };
        cacheSet(cacheKey, result, CACHE_TTL.character);
        return res.json(result);
    } catch (error) {
        console.warn('[Weaver\'s Vault] chub character failed:', error.message);
        return res.status(error.status === 404 ? 404 : error.status === 403 ? 502 : 500).json({ error: error.message });
    }
});
