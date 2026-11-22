import { describe, test, expect } from '@jest/globals';
import {
    DATACAT_BASE,
    DATACAT_TRANSFER_ACTION,
    DATACAT_CLIENT_NAME,
    DATACAT_NSFW_TAG_ID,
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
    makeInstallationId,
    normalizeSummary,
    parseCapabilities,
    parseDeviceFlow,
    parseListing,
    resolveSort,
    verificationAction,
} from '../../src/endpoints/weavers-vault-datacat.js';

describe('installation id', () => {
    test('accepts 16–160 chars of [A-Za-z0-9._:-] and nothing else', () => {
        expect(isValidInstallationId('a'.repeat(16))).toBe(true);
        expect(isValidInstallationId('a'.repeat(160))).toBe(true);
        expect(isValidInstallationId('a'.repeat(15))).toBe(false);
        expect(isValidInstallationId('a'.repeat(161))).toBe(false);
        expect(isValidInstallationId('bad id with spaces!')).toBe(false);
        expect(isValidInstallationId(null)).toBe(false);
    });

    test('generated ids are valid and shaped like a uuid', () => {
        const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
        const id = makeInstallationId(bytes);
        expect(isValidInstallationId(id)).toBe(true);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('deviceBody', () => {
    test('carries installationId on the body, with clientName and version', () => {
        const body = deviceBody('inst-0123456789abcdef');
        expect(body).toEqual({
            installationId: 'inst-0123456789abcdef',
            clientName: DATACAT_CLIENT_NAME,
            clientVersion: '1.0.0',
        });
    });

    test('merges extras last (deviceCode, action)', () => {
        const body = deviceBody('inst-0123456789abcdef', { deviceCode: 'dc-1', action: 'character-import' });
        expect(body.deviceCode).toBe('dc-1');
        expect(body.action).toBe('character-import');
        expect(body.installationId).toBe('inst-0123456789abcdef');
    });
});

describe('datacatHeaders', () => {
    test('client id alone for discovery', () => {
        expect(datacatHeaders({ clientId: 'cid' })).toEqual({
            Accept: 'application/json',
            'X-Datacat-Client-Id': 'cid',
        });
    });

    test('a lease is useless without the installation id, so both are sent', () => {
        const h = datacatHeaders({ clientId: 'cid', lease: 'lease-1', installationId: 'inst-1', withInstallationId: true });
        expect(h['X-Datacat-Verification-Lease']).toBe('lease-1');
        expect(h['X-Datacat-Installation-Id']).toBe('inst-1');
    });

    test('a user token always drags the installation id along', () => {
        const h = datacatHeaders({ clientId: 'cid', userToken: 'dcv1_x', installationId: 'inst-1' });
        expect(h.Authorization).toBe('Bearer dcv1_x');
        expect(h['X-Datacat-Installation-Id']).toBe('inst-1');
    });

    test('no credentials → only Accept (and nothing empty)', () => {
        expect(datacatHeaders()).toEqual({ Accept: 'application/json' });
        expect(datacatHeaders({ clientId: '', userToken: '', lease: '' })).toEqual({ Accept: 'application/json' });
    });
});

describe('datacatUrl', () => {
    test('drops null/empty and joins lists with commas', () => {
        const url = datacatUrl('/characters', { search: '', tagIds: [3, 4], sort: 'fresh', offset: 0, limit: null });
        expect(url).toBe(`${DATACAT_BASE}/characters?tagIds=3%2C4&sort=fresh&offset=0`);
    });

    test('no query → bare path', () => {
        expect(datacatUrl('/capabilities')).toBe(`${DATACAT_BASE}/capabilities`);
    });
});

describe('parseCapabilities', () => {
    test('reads paging/features/security and falls back to documented defaults', () => {
        const caps = parseCapabilities({
            paging: { defaultPageSize: 30, maxPageSize: 60 },
            features: { listing: true, tagBrowsing: false },
            securityCheck: { enabled: true, actions: ['character-import'], leaseTtlSeconds: 900 },
        });
        expect(caps.defaultPageSize).toBe(30);
        expect(caps.maxPageSize).toBe(60);
        expect(caps.tagBrowsing).toBe(false);
        expect(caps.social).toBe(true);
        expect(caps.verificationActions).toEqual(['character-import']);
        expect(caps.leaseTtlSeconds).toBe(900);
    });

    test('garbage/absent body → defaults, never throws', () => {
        const caps = parseCapabilities(undefined);
        expect(caps).toEqual({
            defaultPageSize: 24, maxPageSize: 24, listing: true, tagBrowsing: true,
            social: true, securityCheckEnabled: true, verificationActions: [], leaseTtlSeconds: 1800,
        });
    });

    test('the action comes from capabilities, else the live server value', () => {
        expect(verificationAction(parseCapabilities({ securityCheck: { actions: ['character-import-v2'] } })))
            .toBe('character-import-v2');
        expect(verificationAction(parseCapabilities({}))).toBe(DATACAT_TRANSFER_ACTION);
        expect(DATACAT_TRANSFER_ACTION).toBe('character-import');
    });
});

describe('resolveSort', () => {
    test('current fields win over the legacy table', () => {
        expect(resolveSort('score', 'week')).toEqual({ field: 'score', window: 'week' });
        expect(resolveSort('fresh', 'all')).toEqual({ field: 'fresh', window: 'all' });
    });

    test('legacy keys are translated, not reset', () => {
        expect(resolveSort('score_week')).toEqual({ field: 'score', window: 'week' });
        expect(resolveSort('chat_count_24h')).toEqual({ field: 'chat_count', window: '24h' });
    });

    test('unknown → first field, all time', () => {
        expect(resolveSort('nonsense', 'week')).toEqual({ field: 'fresh', window: 'all' });
        expect(resolveSort(undefined, undefined)).toEqual({ field: 'fresh', window: 'all' });
    });
});

describe('listing queries', () => {
    test('/characters: search, blocked adult tag, clamped offset/limit', () => {
        const { endpoint, query } = charactersQuery({ query: 'elf', offset: 999999, limit: 5000, maxPageSize: 50, tagIds: [1, 2], nsfw: false });
        expect(endpoint).toBe('/characters');
        expect(query.search).toBe('elf');
        expect(query.blockedTagIds).toEqual([DATACAT_NSFW_TAG_ID]);
        expect(query.offset).toBe(10000);
        expect(query.limit).toBe(50);
        expect(query.tagIds).toEqual([1, 2]);
    });

    test('/characters: NSFW on → no blocked tags; empty search omitted', () => {
        const { query } = charactersQuery({ query: '', nsfw: true });
        expect(query.blockedTagIds).toBeNull();
        expect(query.search).toBeNull();
    });

    test('/fresh: pages one window at a time and sends no tag/nsfw params', () => {
        const week = freshQuery({ sort: 'score', window: 'week', offset: 48, limit: 24 });
        expect(week.endpoint).toBe('/fresh');
        expect(week.query).toEqual({ sort: 'score', limit: 24, offset24: 0, offsetWeek: 48 });
        expect(week.query.blockedTagIds).toBeUndefined();
        expect(week.query.tagIds).toBeUndefined();

        const day = freshQuery({ sort: 'score', window: '24h', offset: 24 });
        expect(day.query).toEqual({ sort: 'score', limit: 24, offset24: 24, offsetWeek: 0 });
        expect(day.windowKey).toBe('last24h');
        expect(week.windowKey).toBe('thisWeek');
    });
});

describe('normalizeSummary', () => {
    test('derives the SFW/NSFW chip from the flag and dedupes tags', () => {
        const item = normalizeSummary({
            id: 'abc',
            name: 'Elf',
            nsfw: true,
            tags: [{ name: 'fantasy' }, 'NSFW', { slug: 'adventure' }],
            totalTokens: 1200,
            stats: { chats: 5, messages: 40 },
            creator: { name: 'someone', id: 'c1' },
            avatarUrl: 'https://cdn/x.png',
            sourceKind: 'chub',
        });
        expect(item.tags).toEqual(['NSFW', 'fantasy', 'adventure']);
        expect(item.tokens).toBe(1200);
        expect(item.chatCount).toBe(5);
        expect(item.messageCount).toBe(40);
        expect(item.creator).toBe('someone');
        expect(item.nsfw).toBe(true);
        expect(item.source).toBe('datacat');
    });

    test('falls back name → chatName → Unknown, image.url for the avatar', () => {
        expect(normalizeSummary({ name: '', chatName: 'Chatty' }).name).toBe('Chatty');
        expect(normalizeSummary({}).name).toBe('Unknown');
        expect(normalizeSummary({ image: { url: 'https://cdn/y.png' } }).avatarUrl).toBe('https://cdn/y.png');
        expect(normalizeSummary({}).tags).toEqual(['SFW']);
    });
});

describe('applyClientFilters', () => {
    const rows = [
        { id: '1', nsfw: true, tags: ['NSFW', 'elf'] },
        { id: '2', nsfw: false, tags: ['SFW', 'elf', 'royal'] },
        { id: '3', nsfw: false, tags: ['SFW', 'orc'] },
    ];

    test('drops adult rows when NSFW is off', () => {
        expect(applyClientFilters(rows, { nsfw: false }).map(r => r.id)).toEqual(['2', '3']);
    });

    test('keeps everything when NSFW is on and no tag is required', () => {
        expect(applyClientFilters(rows, { nsfw: true })).toBe(rows);
    });

    test('requires every requested tag, case-insensitively', () => {
        expect(applyClientFilters(rows, { nsfw: true, requiredTagNames: ['ELF', 'Royal'] }).map(r => r.id)).toEqual(['2']);
    });
});

describe('parseListing', () => {
    test('reads rows and the server cursor', () => {
        const out = parseListing({ characters: [{ id: 'a' }, { id: 'b' }], paging: { total: 90, hasMore: true, nextOffset: 40 } });
        expect(out.items).toHaveLength(2);
        expect(out.total).toBe(90);
        expect(out.hasMore).toBe(true);
        expect(out.nextOffset).toBe(40);
    });

    test('/fresh windows wrap the same shape', () => {
        const out = parseListing({ characters: [{ id: 'a' }], paging: { total: 1, hasMore: false, offset: 0 } });
        expect(out.nextOffset).toBe(1);
        expect(parseListing({}).items).toEqual([]);
    });
});

describe('cardToCharacter', () => {
    const card = {
        spec: 'chara_card_v2',
        data: {
            name: 'Elf Queen',
            description: 'body',
            personality: 'stern',
            scenario: 'court',
            first_mes: 'Hello.',
            alternate_greetings: ['Hi.', 'Hello.', '  '],
            mes_example: 'ex',
            creator_notes: 'notes',
            system_prompt: 'sys',
            post_history_instructions: 'phi',
            tags: ['elf', '', 5],
            creator: 'me',
            character_version: '1.2',
            character_book: { entries: [] },
        },
    };

    test('normalizes greetings (dedupe + trim-drop) and keeps the book', () => {
        const out = cardToCharacter(card, { id: 'abc', sourceKind: 'chub' });
        expect(out.spec).toBe('chara_card_v2');
        expect(out.data.name).toBe('Elf Queen');
        expect(out.data.first_mes).toBe('Hello.');
        expect(out.data.alternate_greetings).toEqual(['Hi.']);
        expect(out.data.tags).toEqual(['elf']);
        expect(out.data.character_book).toEqual({ entries: [] });
        expect(out.data.character_version).toBe('1.2');
    });

    test('stamps vault provenance + source kind', () => {
        const { extensions } = cardToCharacter(card, { id: 'abc', sourceKind: 'chub' }).data;
        expect(extensions.vault_source).toBe('datacat');
        expect(extensions.vault_full_path).toBe('abc');
        expect(extensions.vault_url).toBe('https://datacat.run/characters/abc');
        expect(extensions.vault_datacat_source_kind).toBe('chub');
    });

    test('accepts {card: …} and {chara_card_v2_json: …} wrappers', () => {
        expect(cardToCharacter({ card }).data.name).toBe('Elf Queen');
        expect(cardToCharacter({ chara_card_v2_json: card }).data.name).toBe('Elf Queen');
        expect(cardToCharacter({ data: { name: 'Bare' } }).data.name).toBe('Bare');
    });

    test('empty body → Unknown, never throws', () => {
        const out = cardToCharacter(undefined, { id: 'x' });
        expect(out.data.name).toBe('Unknown');
        expect(out.data.tags).toEqual([]);
        expect(out.data.alternate_greetings).toEqual([]);
    });
});

describe('LeaseStore', () => {
    test('a fresh lease is spendable and counts distinct characters', () => {
        let now = 1_000_000;
        const store = new LeaseStore({ now: () => now });
        store.store('lease-1', now + 60000, 2);
        expect(store.leaseFor('a')).toBe('lease-1');
        store.noteUsed('a');
        expect(store.leaseFor('a')).toBe('lease-1');   // same character: no new slot
        expect(store.leaseFor('b')).toBe('lease-1');
        store.noteUsed('b');
        expect(store.leaseFor('c')).toBeNull();        // budget spent
        expect(store.remainingBudget).toBe(0);
    });

    test('expires with a 10s margin so a stale lease is never spent', () => {
        let now = 1_000_000;
        const store = new LeaseStore({ now: () => now });
        store.store('lease-1', now + 5000);
        expect(store.leaseFor('a')).toBeNull();
    });

    test('invalidate drops everything; unknown budget falls back to the default', () => {
        let now = 1_000_000;
        const store = new LeaseStore({ now: () => now });
        store.store('lease-1', now + 60000);
        expect(store.remainingBudget).toBe(20);
        store.store('lease-2', now + 60000, 0);
        expect(store.remainingBudget).toBe(20);
        store.invalidate();
        expect(store.leaseFor('a')).toBeNull();
        expect(store.remainingBudget).toBe(0);
    });
});

describe('parseDeviceFlow', () => {
    test('reads a link flow (linkId + userCode + complete uri)', () => {
        const flow = parseDeviceFlow({
            linkId: 'L1', deviceCode: 'DC', userCode: 'AB-12',
            authorizationUriComplete: 'https://datacat.run/link?code=DC',
            expiresIn: 300, interval: 5,
        });
        expect(flow).toEqual({
            id: 'L1', deviceCode: 'DC', userCode: 'AB-12',
            uri: 'https://datacat.run/link?code=DC', expiresIn: 300, interval: 5,
        });
    });

    test('reads a verification flow (verificationId, no userCode)', () => {
        const flow = parseDeviceFlow({ verificationId: 'V1', deviceCode: 'DC', verificationUriComplete: 'https://x/y' });
        expect(flow.id).toBe('V1');
        expect(flow.userCode).toBeNull();
        expect(flow.uri).toBe('https://x/y');
        expect(flow.expiresIn).toBe(600);
        expect(flow.interval).toBe(3);
    });

    test('a zero interval never spins', () => {
        expect(parseDeviceFlow({ interval: 0 }).interval).toBe(1);
    });
});

describe('classifyError', () => {
    test('428 / verification_required → spend a lease', () => {
        expect(classifyError(428, { error: { code: 'verification_required' } }).verificationRequired).toBe(true);
        expect(classifyError(403, { error: { verificationReason: 'missing' } }).verificationRequired).toBe(true);
    });

    test('409 and 428 are "pending", not errors', () => {
        expect(classifyError(409, {}).pending).toBe(true);
        expect(classifyError(428, {}).pending).toBe(true);
        expect(classifyError(500, {}).pending).toBe(false);
    });

    test('a 403 for an unapproved client id must not trigger a re-verify', () => {
        const e = classifyError(403, { error: { code: 'client_not_approved' } });
        expect(e.isForbidden).toBe(true);
        expect(e.isClientNotApproved).toBe(true);
        expect(e.isUnauthorized).toBe(false);
    });

    test('carries a readable message, defaulting to the status', () => {
        expect(classifyError(502, { error: { message: 'boom' } }).message).toBe('boom');
        expect(classifyError(502, {}).message).toBe('DataCat HTTP 502');
    });
});
