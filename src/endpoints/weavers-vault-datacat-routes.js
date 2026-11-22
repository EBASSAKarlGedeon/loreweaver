/**
 * M5 · DataCat (datacat.run) Client API — route layer.
 *
 * Request shaping, the card reader and the lease store live in
 * weavers-vault-datacat.js (pure, unit-tested). This file owns I/O: the network,
 * the per-device secret store and the process-wide transfer lease.
 *
 * Auth model (DESIGN.md provider table): a public *client id* supplied in
 * settings identifies the integration; a linked user token is only needed for
 * community writes; card transfers additionally need a short-lived *lease* from
 * the hosted human-verification challenge.
 */
import express from 'express';
import fetch from 'node-fetch';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { readSecret, writeSecret, SECRET_KEYS } from './secrets.js';
import { write as writeCardChunk } from '../character-card-parser.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { serverDirectory } from '../server-directory.js';
import {
    DATACAT_CLIENT_ID_MISSING_MESSAGE,
    DATACAT_MAX_TAG_LIMIT,
    LeaseStore,
    applyClientFilters,
    cardToCharacter,
    charactersQuery,
    classifyError,
    datacatHeaders,
    datacatUrl,
    deviceBody,
    freshQuery,
    isValidInstallationId,
    normalizeSummary,
    parseCapabilities,
    parseDeviceFlow,
    parseListing,
    resolveSort,
    verificationAction,
} from './weavers-vault-datacat.js';

const VAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Installation-scoped, not a secret — but it is bound to linked tokens, so it
// lives beside them in the per-device store rather than in synced settings.
const INSTALLATION_SECRET = 'vault_datacat_installation';

/**
 * One lease per process, like Glaze's `DatacatLeaseStore`: a lease outlives
 * neither the process nor its own expiry, so persisting it would only ever hand
 * back something already dead.
 */
const leases = new LeaseStore();

let capabilitiesCache = null;
let tagsCache = null;

function clientId(req) {
    return String(readSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT_CLIENT) ?? '').trim();
}

function userToken(req) {
    return String(readSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT) ?? '').trim();
}

function installationId(req) {
    const stored = String(readSecret(req.user.directories, INSTALLATION_SECRET) ?? '').trim();
    if (isValidInstallationId(stored)) return stored;
    const fresh = randomUUID();
    writeSecret(req.user.directories, INSTALLATION_SECRET, fresh);
    return fresh;
}

function requireClientId(req) {
    const id = clientId(req);
    if (id) return id;
    const error = new Error(DATACAT_CLIENT_ID_MISSING_MESSAGE);
    error.status = 400;
    error.code = 'client_id_missing';
    throw error;
}

function authFor(req, extra = {}) {
    return { clientId: clientId(req), ...extra };
}

async function request(req, method, pathname, { query = {}, body, auth = {} } = {}) {
    requireClientId(req);
    const init = {
        method,
        headers: { ...datacatHeaders(authFor(req, auth)), 'User-Agent': VAULT_UA },
    };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const response = await fetch(datacatUrl(pathname, query), init);
    const text = await response.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json error body */ }
    if (!response.ok) {
        const error = new Error(classifyError(response.status, json ?? {}).message);
        Object.assign(error, classifyError(response.status, json ?? {}));
        throw error;
    }
    return json ?? {};
}

/**
 * Failures carry their meaning, not just a status: `verificationRequired` is the
 * cue for the client to run the hosted challenge and retry, while a 409/428
 * "pending" is the normal state of a poll loop and must not read as an error.
 */
function fail(res, error) {
    const status = error.status || 502;
    const payload = { error: error.message };
    if (error.code) payload.code = error.code;
    if (error.verificationRequired) payload.verificationRequired = true;
    return res.status(status === 428 ? 403 : status).json(payload);
}

async function capabilities(req) {
    if (capabilitiesCache) return capabilitiesCache;
    try {
        return (capabilitiesCache = parseCapabilities(await request(req, 'GET', '/capabilities')));
    } catch {
        // The documented defaults are what the API has always answered with; a
        // failed read must not take the catalog down with it.
        return (capabilitiesCache = parseCapabilities(undefined));
    }
}

async function fetchTags(req) {
    if (tagsCache) return tagsCache;
    try {
        const data = await request(req, 'GET', '/tags', {
            query: { sort: 'count', limit: DATACAT_MAX_TAG_LIMIT, offset: 0 },
        });
        return (tagsCache = (Array.isArray(data?.tags) ? data.tags : [])
            .map(t => ({ id: Number(t?.id), name: String(t?.name ?? ''), slug: t?.slug ?? null }))
            .filter(t => Number.isFinite(t.id) && t.name));
    } catch {
        // A tag list that will not load leaves the sheet's other filters usable.
        return (tagsCache = []);
    }
}

/** Name lookup for tags a `/fresh` listing could not be asked to filter. */
async function tagNamesFor(req, tagIds) {
    if (!Array.isArray(tagIds) || !tagIds.length) return [];
    const byId = new Map((await fetchTags(req)).map(t => [t.id, t.name]));
    return tagIds.map(id => byId.get(Number(id))).filter(Boolean).map(n => n.toLowerCase());
}

/** Fetches bytes under whatever lease is currently valid. */
async function fetchAvatarBytes(req, id, sourceKind) {
    const response = await fetch(datacatUrl(`/characters/${encodeURIComponent(id)}/avatar`, { sourceKind }), {
        headers: {
            ...datacatHeaders(authFor(req, {
                lease: leases.leaseFor(id) ?? undefined,
                installationId: installationId(req),
                withInstallationId: true,
            })),
            'User-Agent': VAULT_UA,
        },
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
}

export function createDatacatRouter() {
    const router = express.Router();

    // The client id is the public half of the integration (the secret half is a
    // developer token that must never ship), so it is a settings field, not a
    // login. Storing it resets the capability/tag caches — they are per-key.
    router.post('/datacat/client-id', (req, res) => {
        try {
            const value = String(req.body?.clientId ?? '').trim();
            writeSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT_CLIENT, value);
            capabilitiesCache = null;
            tagsCache = null;
            return res.json({ ok: true, configured: Boolean(value) });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    router.get('/datacat/status', async (req, res) => {
        if (!clientId(req)) {
            return res.json({
                configured: false,
                linked: false,
                message: DATACAT_CLIENT_ID_MISSING_MESSAGE,
            });
        }
        const token = userToken(req);
        try {
            const data = await request(req, 'GET', '/account/status', {
                auth: {
                    userToken: token || undefined,
                    installationId: installationId(req),
                    withInstallationId: true,
                },
            });
            const account = data?.account ?? data ?? {};
            const displayName = String(account.displayName ?? account.username ?? '').trim();
            return res.json({
                configured: true,
                linked: account.state ? account.state === 'linked' : Boolean(token),
                displayName: displayName || undefined,
                scopes: Array.isArray(data?.scopes) ? data.scopes : [],
            });
        } catch (error) {
            // Unreachable is not unlinked: report what is stored rather than
            // logging the user out over a network blip.
            if (error.isUnauthorized) {
                writeSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT, '');
                return res.json({ configured: true, linked: false });
            }
            return res.json({
                configured: true,
                linked: Boolean(token),
                degraded: error.message,
            });
        }
    });

    router.post('/datacat/search', async (req, res) => {
        try {
            const caps = await capabilities(req);
            const body = req.body ?? {};
            const sort = resolveSort(body.sort, body.window);
            const opts = {
                query: String(body.query ?? ''),
                offset: Number(body.offset) || 0,
                limit: Number(body.limit) || caps.defaultPageSize,
                maxPageSize: caps.maxPageSize,
                sort: sort.field,
                window: sort.window,
                tagIds: Array.isArray(body.tagIds) ? body.tagIds.map(Number).filter(Number.isFinite) : [],
                nsfw: Boolean(body.nsfw),
            };

            if (sort.window === 'all') {
                const { endpoint, query } = charactersQuery(opts);
                return res.json(parseListing(await request(req, 'GET', endpoint, { query })));
            }

            // /fresh pages its two windows on separate offsets and takes no
            // tag/NSFW parameters at all, so those filters run on the rows here.
            const { endpoint, query, windowKey } = freshQuery(opts);
            const data = await request(req, 'GET', endpoint, { query });
            const listing = parseListing(data?.windows?.[windowKey] ?? {});
            const kept = applyClientFilters(listing.items, {
                nsfw: opts.nsfw,
                requiredTagNames: await tagNamesFor(req, opts.tagIds),
            });
            return res.json({ ...listing, items: kept });
        } catch (error) {
            console.warn('[Weaver\'s Vault] datacat search failed:', error.message);
            return fail(res, error);
        }
    });

    router.post('/datacat/tags', async (req, res) => {
        try {
            return res.json({ tags: (await fetchTags(req)).map(t => t.name) });
        } catch (error) {
            return fail(res, error);
        }
    });

    // The public profile behind a row: long description, full tag list, notes.
    router.get('/datacat/character', async (req, res) => {
        try {
            const id = String(req.query?.id ?? '');
            if (!id) return res.status(400).json({ error: 'id required' });
            const sourceKind = req.query?.sourceKind ? String(req.query.sourceKind) : undefined;
            const data = await request(req, 'GET', `/characters/${encodeURIComponent(id)}`, { query: { sourceKind } });
            const character = data?.character && typeof data.character === 'object' ? data.character : data;
            return res.json({ summary: normalizeSummary(character) });
        } catch (error) {
            console.warn('[Weaver\'s Vault] datacat character failed:', error.message);
            return fail(res, error);
        }
    });

    // Starts the hosted human-verification challenge. The app never solves the
    // challenge itself: the server hands back a URL that already carries the
    // device code and the user finishes it in a tab.
    router.post('/datacat/verify/start', async (req, res) => {
        try {
            const caps = await capabilities(req);
            const flow = parseDeviceFlow(await request(req, 'POST', '/verifications', {
                body: deviceBody(installationId(req), { action: verificationAction(caps) }),
            }));
            if (!flow.id || !flow.uri) {
                return res.status(502).json({ error: 'DataCat did not return a verification challenge' });
            }
            return res.json(flow);
        } catch (error) {
            console.warn('[Weaver\'s Vault] datacat verify start failed:', error.message);
            return fail(res, error);
        }
    });

    router.post('/datacat/verify/poll', async (req, res) => {
        try {
            const flowId = String(req.body?.flowId ?? '');
            const deviceCode = String(req.body?.deviceCode ?? '');
            if (!flowId || !deviceCode) return res.status(400).json({ error: 'flowId and deviceCode required' });
            const data = await request(req, 'POST', `/verifications/${encodeURIComponent(flowId)}/token`, {
                body: deviceBody(installationId(req), { deviceCode }),
            });
            const leaseToken = String(data?.leaseToken ?? '');
            if (!leaseToken) return res.json({ pending: true });

            const caps = await capabilities(req);
            const absolute = Date.parse(String(data?.expiresAt ?? ''));
            const expiresInSeconds = Number(data?.expiresIn);
            const expiresAt = Number.isFinite(absolute)
                ? absolute
                : Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
                    ? expiresInSeconds * 1000
                    : caps.leaseTtlSeconds * 1000);
            leases.store(
                leaseToken,
                expiresAt,
                Number(data?.remainingUniqueCharacters ?? data?.maxUniqueCharacters),
            );
            return res.json({ verified: true, expiresAt, remaining: leases.remainingBudget });
        } catch (error) {
            // "Not solved yet" is the normal state for most of the poll loop.
            if (error.pending) return res.json({ pending: true, reason: error.message });
            console.warn('[Weaver\'s Vault] datacat verify poll failed:', error.message);
            return fail(res, error);
        }
    });

    /**
     * Protected transfer: the card JSON and the archived image both need a lease
     * *and* the installation id it was issued to (the lease alone is refused as
     * `verificationReason: "missing"`).
     */
    router.post('/datacat/card', async (req, res) => {
        try {
            const id = String(req.body?.id ?? '');
            if (!id) return res.status(400).json({ error: 'id required' });
            const sourceKind = req.body?.sourceKind ? String(req.body.sourceKind) : undefined;
            const installation = installationId(req);
            const query = { sourceKind };

            const cardWithLease = async (lease) => request(req, 'GET', `/characters/${encodeURIComponent(id)}/card`, {
                query,
                auth: { lease, installationId: installation, withInstallationId: true },
            });

            let body = null;
            const existing = leases.leaseFor(id);
            if (existing) {
                try {
                    body = await cardWithLease(existing);
                    leases.noteUsed(id);
                } catch (error) {
                    // A 403 naming an unapproved client id cannot be fixed by
                    // re-verifying — that would put a challenge in front of the
                    // user for nothing.
                    const leaseRefused = error.verificationRequired
                        || (error.isForbidden && !error.isClientNotApproved);
                    if (!leaseRefused) throw error;
                    leases.invalidate();
                }
            }
            if (!body) {
                const lease = leases.leaseFor(id);
                if (!lease) {
                    return res.status(403).json({
                        error: 'This download needs human verification',
                        verificationRequired: true,
                    });
                }
                body = await cardWithLease(lease);
                leases.noteUsed(id);
            }

            const character = cardToCharacter(body, { id, sourceKind: sourceKind ?? '' });

            // A card without its picture is still a card, so a failed image
            // fetch falls back to the built-in default avatar.
            let avatarBytes = null;
            try {
                avatarBytes = await fetchAvatarBytes(req, id, sourceKind);
            } catch (error) {
                console.warn('[Weaver\'s Vault] datacat avatar failed:', error.message);
            }

            const imageBuffer = avatarBytes ?? fs.readFileSync(path.join(serverDirectory, DEFAULT_AVATAR_PATH));
            const cardBuffer = writeCardChunk(imageBuffer, JSON.stringify(character));
            const fileName = `${character.data.name.replace(/[\\/:*?"<>|]/g, '_')}.png`;
            return res.json({
                character,
                file: {
                    buffer: cardBuffer.toString('base64'),
                    fileName,
                    fileType: 'image/png',
                },
                avatarDataUrl: `data:image/png;base64,${cardBuffer.toString('base64')}`,
            });
        } catch (error) {
            console.warn('[Weaver\'s Vault] datacat card failed:', error.message);
            return fail(res, error);
        }
    });

    // Account linking — only community writes need it; browsing and transfers do
    // not, so nothing here is on a startup path.
    router.post('/datacat/link/start', async (req, res) => {
        try {
            const flow = parseDeviceFlow(await request(req, 'POST', '/account-links', {
                body: deviceBody(installationId(req)),
            }));
            if (!flow.id || !flow.uri) return res.status(502).json({ error: 'DataCat did not return a link request' });
            return res.json(flow);
        } catch (error) {
            return fail(res, error);
        }
    });

    router.post('/datacat/link/poll', async (req, res) => {
        try {
            const flowId = String(req.body?.flowId ?? '');
            const deviceCode = String(req.body?.deviceCode ?? '');
            if (!flowId || !deviceCode) return res.status(400).json({ error: 'flowId and deviceCode required' });
            const data = await request(req, 'POST', `/account-links/${encodeURIComponent(flowId)}/token`, {
                body: deviceBody(installationId(req), { deviceCode }),
            });
            const token = String(data?.accessToken ?? '');
            if (!token) return res.json({ pending: true });
            writeSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT, token);
            const account = data?.account ?? {};
            const displayName = String(account.displayName ?? account.username ?? '').trim();
            return res.json({ linked: true, displayName: displayName || undefined });
        } catch (error) {
            if (error.pending) return res.json({ pending: true, reason: error.message });
            return fail(res, error);
        }
    });

    router.post('/datacat/unlink', async (req, res) => {
        try {
            const token = userToken(req);
            if (token) {
                try {
                    await fetch(datacatUrl('/account'), {
                        method: 'DELETE',
                        headers: {
                            ...datacatHeaders(authFor(req, {
                                userToken: token,
                                installationId: installationId(req),
                            })),
                            'User-Agent': VAULT_UA,
                        },
                    });
                } catch { /* the local half runs regardless */ }
            }
            // A token the server already dropped is still one this install must
            // stop sending.
            writeSecret(req.user.directories, SECRET_KEYS.VAULT_DATACAT, '');
            return res.json({ ok: true });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    return router;
}

/** Testing seam: the lease is process state and must be resettable. */
export function resetDatacatState() {
    leases.invalidate();
    capabilitiesCache = null;
    tagsCache = null;
}

export { leases as datacatLeases };
