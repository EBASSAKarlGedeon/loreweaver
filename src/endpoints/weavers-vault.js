import express from 'express';
import fetch from 'node-fetch';

import { readSecret, writeSecret, SECRET_KEYS } from './secrets.js';
import { write as writeCardChunk } from '../character-card-parser.js';
import {
    normalizeSaucepanExtraction,
    parseCompanionId,
    saucepanGetJson,
    saucepanLogin,
    saucepanHeaders,
    SAUCEPAN_BASE,
    SAUCEPAN_CLOSED_MESSAGE,
} from './weavers-vault-saucepan.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import path from 'node:path';
import fs from 'node:fs';
import { serverDirectory } from '../server-directory.js';
import { createDatacatRouter } from './weavers-vault-datacat-routes.js';
import {
    JANNY_FALLBACK_TOKEN,
    JANNY_SEARCH_URL,
    classifyJannyError,
    jannyCardFromCharacter,
    jannyCharacterUrl,
    jannySearchAttempts,
    jannySearchHeaders,
    normalizeJannyHit,
    parseJannyCharacterPage,
    parseJannyMultiSearch,
} from './weavers-vault-janny.js';
import { JannyBrowserUnavailable, disposeJannyBrowser, findBrowserBinary, getJannyBrowser } from './weavers-vault-janny-browser.js';
import { loadJannyTagCatalog } from './weavers-vault-janny-tags.js';
import {
    JANITOR_ORIGIN,
    JANITOR_LOGIN_URL,
    classifyJanitorError,
    janitorBlockReason,
    janitorAvatarUrl,
    janitorCardCharacter,
    janitorCardFields,
    janitorCardState,
    janitorCharacterUrl,
    janitorDefinitionPublic,
    janitorPublicUrl,
    janitorSearchUrl,
    janitorSortParam,
    normalizeJanitorRow,
} from './weavers-vault-janitor.js';
import { janitorCatalog, janitorTagsUrl } from './weavers-vault-janitor-tags.js';
import {
    disposeJanitorBrowser,
    findBrowserBinary as findJanitorBrowserBinary,
    getJanitorBrowser,
    janitorAuthHeaders,
    readJanitorAccount,
} from './weavers-vault-janitor-browser.js';
import { resolveJannyTagIds } from './weavers-vault-janny.js';

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

// M5 · DataCat lives in its own module (routes + I/O); mount it before the chub
// routes so its paths are unambiguous.
router.use(createDatacatRouter());

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

// ---------------------------------------------------------------------------
// M4 · Saucepan (saucepan.ai): extraction logic lives in
// weavers-vault-saucepan.js (pure, unit-tested). This section holds the
// routes: paste-token storage (DESIGN.md Q14), status, and the extract
// endpoint that returns a ready-to-import card PNG.
// ---------------------------------------------------------------------------

router.post('/saucepan/token', async (req, res) => {
    try {
        // Paste-only bearer token (DESIGN.md Q14) — never a password flow.
        const token = String(req.body?.token ?? '').trim();
        writeSecret(req.user.directories, SECRET_KEYS.VAULT_SAUCEPAN, token);
        return res.json({ ok: true, loggedIn: Boolean(token) });
    } catch (error) {
        console.warn("[Weaver's Vault] saucepan token save failed:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// Handle + password login (saucepan_login_sheet.dart's primary path): mints
// the bearer token server-side and stores it. The password is forwarded to
// Saucepan once and never persisted — only the token lands in secrets.json.
router.post('/saucepan/login', async (req, res) => {
    try {
        const handle = String(req.body?.handle ?? '').trim();
        const password = String(req.body?.password ?? '');
        if (!handle || !password) {
            return res.status(400).json({ error: 'Handle and password are required.' });
        }
        const token = await saucepanLogin(handle, password);
        writeSecret(req.user.directories, SECRET_KEYS.VAULT_SAUCEPAN, token);
        return res.json({ ok: true, loggedIn: true });
    } catch (error) {
        console.warn("[Weaver's Vault] saucepan login failed:", error.message);
        return res.status(error.status ?? 502).json({ error: error.message });
    }
});

router.get('/saucepan/status', (req, res) => {
    const token = readSecret(req.user.directories, SECRET_KEYS.VAULT_SAUCEPAN) ?? '';
    return res.json({ loggedIn: Boolean(token.trim()) });
});

router.post('/saucepan/extract', async (req, res) => {
    try {
        const token = (readSecret(req.user.directories, SECRET_KEYS.VAULT_SAUCEPAN) ?? '').trim();
        if (!token) {
            return res.status(401).json({ error: 'No Saucepan token configured — set one first.' });
        }
        const url = String(req.body?.url ?? '');
        const companionId = parseCompanionId(url);
        if (!companionId) {
            return res.status(400).json({ error: 'Not a Saucepan companion URL.' });
        }

        const [defRes, compRes] = await Promise.all([
            saucepanGetJson(`/api/v1/companion/definition?companion_id=${companionId}`, token),
            saucepanGetJson(`/api/v2/companions/${companionId}`, token),
        ]);
        if (defRes.status >= 400 || !defRes.data) {
            const msg = defRes.data?.error?.message ?? `Saucepan HTTP ${defRes.status}`;
            return res.status(defRes.status === 401 ? 401 : 502).json({ error: msg });
        }
        const comp = compRes.data?.companion;
        if (compRes.status >= 400 || !comp) {
            console.warn(`[Weaver's Vault] saucepan greetings/metadata unavailable (companions/${companionId} HTTP ${compRes.status})`);
        }

        const extraction = normalizeSaucepanExtraction(defRes.data, compRes.data, companionId);
        if (extraction.closed) {
            return res.status(403).json({ error: SAUCEPAN_CLOSED_MESSAGE });
        }

        // Card avatar comes from the authed CDN (`/cdn/<imageId>/card`); fall
        // back to the built-in default like every other source importer does.
        let imageBuffer = null;
        const imageId = comp?.image && typeof comp.image === 'object' ? comp.image.id : null;
        if (imageId != null) {
            try {
                const r = await fetch(`${SAUCEPAN_BASE}/cdn/${encodeURIComponent(String(imageId))}/card`, {
                    headers: saucepanHeaders(token),
                });
                if (r.ok) imageBuffer = Buffer.from(await r.arrayBuffer());
                else console.warn(`[Weaver's Vault] saucepan avatar answered ${r.status} — using default avatar`);
            } catch (error) {
                console.warn("[Weaver's Vault] saucepan avatar fetch failed:", error.message);
            }
        }
        if (!imageBuffer) {
            imageBuffer = fs.readFileSync(path.join(serverDirectory, DEFAULT_AVATAR_PATH));
        }

        const cardBuffer = writeCardChunk(imageBuffer, JSON.stringify(extraction.character));
        const fileName = `${extraction.character.data.name.replace(/[\\/:*?"<>|]/g, '_')}.png`;
        return res.json({
            companionId,
            character: extraction.character,
            file: {
                buffer: cardBuffer.toString('base64'),
                fileName,
                fileType: 'image/png',
            },
            avatarDataUrl: `data:image/png;base64,${cardBuffer.toString('base64')}`,
        });
    } catch (error) {
        console.warn("[Weaver's Vault] saucepan extract failed:", error.message);
        return res.status(502).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// M6 · JannyAI (jannyai.com). Search is plain HTTPS against their Meilisearch
// instance; character detail needs a real browser session because the site is
// behind a Cloudflare managed challenge (see weavers-vault-janny-browser.js,
// which is the port of Glaze's JannyWebViewProxy).
// ---------------------------------------------------------------------------

// Lives at the data root, beside the per-user handles rather than inside one, so
// sync (which walks `data/default-user`) never sees a Chrome profile. Resolved
// lazily because DATA_ROOT is assigned after this module is imported.
function jannyProfileDir() {
    return path.join(globalThis.DATA_ROOT ?? path.join(serverDirectory, 'data'), '_vault-janny-profile');
}

// JanitorAI's profile lives beside jannyai's, at the data root, for the same
// reason: sync walks `data/default-user`, and a Chrome profile must never be in it.
function janitorProfileDir() {
    return path.join(globalThis.DATA_ROOT ?? path.join(serverDirectory, 'data'), '_vault-janitor-profile');
}

function janitorBrowserFor(req) {
    return getJanitorBrowser({
        profileDir: path.resolve(janitorProfileDir()),
        chromePath: String(req.user?.settings?.vaultJanitorBrowserPath ?? '').trim() || null,
    });
}

/** Tag labels are cached beside the profile, outside every sync handle. */
function jannyTagCachePath() {
    return path.join(globalThis.DATA_ROOT ?? path.join(serverDirectory, 'data'), '_vault-janny-tags.json');
}

function jannyBrowserFor(req) {
    return getJannyBrowser({
        // Absolute: the browser resolves it too, and a relative
        // --user-data-dir made its own command line relative, which silently
        // defeated reclaiming the profile from a previous run.
        profileDir: path.resolve(jannyProfileDir()),
        chromePath: String(req.user?.settings?.vaultJannyBrowserPath ?? '').trim() || null,
    });
}

async function jannyCatalog(req, { force = false } = {}) {
    const browser = jannyBrowserFor(req);
    return loadJannyTagCatalog({
        cachePath: jannyTagCachePath(),
        force,
        fetchHtml: url => browser.fetchText(url),
    });
}

/** Measured `maxTotalHits` of the JannyAI index: paginated totals stop here. */
const JANNY_MAX_TOTAL_HITS = 4000;

function jannyToken(settings) {
    const configured = String(settings?.jannySearchToken ?? '').trim();
    return configured || JANNY_FALLBACK_TOKEN;
}

router.get('/janny/status', (req, res) => {
    const browserPath = findBrowserBinary();
    res.json({
        ok: Boolean(browserPath),
        browserPath,
        // Absolute: the browser resolves it too, and a relative
        // --user-data-dir made its own command line relative, which silently
        // defeated reclaiming the profile from a previous run.
        profileDir: path.resolve(jannyProfileDir()),
        tokenSource: String(req.user?.settings?.jannySearchToken ?? '').trim() ? 'settings' : 'fallback',
        note: browserPath
            ? 'JannyAI detail is fetched by a real browser session (Cloudflare managed challenge).'
            : 'No Chrome/Edge binary found — set vaultJannyBrowserPath or JANNY_BROWSER_PATH.',
    });
});

// Tag vocabulary for the filter sheet. Names live only on the site, so this
// reads its sidebar once and caches it (7 days); the measured fallback list
// keeps the filter usable if the site cannot be read.
router.get('/janny/tags', async (req, res) => {
    try {
        const force = String(req.query.refresh ?? '') === '1';
        const catalog = await jannyCatalog(req, { force });
        return res.json({
            tags: catalog.tags,
            source: catalog.source,
            fetchedAt: catalog.fetchedAt,
        });
    } catch (error) {
        console.warn("[Weaver's Vault] janny tags failed:", error.message);
        return res.status(502).json({ error: error.message });
    }
});

// Search rides the Meilisearch instance directly: no challenge, no browser.
router.post('/janny/search', async (req, res) => {
    try {
        const { query = '', page = 1, nsfw, minTokens, maxTokens, tagIds, tags, inclusiveOr, sort } = req.body ?? {};
        const token = jannyToken(req.user?.settings);

        // The sheet stores tag *names* (uniform with chub); the index filters on
        // numeric ids, so resolve them through the cached catalog.
        const selection = Array.isArray(tags) && tags.length ? tags : (Array.isArray(tagIds) ? tagIds : []);
        let resolvedIds = [];
        if (selection.length) {
            const catalog = await jannyCatalog(req);
            resolvedIds = resolveJannyTagIds(catalog.tags, selection);
            if (!resolvedIds.length) {
                console.warn(`[Weaver's Vault] janny tags not resolvable: ${JSON.stringify(selection)}`);
            }
        }

        const attempts = jannySearchAttempts({
            query: String(query ?? ''),
            page: Number(page) || 1,
            nsfw: nsfw !== false,
            minTokens: Number(minTokens) || 0,
            maxTokens: Number(maxTokens) || 100000,
            tagIds: resolvedIds,
            inclusiveOr: inclusiveOr === true,
            sort: String(sort ?? 'newest'),
        });

        let lastError = null;
        for (const body of attempts) {
            const response = await fetch(JANNY_SEARCH_URL, {
                method: 'POST',
                headers: jannySearchHeaders(token),
                body: JSON.stringify(body),
            });
            const text = await response.text();
            if (response.ok) {
                const parsed = parseJannyMultiSearch(JSON.parse(text));
                // Meilisearch caps paginated totals at the index's maxTotalHits
                // (measured: every broad query reports exactly 4000, while a
                // nonsense query reports 0). Reporting the capped number would
                // tell the user there are 4000 filtered matches when there are
                // five, so the count is dropped once it hits the cap.
                const capped = parsed.total >= JANNY_MAX_TOTAL_HITS;
                return res.json({
                    items: parsed.hits.map(normalizeJannyHit),
                    total: capped ? null : parsed.total,
                    capped,
                    page: parsed.page,
                    pageCount: parsed.totalPages,
                    // The grid's infinite scroll reads `hasMore`, and a short page
                    // is the only trustworthy end-of-results signal here.
                    hasMore: parsed.hits.length >= 40 && parsed.page < parsed.totalPages,
                });
            }
            lastError = classifyJannyError(response.status, text);
            // Only a rejected *clause* is worth retrying more plainly; an auth
            // or rate-limit answer is final.
            if (response.status !== 400) break;
        }
        const status = lastError?.code === 'janny_auth' ? 401
            : lastError?.code === 'janny_rate_limited' ? 429
                : 502;
        return res.status(status).json({ error: lastError?.message ?? 'JannyAI search failed.', code: lastError?.code });
    } catch (error) {
        console.warn("[Weaver's Vault] janny search failed:", error.message);
        return res.status(502).json({ error: error.message });
    }
});

// Detail: fetch the page inside a real browser session, parse the Astro props.
router.post('/janny/card', async (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    if (!/^[0-9a-f-]{8,}$/i.test(id)) {
        return res.status(400).json({ error: 'A JannyAI character id is required.' });
    }
    try {
        const browser = jannyBrowserFor(req);
        const url = jannyCharacterUrl(id, name);
        const page = await browser.fetchText(url);
        if (page.challenged || page.status === 403 || page.status === 503) {
            return res.status(403).json({
                error: classifyJannyError(page.status === -1 ? 503 : page.status, page.body).message,
                code: 'janny_challenge',
            });
        }
        if (page.status >= 400 || page.status <= 0) {
            return res.status(502).json({ error: `JannyAI answered HTTP ${page.status} for this character.` });
        }

        const parsed = parseJannyCharacterPage(page.body);
        if (!parsed) {
            return res.status(502).json({ error: 'Could not parse the JannyAI character page (no character props).' });
        }

        const character = jannyCardFromCharacter(parsed.character, {
            id,
            imageUrl: parsed.imageUrl,
            creatorUsername: parsed.creatorUsername,
        });

        // The CDN answers WebP whatever Accept says and a card must be a PNG.
        // Node pulls the bytes (the CDN sends no CORS headers), the warm browser
        // transcodes them only when they are not already a PNG.
        let imageBuffer = null;
        if (parsed.imageUrl) {
            try {
                const avatar = await fetch(parsed.imageUrl, { headers: { 'User-Agent': VAULT_UA } });
                if (avatar.ok) {
                    const bytes = Buffer.from(await avatar.arrayBuffer());
                    if (bytes.length > 8 && bytes.subarray(1, 4).toString() === 'PNG') {
                        imageBuffer = bytes;
                    } else {
                        const mime = String(avatar.headers.get('content-type') ?? 'image/webp').split(';')[0];
                        imageBuffer = await browser.convertImageToPng(`data:${mime};base64,${bytes.toString('base64')}`);
                    }
                } else {
                    console.warn(`[Weaver's Vault] janny avatar answered ${avatar.status} — using default avatar`);
                }
            } catch (error) {
                console.warn("[Weaver's Vault] janny avatar fetch failed:", error.message);
            }
        }
        if (!imageBuffer) {
            imageBuffer = fs.readFileSync(path.join(serverDirectory, DEFAULT_AVATAR_PATH));
        }

        const cardBuffer = writeCardChunk(imageBuffer, JSON.stringify(character));
        const fileName = `${String(character.data.name).replace(/[\\/:*?"<>|]/g, '_')}.png`;
        return res.json({
            characterId: id,
            character,
            file: {
                buffer: cardBuffer.toString('base64'),
                fileName,
                fileType: 'image/png',
            },
            avatarDataUrl: `data:image/png;base64,${cardBuffer.toString('base64')}`,
        });
    } catch (error) {
        if (error instanceof JannyBrowserUnavailable) {
            return res.status(503).json({ error: error.message, code: 'janny_browser' });
        }
        console.warn("[Weaver's Vault] janny card failed:", error.message);
        return res.status(502).json({ error: error.message });
    }
});

// Brings the automation window to the front so a stuck check can be finished by
// hand once; harmless when nothing is running yet.
router.post('/janny/browser/focus', async (req, res) => {
    try {
        const browser = jannyBrowserFor(req);
        // Moving it on screen is the point: the window is parked offscreen and
        // has no taskbar button, so a check that needs one human click would
        // otherwise be unreachable.
        const { revealed, running } = await browser.reveal();
        return res.json({ ok: true, running, revealed });
    } catch (error) {
        return res.status(503).json({ error: error.message, code: 'janny_browser' });
    }
});

router.post('/janny/browser/close', async (req, res) => {
    await disposeJannyBrowser();
    await disposeJanitorBrowser();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// JanitorAI (janitorai.com). Reads are plain JSON over the browser session; the
// account and the /generateAlpha capture are why that session exists at all.
// ---------------------------------------------------------------------------

router.get('/janitor/status', async (req, res) => {
    const browserPath = findJanitorBrowserBinary();
    const base = {
        ok: Boolean(browserPath),
        browserPath,
        profileDir: path.resolve(janitorProfileDir()),
        origin: JANITOR_ORIGIN,
        signedIn: false,
        account: '',
        note: browserPath
            ? 'JanitorAI needs a browser session for sign-in and for recovering closed definitions.'
            : 'No Chrome/Edge binary found — set vaultJanitorBrowserPath or JANITOR_BROWSER_PATH.',
    };
    if (!browserPath) return res.json(base);
    // Only report an account when a session is already up: starting a browser to
    // answer a status probe would cost 3-10 s on every panel open.
    const browser = janitorBrowserFor(req);
    if (!browser.isRunning()) return res.json({ ...base, running: false });
    try {
        const account = await readJanitorAccount(browser);
        return res.json({ ...base, running: true, signedIn: account.signedIn, account: account.name });
    } catch (error) {
        return res.json({ ...base, running: true, note: `Browser session error: ${error.message}` });
    }
});

/** Ask the signed-in account — starts the browser when needed. */
router.get('/janitor/account', async (req, res) => {
    try {
        const browser = janitorBrowserFor(req);
        const account = await readJanitorAccount(browser);
        // Signed in: the window has done its job, hand the session back.
        if (account.signedIn) browser.release();
        return res.json({ ok: true, ...account });
    } catch (error) {
        return res.status(503).json({ error: error.message, code: 'janitor_browser' });
    }
});

/**
 * Show the window so the user can sign in.
 *
 * The window is parked offscreen and has no taskbar button, so this both reveals
 * it and moves it to /login — otherwise the user would be looking at a feed they
 * cannot interact with.
 */
router.post('/janitor/browser/focus', async (req, res) => {
    try {
        const browser = janitorBrowserFor(req);
        const account = await readJanitorAccount(browser);
        // Signing in is a human step that takes minutes; without this the 30 s
        // idle teardown closes the window mid-login (measured).
        if (!account.signedIn) browser.hold();
        if (!account.signedIn) await browser.navigate(JANITOR_LOGIN_URL);
        const { revealed, running } = await browser.reveal();
        return res.json({ ok: true, running, revealed, signedIn: account.signedIn, account: account.name });
    } catch (error) {
        return res.status(503).json({ error: error.message, code: 'janitor_browser' });
    }
});

router.post('/janitor/browser/close', async (req, res) => {
    await disposeJanitorBrowser();
    res.json({ ok: true });
});

/**
 * The tag sheet's vocabulary.
 *
 * `/hampter/tags` is a bare array of 53 tags with emoji names, cached for 7 days
 * at the data root. A failed refresh serves the cached vocabulary marked
 * `stale` rather than emptying the sheet.
 */
router.get('/janitor/tags', async (req, res) => {
    try {
        const force = String(req.query.refresh ?? '') === '1';
        const catalog = await janitorCatalog({
            dataRoot: globalThis.DATA_ROOT ?? path.join(serverDirectory, 'data'),
            force,
            fetchTags: async () => {
                const browser = janitorBrowserFor(req);
                const auth = await janitorAuthHeaders(browser);
                const page = await browser.fetchText(janitorTagsUrl(), { accept: 'application/json', headers: auth.headers });
                if (page.status < 200 || page.status >= 300) {
                    throw new Error(`JanitorAI answered HTTP ${page.status} for its tag list.`);
                }
                return JSON.parse(page.body);
            },
        });
        return res.json({ tags: catalog.tags, source: catalog.source, fetchedAt: catalog.fetchedAt });
    } catch (error) {
        console.warn("[Weaver's Vault] janitor tags failed:", error.message);
        return res.status(502).json({ error: error.message, code: 'janitor_tags' });
    }
});

/**
 * Browse and search.
 *
 * A GET with query parameters because that is the endpoint's own contract: JSON
 * over `GET /hampter/characters?...`, read inside the browser session.
 */
router.get('/janitor/search', async (req, res) => {
    try {
        const query = req.query ?? {};
        // `sort=all` is a 400 on the live site, so the whitelist rejects rather
        // than forwards; anything unrecognised falls back to the default sort.
        const sort = janitorSortParam(query.sort);
        const asList = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value])
            .map(item => String(item).trim())
            .filter(Boolean);
        const url = janitorSearchUrl({
            page: Number(query.page) || 1,
            sort,
            mode: String(query.mode ?? 'all'),
            search: String(query.search ?? '').trim(),
            // Numeric ids only: `tag_id[]=0` silently matches nothing, so a
            // stray zero must never reach the site.
            tagIds: asList(query.tagIds ?? query['tagIds[]']).filter(id => /^[1-9]\d*$/.test(id)),
            customTags: asList(query.customTags ?? query['customTags[]']),
            userIds: asList(query.userIds ?? query['userIds[]']).filter(id => /^[0-9a-f-]{8,}$/i.test(id)),
        });
        const browser = janitorBrowserFor(req);
        const auth = await janitorAuthHeaders(browser);
        const page = await browser.fetchText(url, { accept: 'application/json', headers: auth.headers });
        if (page.challenged) {
            return res.status(403).json({ error: 'JanitorAI presented a challenge for this search.', code: 'janitor_challenge' });
        }
        if (page.status < 200 || page.status >= 300) {
            const classified = classifyJanitorError({ status: page.status, body: page.body, challenged: page.challenged });
            return res.status(classified.code === 'janitor_signed_out' ? 401 : 502)
                .json({ error: classified.message, code: classified.code });
        }
        let payload;
        try {
            payload = JSON.parse(page.body);
        } catch {
            return res.status(502).json({ error: 'JanitorAI returned something that is not JSON.', code: 'janitor_parse' });
        }
        const rows = Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.characters) ? payload.characters
                : Array.isArray(payload) ? payload
                    : [];
        return res.json({
            items: rows.map(normalizeJanitorRow).filter(row => row.id),
            page: Number(query.page) || 1,
            sort,
            // The payload carries no total (measured), so a full page is the only
            // end-of-results signal there is.
            hasMore: rows.length >= 30,
        });
    } catch (error) {
        console.warn("[Weaver's Vault] janitor search failed:", error.message);
        return res.status(502).json({ error: error.message, code: 'janitor_search' });
    }
});

/**
 * One card: fetch its detail and say what can be done with it.
 *
 * The detail payload is the only honest source of truth. Measured: a
 * `showdefinition: false` card returns `personality`, `scenario`,
 * `first_message`, `example_dialogs` and `scripts` as `null` with every
 * `token_counts.*` at 0, and 0 of 102 cards across three sorts were public. So
 * this states the classification instead of pretending a closed card is
 * importable, and turns a public one into the same PNG the import path uses.
 */
router.post('/janitor/card', async (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    if (!/^[0-9a-f-]{8,}$/i.test(id)) {
        return res.status(400).json({ error: 'A JanitorAI character id is required.', code: 'janitor_id' });
    }
    try {
        const browser = janitorBrowserFor(req);
        const auth = await janitorAuthHeaders(browser);
        const page = await browser.fetchText(janitorCharacterUrl(id), { accept: 'application/json', headers: auth.headers });
        if (page.challenged || page.status === 403 || page.status === 503) {
            return res.status(403).json({
                error: classifyJanitorError({ status: page.status, body: page.body, challenged: true }).message,
                code: 'janitor_challenge',
            });
        }
        if (page.status === 404) {
            return res.status(404).json({ error: 'JanitorAI has no character with that id.', code: 'janitor_missing' });
        }
        if (page.status < 200 || page.status >= 300) {
            const classified = classifyJanitorError({ status: page.status, body: page.body });
            return res.status(502).json({ error: classified.message, code: classified.code });
        }
        let payload;
        try {
            payload = JSON.parse(page.body);
        } catch {
            return res.status(502).json({ error: 'JanitorAI returned something that is not JSON.', code: 'janitor_parse' });
        }
        const meta = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
        if (!meta || typeof meta !== 'object' || !String(meta.id ?? '').trim()) {
            return res.status(404).json({ error: 'JanitorAI returned no character for that id.', code: 'janitor_missing' });
        }

        const row = normalizeJanitorRow({ ...meta, id: String(meta.id) });
        const base = {
            characterId: id,
            state: janitorCardState(meta),
            blockReason: janitorBlockReason(meta),
            row,
            publicUrl: janitorPublicUrl(id),
        };

        // A closed definition cannot be read without the capture pipeline, which
        // does not exist yet; say so instead of returning an empty card.
        if (!janitorDefinitionPublic(meta)) {
            return res.json({ ...base, definitionPublic: false, needsCapture: true, meta });
        }

        const fields = janitorCardFields(meta);
        let imageBuffer = null;
        // `meta.avatar` is a bare CDN key, so it has to be resolved before it can
        // be fetched (fetching the key threw and every card fell back to default).
        const avatarUrl = janitorAvatarUrl(meta.avatar ?? meta.image);
        if (avatarUrl) {
            try {
                const avatar = await fetch(avatarUrl, { headers: { 'User-Agent': VAULT_UA } });
                if (avatar.ok) {
                    const bytes = Buffer.from(await avatar.arrayBuffer());
                    if (bytes.length > 8 && bytes.subarray(1, 4).toString() === 'PNG') {
                        imageBuffer = bytes;
                    } else {
                        const mime = String(avatar.headers.get('content-type') ?? 'image/webp').split(';')[0];
                        imageBuffer = await browser.convertImageToPng(`data:${mime};base64,${bytes.toString('base64')}`);
                    }
                }
            } catch (error) {
                console.warn("[Weaver's Vault] janitor avatar failed:", error.message);
            }
        }
        if (!imageBuffer) {
            imageBuffer = fs.readFileSync(path.join(serverDirectory, DEFAULT_AVATAR_PATH));
        }
        // Provenance rides inside the PNG (vault_source/vault_url), exactly as the
        // JannyAI path does, so nothing re-stamps the card after import.
        const character = janitorCardCharacter(meta, { avatarUrl, retrievedAt: new Date().toISOString() });
        const cardBuffer = writeCardChunk(imageBuffer, JSON.stringify(character));
        return res.json({
            ...base,
            definitionPublic: true,
            needsCapture: false,
            character,
            meta,
            file: {
                buffer: cardBuffer.toString('base64'),
                fileName: `${String(fields.name).replace(/[\\/:*?"<>|]/g, '_')}.png`,
                fileType: 'image/png',
            },
            avatarDataUrl: `data:image/png;base64,${cardBuffer.toString('base64')}`,
        });
    } catch (error) {
        if (error instanceof JanitorBrowserUnavailable) {
            return res.status(503).json({ error: error.message, code: 'janitor_browser' });
        }
        console.warn("[Weaver's Vault] janitor card failed:", error.message);
        return res.status(502).json({ error: error.message, code: 'janitor_card' });
    }
});

// ---------------------------------------------------------------------------
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
