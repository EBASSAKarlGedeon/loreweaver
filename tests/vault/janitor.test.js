import { describe, test, expect } from '@jest/globals';
import {
    JANITOR_SORTS,
    classifyJanitorError,
    janitorAccount,
    janitorAvatarUrl,
    janitorBlockReason,
    janitorCardCharacter,
    janitorCardFields,
    janitorCardState,
    janitorCharacterUrl,
    janitorDefinitionPublic,
    janitorHtmlToText,
    janitorPublicUrl,
    janitorSearchUrl,
    janitorSortParam,
    normalizeJanitorRow,
} from '../../src/endpoints/weavers-vault-janitor.js';

/** A detail payload shaped like the live one measured 2026-11-24. */
function closedCard() {
    return {
        id: '938ca9a5-db98-4054-9601-efce37c5ddfb',
        name: 'closed one',
        allow_proxy: true,
        showdefinition: false,
        personality: null,
        scenario: null,
        first_message: null,
        first_messages: null,
        example_dialogs: null,
        scripts: null,
        description: '<p>a <strong>public</strong> bio</p>',
        creator_name: 'kamuisuki',
        creator_id: 'cd5ceb12',
        tags: [{ id: 2, name: '👩\u200d🦰 Female' }],
        custom_tags: ['attackontitan', 'Female'],
        is_public: true,
        is_nsfw: true,
        total_tokens: 1234,
        stats: { chat: 458, message: 4401 },
    };
}

/** The same payload with a visible definition (measured: the first trending row). */
function publicMeta() {
    return {
        ...closedCard(),
        showdefinition: true,
        personality: 'the <strong>public</strong> definition body',
        first_message: 'hello',
        first_messages: ['hello', 'second greeting'],
        scenario: 'a room',
    };
}

describe('janitorAvatarUrl', () => {
    test('resolves the bare CDN key the payload actually carries', () => {
        // Measured: `avatar` is "OGVQcCrx4bguJ-8eKoXm9.webp", not a URL. Fetched
        // as-is it threw and every card silently took the default avatar.
        expect(janitorAvatarUrl('OGVQcCrx4bguJ-8eKoXm9.webp'))
            .toBe('https://ella.janitorai.com/bot-avatars/OGVQcCrx4bguJ-8eKoXm9.webp?width=400');
        expect(janitorAvatarUrl('https://cdn.example/x.webp')).toBe('https://cdn.example/x.webp');
        expect(janitorAvatarUrl('/user-avatars/a.png')).toBe('https://ella.janitorai.com/user-avatars/a.png?width=400');
        expect(janitorAvatarUrl('bot-avatars/deep/x.webp')).toBe('https://ella.janitorai.com/bot-avatars/deep/x.webp?width=400');
        expect(janitorAvatarUrl('')).toBe('');
        expect(janitorAvatarUrl(null)).toBe('');
    });

    test('a listing row exposes the resolved URL, not the key', () => {
        expect(normalizeJanitorRow({ id: 'x', avatar: 'abc.webp' }).avatar)
            .toBe('https://ella.janitorai.com/bot-avatars/abc.webp?width=400');
    });
});

describe('janitorCardCharacter', () => {
    test('carries its own provenance inside the card, like the janny path', () => {
        const card = janitorCardCharacter({ ...publicMeta(), id: '1f452a1d-8d88-4065-83b3-d7697c7aad35' }, { retrievedAt: '2026-11-24T00:00:00.000Z' });
        expect(card.spec).toBe('chara_card_v2');
        expect(card.data.extensions.vault_source).toBe('janitor');
        expect(card.data.extensions.vault_url).toBe('https://janitorai.com/characters/1f452a1d-8d88-4065-83b3-d7697c7aad35');
        expect(card.data.extensions.vault_full_path).toBe('1f452a1d-8d88-4065-83b3-d7697c7aad35');
        expect(card.data.extensions.janitor.retrievedAt).toBe('2026-11-24T00:00:00.000Z');
        // The body is the definition, never the listing bio.
        expect(card.data.description).toContain('public');
        // The bio keeps its formatting now (janitor-html.js), so it arrives as
        // HTML with the credit line — the words are still there.
        expect(card.data.creator_notes).toContain('a <strong>public</strong> bio');
        expect(card.data.creator_notes).toContain('Original bot by @kamuisuki on JanitorAI');
        expect(card.data.personality).toBe('');
    });
});

describe('janitorAccount', () => {
    test('falls back to the handle when the display name is empty', () => {
        // Measured on a second account: `/hampter/profiles/mine` answered 200 with
        // a real id and `name: ''`, so the account read as nameless.
        expect(janitorAccount({ id: 'abc', name: '', user_name: 'Neo' })).toEqual({ signedIn: true, name: 'Neo', id: 'abc' });
        expect(janitorAccount({ id: 'abc', name: 'Yang', user_name: 'Yang Goka' }).name).toBe('Yang');
        expect(janitorAccount({ id: 'abc' }).name).toBe('');
        expect(janitorAccount(null)).toEqual({ signedIn: false, name: '', id: '' });
    });
});

describe('normalizeJanitorRow', () => {
    test('reads a token count from a detail payload, which only has token_counts', () => {
        // Measured on a live public card: the flat field is undefined and the
        // count lives under token_counts, so a listing-shaped reader reports 0.
        const row = normalizeJanitorRow({
            id: '1f452a1d-8d88-4065-83b3-d7697c7aad35',
            name: 'Andy and Nate',
            token_counts: { personality_tokens: 1796, first_message_tokens: 946, total_tokens: 2742 },
        });
        expect(row.tokens).toBe(2742);
        // A listing row still uses its own flat field.
        expect(normalizeJanitorRow({ id: 'x', total_tokens: 1234 }).tokens).toBe(1234);
        expect(normalizeJanitorRow({ id: 'x' }).tokens).toBe(0);
    });
});

describe('janitorSortParam', () => {
    test('accepts only the sorts the site accepts', () => {
        for (const sort of JANITOR_SORTS) expect(janitorSortParam(sort)).toBe(sort);
        // measured: sort=all answers 400, so it must never be forwarded
        expect(janitorSortParam('all')).toBe('trending24');
        expect(janitorSortParam('')).toBe('trending24');
        expect(janitorSortParam(undefined)).toBe('trending24');
        expect(janitorSortParam('POPULAR')).toBe('trending24');
    });
});

describe('janitorSearchUrl', () => {
    test('serialises the parameters exactly as the site expects', () => {
        const url = new URL(janitorSearchUrl({
            page: 3, sort: 'popular', search: 'blue hair',
            tagIds: [2, 46], customTags: ['a b'], userIds: ['u1'],
        }));
        expect(url.origin + url.pathname).toBe('https://janitorai.com/hampter/characters');
        expect(url.searchParams.get('page')).toBe('3');
        expect(url.searchParams.get('sort')).toBe('popular');
        expect(url.searchParams.get('mode')).toBe('all');
        expect(url.searchParams.get('search')).toBe('blue hair');
        expect(url.searchParams.getAll('tag_id[]')).toEqual(['2', '46']);
        expect(url.searchParams.getAll('custom_tags[]')).toEqual(['a b']);
        expect(url.searchParams.getAll('user_id[]')).toEqual(['u1']);
    });

    test('drops junk ids and empty strings instead of sending them', () => {
        const url = new URL(janitorSearchUrl({ tagIds: ['0', '-1', 'x', '2.5', '', '7'], customTags: ['', '  ', 'ok'] }));
        expect(url.searchParams.getAll('tag_id[]')).toEqual(['7']);
        expect(url.searchParams.getAll('custom_tags[]')).toEqual(['ok']);
    });

    test('mode is either all or sfw, never arbitrary', () => {
        expect(new URL(janitorSearchUrl({ mode: 'nsfl' })).searchParams.get('mode')).toBe('all');
        expect(new URL(janitorSearchUrl({ mode: 'sfw' })).searchParams.get('mode')).toBe('sfw');
    });
});

describe('janitorCharacterUrl', () => {
    test('accepts a uuid and rejects anything else', () => {
        expect(janitorCharacterUrl('938ca9a5-db98-4054-9601-efce37c5ddfb'))
            .toBe('https://janitorai.com/hampter/characters/938ca9a5-db98-4054-9601-efce37c5ddfb');
        expect(() => janitorCharacterUrl('')).toThrow(/character id/);
        expect(() => janitorCharacterUrl('../../etc/passwd')).toThrow(/character id/);
    });

    test('public URL is the page a user would open', () => {
        expect(janitorPublicUrl('abc-123')).toBe('https://janitorai.com/characters/abc-123');
    });
});

describe('janitorBlockReason / janitorCardState', () => {
    test('a closed card is importable but not readable', () => {
        expect(janitorBlockReason(closedCard())).toBeNull();
        expect(janitorCardState(closedCard())).toBe('closed');
    });

    test('unproxyable is detected from either flag name', () => {
        expect(janitorCardState({ ...closedCard(), is_proxy_enabled: false })).toBe('unproxyable');
        expect(janitorCardState({ ...closedCard(), allow_proxy: false })).toBe('unproxyable');
    });

    test('deleted and private are refused before any browser work', () => {
        expect(janitorCardState({ ...closedCard(), is_deleted: true })).toBe('deleted');
        expect(janitorCardState({ ...closedCard(), is_force_remove: true })).toBe('deleted');
        expect(janitorCardState({ ...closedCard(), is_public: false })).toBe('private');
        expect(janitorCardState(null)).toBe('missing');
    });

    test('public requires both showdefinition and a non-empty field', () => {
        expect(janitorDefinitionPublic({ showdefinition: true, personality: 'text' })).toBe(true);
        expect(janitorDefinitionPublic({ showdefinition: true, scenario: 'scene' })).toBe(true);
        // advertises it, sends nothing: the live shape of a closed card
        expect(janitorDefinitionPublic({ showdefinition: true, personality: null })).toBe(false);
        expect(janitorDefinitionPublic({ showdefinition: true, personality: '   ' })).toBe(false);
        expect(janitorDefinitionPublic({ showdefinition: false, personality: 'text' })).toBe(false);
        expect(janitorCardState({ showdefinition: true, personality: 'x', allow_proxy: true })).toBe('public');
    });
});

describe('janitorCardFields', () => {
    test('the body is personality, never the public bio', () => {
        const fields = janitorCardFields({ ...closedCard(), personality: 'THE BODY', showdefinition: true });
        expect(fields.description).toBe('THE BODY');
        expect(fields.creator_notes).toContain('a <strong>public</strong> bio');
        expect(fields.creator_notes).not.toContain('THE BODY');
        expect(fields.personality).toBe('');
    });

    test('recovered text overrides the public personality', () => {
        const fields = janitorCardFields({ ...closedCard(), personality: 'public' }, { body: 'recovered' });
        expect(fields.description).toBe('recovered');
    });

    test('a closed card yields an empty body rather than the bio', () => {
        const fields = janitorCardFields(closedCard());
        expect(fields.description).toBe('');
        expect(fields.creator_notes).toContain('a <strong>public</strong> bio');
    });

    test('the bio keeps its formatting and gets the credit line', () => {
        // S6: the bio is converted, not flattened — a card whose bio used bold,
        // links and images kept none of that before.
        const fields = janitorCardFields({
            ...closedCard(),
            creator_name: 'Someone',
            description: '<p>Look at <strong>this</strong> <a href="/external-link?to=https%3A%2F%2Fexample.com">link</a></p>',
        });
        expect(fields.creator_notes).toContain('<strong>this</strong>');
        expect(fields.creator_notes).toContain('href="https://example.com"');
        expect(fields.creator_notes).toContain('Original bot by @Someone on JanitorAI');
        expect(fields.creator_notes).not.toContain('class=');
    });

    test('an empty bio stays empty instead of becoming a credit-only card', () => {
        expect(janitorCardFields({ ...closedCard(), description: '' }).creator_notes).toBe('');
    });

    test('greetings: first_message primary, the rest become alternates', () => {
        const fields = janitorCardFields({
            ...closedCard(),
            first_message: 'one',
            first_messages: ['one', 'two', 'three', ''],
        });
        expect(fields.first_mes).toBe('one');
        expect(fields.alternate_greetings).toEqual(['two', 'three']);
        const noPrimary = janitorCardFields({ ...closedCard(), first_messages: ['first', 'second'] });
        expect(noPrimary.first_mes).toBe('first');
        expect(noPrimary.alternate_greetings).toEqual(['second']);
    });

    test('example_dialogs wins over mes_example, and tags are deduped', () => {
        const fields = janitorCardFields({ ...closedCard(), example_dialogs: 'dialogs', mes_example: 'mes' });
        expect(fields.mes_example).toBe('dialogs');
        // tag names and custom tags collapse to one list without duplicates
        expect(fields.tags).toEqual(['👩\u200d🦰 Female', 'attackontitan']);
    });

    test('missing metadata produces empty strings, not undefined', () => {
        const fields = janitorCardFields(null);
        for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'creator', 'creatorId']) {
            expect(fields[key]).toBe('');
        }
        expect(fields.tags).toEqual([]);
        expect(fields.alternate_greetings).toEqual([]);
    });
});

describe('janitorHtmlToText', () => {
    test('keeps the text and drops the markup', () => {
        expect(janitorHtmlToText('<p>hello <strong>world</strong></p><script>x()</script>')).toBe('hello world');
        expect(janitorHtmlToText('a<br>b')).toBe('a\nb');
        expect(janitorHtmlToText('&amp; &lt;tag&gt; &quot;q&quot;')).toBe('& <tag> "q"');
        expect(janitorHtmlToText(null)).toBe('');
    });
});

describe('janitorAccount', () => {
    test('reads an identity from the payload variants', () => {
        expect(janitorAccount({ id: 'u1', handle: 'gedeon' })).toEqual({ signedIn: true, name: 'gedeon', id: 'u1' });
        expect(janitorAccount({ data: { id: 'u2', username: 'other' } })).toEqual({ signedIn: true, name: 'other', id: 'u2' });
        expect(janitorAccount({ name: 'display' }).signedIn).toBe(true);
    });

    test('an empty or anonymous payload is signed out', () => {
        expect(janitorAccount({})).toEqual({ signedIn: false, name: '', id: '' });
        expect(janitorAccount(null).signedIn).toBe(false);
        expect(janitorAccount('nope').signedIn).toBe(false);
    });
});

describe('classifyJanitorError', () => {
    test('a challenge and a missing account ask for different fixes', () => {
        expect(classifyJanitorError({ status: 403, challenged: true }).code).toBe('janitor_challenge');
        expect(classifyJanitorError({ status: 401 }).code).toBe('janitor_signed_out');
        expect(classifyJanitorError({ status: 403 }).code).toBe('janitor_signed_out');
        expect(classifyJanitorError({ status: 429 }).code).toBe('janitor_rate_limited');
        expect(classifyJanitorError({ status: 404 }).code).toBe('janitor_missing');
        expect(classifyJanitorError({ status: -1, body: 'ECONNRESET' }).code).toBe('janitor_unreachable');
        expect(classifyJanitorError({ status: 500 }).code).toBe('janitor_error');
    });
});

describe('normalizeJanitorRow', () => {
    test('a listing row carries no definition, and says so', () => {
        const row = normalizeJanitorRow(closedCard());
        expect(row.source).toBe('janitor');
        expect(row.id).toBe('938ca9a5-db98-4054-9601-efce37c5ddfb');
        expect(row.url).toBe('https://janitorai.com/characters/938ca9a5-db98-4054-9601-efce37c5ddfb');
        expect(row.showDefinition).toBe(false);
        expect(row.proxyEnabled).toBe(true);
        expect(row.nsfw).toBe(true);
        expect(row.tokens).toBe(1234);
        expect(row.chats).toBe(458);
        expect(row.customTags).toEqual(['attackontitan', 'Female']);
        expect(row.tagIds).toEqual(['2']);
    });

    test('proxyEnabled follows either flag, defaulting to allowed', () => {
        expect(normalizeJanitorRow({ is_proxy_enabled: false }).proxyEnabled).toBe(false);
        expect(normalizeJanitorRow({ allow_proxy: false }).proxyEnabled).toBe(false);
        expect(normalizeJanitorRow({}).proxyEnabled).toBe(true);
    });
});
