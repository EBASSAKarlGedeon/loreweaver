import { describe, test, expect } from '@jest/globals';
import {
    JANNY_BASE,
    JANNY_FALLBACK_TOKEN,
    JANNY_IMAGE_CDN,
    classifyJannyError,
    decodeAstroValue,
    findJannyPropsBlob,
    isJannyChallenge,
    jannyCardFromCharacter,
    jannyCharacterUrl,
    jannySearchAttempts,
    jannySearchBody,
    jannySearchHeaders,
    jannySlugify,
    normalizeJannyHit,
    parseJannyCharacterPage,
    parseJannyMultiSearch,
    parseJannyTagCloud,
    resolveJannyAvatar,
    resolveJannyTagIds,
    JANNY_TAGS_FALLBACK,
    stripJannyHtml,
} from '../../src/endpoints/weavers-vault-janny.js';

/**
 * Ported from Glaze's janny_provider.dart. The Astro fixtures below reproduce the
 * exact `[type, data]` shape the site serves (type 0 = object, 1 = array), taken
 * from a real page captured 2026-11-23.
 */
function astro(value) {
    // Encodes a plain JS value the way Astro serialises props.
    if (Array.isArray(value)) return [1, value.map(astro)];
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = astro(v);
        return [0, out];
    }
    return value;
}

function pageWith(props, { exportAs = 'CharacterButtons', extra = '' } = {}) {
    // `props` values must already be astro-encoded (see astro()); this helper only
    // packs them into an island the way Astro does, escaped for an attribute.
    const encoded = JSON.stringify(props)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    return `<html><body>${extra}
<astro-island uid="1" component-url="/_astro/CharacterButtons.js" component-export="${exportAs}" props="${encoded}"></astro-island>
</body></html>`;
}

const character = {
    id: 'fd74a396-1505-4a75-a722-fc88aba1c963',
    creatorId: 'creator-1',
    name: 'Akumi Shiomi',
    description: '<p>Your <strong>roommate</strong> has her way with you.</p>',
    personality: 'PLOT: roommate stuff. {{char}} is forward.',
    scenario: 'Shared apartment, late night.',
    firstMessage: 'You wake up to a weight on the mattress.',
    exampleDialogs: '<START>\n{{char}}: "Morning."',
    isNsfw: false,
    totalToken: 519,
    avatar: 'nhOmpn7BP4pbeSZ2iKtjM.webp',
    tagIds: [2, 5, 6],
    tags: [{ id: 2, name: 'Female' }, { id: 5, name: 'OC' }],
    creatorName: 'Mist.Foster',
    permanentToken: 91,
};

describe('search contract', () => {
    test('headers match what instant-meilisearch sends', () => {
        const headers = jannySearchHeaders(JANNY_FALLBACK_TOKEN);
        expect(headers.Authorization).toBe(`Bearer ${JANNY_FALLBACK_TOKEN}`);
        expect(headers.Origin).toBe(JANNY_BASE);
        expect(headers.Referer).toBe(`${JANNY_BASE}/`);
        expect(headers['x-meilisearch-client']).toContain('instant-meilisearch');
    });

    test('body asks only for what is read', () => {
        const body = jannySearchBody({ query: 'elf', page: 2, filters: ['isNsfw = false'], sort: ['totalToken:desc'] });
        const query = body.queries[0];
        expect(query.indexUid).toBe('janny-characters');
        expect(query.q).toBe('elf');
        expect(query.page).toBe(2);
        expect(query.hitsPerPage).toBe(40);
        expect(query.filter).toBe('isNsfw = false');
        expect(query.sort).toEqual(['totalToken:desc']);
        // The four attributes Glaze dropped on purpose must stay dropped.
        for (const key of ['facets', 'attributesToHighlight', 'attributesToCrop', 'cropMarker']) {
            expect(query).not.toHaveProperty(key);
        }
    });

    test('omits empty filter/sort rather than sending blank clauses', () => {
        const query = jannySearchBody({ query: '' }).queries[0];
        expect(query).not.toHaveProperty('filter');
        expect(query).not.toHaveProperty('sort');
    });

    test('nsfw clause is mandatory and never dropped by the ladder', () => {
        const attempts = jannySearchAttempts({ nsfw: false, minTokens: 100, tagIds: [7], sort: 'newest' });
        expect(attempts).toHaveLength(3);
        for (const body of attempts) {
            expect(body.queries[0].filter).toContain('isNsfw = false');
        }
        // The last, plainest attempt keeps only the mandatory clause.
        expect(attempts[2].queries[0].filter).toBe('isNsfw = false');
        expect(attempts[0].queries[0].sort).toEqual(['createdAtStamp:desc']);
        expect(attempts[1].queries[0]).not.toHaveProperty('sort');
    });

    test('nsfw=true sends no mandatory filter and a single plain attempt when nothing is preferred', () => {
        const attempts = jannySearchAttempts({ nsfw: true, maxTokens: 100000, sort: 'relevant' });
        // No tag filter and no max → preferred is just the minimum token clause.
        expect(attempts[0].queries[0].filter).toBe('totalToken >= 29');
        expect(attempts[0].queries[0]).not.toHaveProperty('sort');
    });

    test('sort presets map to Meilisearch clauses', () => {
        expect(jannySearchAttempts({ sort: 'oldest' })[0].queries[0].sort).toEqual(['createdAtStamp:asc']);
        expect(jannySearchAttempts({ sort: 'tokens_asc' })[0].queries[0].sort).toEqual(['totalToken:asc']);
        expect(jannySearchAttempts({ sort: 'nonsense' })[0].queries[0].sort).toEqual(['createdAtStamp:desc']);
    });

    test('parses the first result page', () => {
        const parsed = parseJannyMultiSearch({
            results: [{ hits: [{ id: 'a' }, { id: 'b' }], totalHits: 4000, page: 3, totalPages: 100 }],
        });
        expect(parsed.hits).toHaveLength(2);
        expect(parsed.total).toBe(4000);
        expect(parsed.page).toBe(3);
        expect(parsed.totalPages).toBe(100);
    });

    test('tolerates a malformed answer', () => {
        expect(parseJannyMultiSearch({})).toEqual({ hits: [], total: 0, page: 1, totalPages: 1 });
        expect(parseJannyMultiSearch(null).hits).toEqual([]);
    });
});

describe('url shaping', () => {
    test('slugify matches Glaze', () => {
        expect(jannySlugify('Fem Pov Futanari roommate - Akumi Shiomi ')).toBe('fem-pov-futanari-roommate-akumi-shiomi');
        expect(jannySlugify('  Spaces   &&&  Dots... ')).toBe('spaces-dots');
        expect(jannySlugify('')).toBe('');
    });

    test('character url is {id}_{character-slug}', () => {
        expect(jannyCharacterUrl('abc-123', 'Akumi Shiomi'))
            .toBe(`${JANNY_BASE}/characters/abc-123_character-akumi-shiomi`);
        // A slug that already starts with the prefix is not double-prefixed.
        expect(jannyCharacterUrl('abc', 'character-foo')).toBe(`${JANNY_BASE}/characters/abc_character-foo`);
        // No name → fall back to the id itself as the slug.
        expect(jannyCharacterUrl('abc-123')).toBe(`${JANNY_BASE}/characters/abc-123_character-abc-123`);
    });

    test('avatar resolution covers bare names, paths and urls', () => {
        expect(resolveJannyAvatar('foo.webp')).toBe(`${JANNY_IMAGE_CDN}foo.webp`);
        expect(resolveJannyAvatar('https://x/y.webp')).toBe('https://x/y.webp');
        expect(resolveJannyAvatar('sub/foo.webp')).toBe('sub/foo.webp');
        expect(resolveJannyAvatar(null)).toBeNull();
    });
});

describe('astro parsing', () => {
    test('decodes type-0 objects and type-1 arrays', () => {
        expect(decodeAstroValue([0, { a: 1, b: [1, [1, 2]] }])).toEqual({ a: 1, b: [1, 2] });
        expect(decodeAstroValue([1, [1, [0, { x: 1 }]]])).toEqual([1, { x: 1 }]);
        expect(decodeAstroValue('plain')).toBe('plain');
        expect(decodeAstroValue(7)).toBe(7);
    });

    test('prefers the CharacterButtons island', () => {
        const html = pageWith({ character: astro(character), imageUrl: astro(`${JANNY_IMAGE_CDN}x.webp`) }, {
            extra: '<astro-island component-export="Other" props="{}"></astro-island>',
        });
        const parsed = parseJannyCharacterPage(html);
        expect(parsed.character.name).toBe('Akumi Shiomi');
        expect(parsed.imageUrl).toBe(`${JANNY_IMAGE_CDN}x.webp`);
    });

    test('falls back to any island mentioning "character"', () => {
        const html = pageWith({ character: astro(character) }, { exportAs: 'SomethingElse' });
        expect(parseJannyCharacterPage(html).character.name).toBe('Akumi Shiomi');
    });

    test('reads the creator from the page body when the island lacks it', () => {
        const html = pageWith({ character: astro({ ...character, creatorName: '' }) }, {
            extra: '<div>Creator: <a href="/creators/x">@Mist.Foster</a></div>',
        });
        expect(parseJannyCharacterPage(html).creatorUsername).toBe('Mist.Foster');
    });

    test('returns null when there is no island', () => {
        expect(findJannyPropsBlob('<html></html>')).toBeNull();
        expect(parseJannyCharacterPage('<html></html>')).toBeNull();
    });

    test('returns null on invalid props json instead of throwing', () => {
        const html = '<astro-island component-export="CharacterButtons" props="{not json}"></astro-island>';
        expect(parseJannyCharacterPage(html)).toBeNull();
    });
});

describe('hit normalisation', () => {
    test('keeps display fields and strips the blurb html', () => {
        const item = normalizeJannyHit({
            id: 'abc', name: ' Akumi ', description: '<p>Hi &amp; bye</p>',
            avatar: 'x.webp', totalToken: 519, tagIds: [2, 5], isNsfw: true, createdAtStamp: 1795369031.3,
        });
        expect(item).toMatchObject({
            id: 'abc', fullPath: 'abc', name: 'Akumi', description: 'Hi & bye',
            avatarUrl: `${JANNY_IMAGE_CDN}x.webp`, tokens: 519, tagIds: [2, 5],
            nsfw: true, source: 'janny',
        });
        // The grid draws the safety chip from `nsfw`; a 'SFW'/'NSFW' entry here
        // would render a second, redundant chip on every card.
        expect(item.tags).toEqual([]);
    });

    test('the index carries no definition, so none is invented', () => {
        const item = normalizeJannyHit({ id: 'a', name: 'b' });
        expect(item).not.toHaveProperty('personality');
        expect(item).not.toHaveProperty('description_raw');
    });
});

describe('card mapping', () => {
    test('personality becomes description and the blurb becomes creator_notes', () => {
        const card = jannyCardFromCharacter(character, { id: character.id, creatorUsername: 'Mist.Foster' });
        expect(card.spec).toBe('chara_card_v2');
        expect(card.data.name).toBe('Akumi Shiomi');
        expect(card.data.description).toBe(character.personality);
        expect(card.data.personality).toBe('');
        expect(card.data.first_mes).toBe(character.firstMessage);
        expect(card.data.scenario).toBe(character.scenario);
        expect(card.data.mes_example).toBe(character.exampleDialogs);
        expect(card.data.creator_notes).toBe('Your roommate has her way with you.');
        expect(card.data.creator).toBe('Mist.Foster');
        expect(card.data.tags).toEqual(['SFW', 'Female', 'OC']);
    });

    test('stamps provenance the vault uses for cleanup', () => {
        const card = jannyCardFromCharacter(character, { id: character.id });
        expect(card.data.extensions.vault_source).toBe('janny');
        expect(card.data.extensions.vault_full_path).toBe(character.id);
        expect(card.data.extensions.vault_url).toBe(`${JANNY_BASE}/characters/${character.id}`);
        expect(card.data.extensions.janny.totalToken).toBe(519);
    });

    test('survives a sparse record', () => {
        const card = jannyCardFromCharacter({}, {});
        expect(card.data.name).toBe('Unknown');
        expect(card.data.description).toBe('');
        expect(card.data.tags).toEqual(['SFW']);
    });
});

describe('error classification', () => {
    test('challenge detection', () => {
        expect(isJannyChallenge(403, '')).toBe(true);
        expect(isJannyChallenge(503, '')).toBe(true);
        expect(isJannyChallenge(200, '<html>hi</html>')).toBe(false);
        expect(isJannyChallenge(200, 'window._cf_chl_opt = {}')).toBe(true);
    });

    test('maps statuses to actionable causes', () => {
        expect(classifyJannyError(401).code).toBe('janny_auth');
        expect(classifyJannyError(403).code).toBe('janny_auth');
        expect(classifyJannyError(429).code).toBe('janny_rate_limited');
        expect(classifyJannyError(400, '<p>bad sort</p>').message).toContain('bad sort');
        expect(classifyJannyError(403, 'window._cf_chl_opt').code).toBe('janny_auth');
        expect(classifyJannyError(500).code).toBe('janny_error');
    });

    test('stripHtml removes tags and entities', () => {
        expect(stripJannyHtml('<p>a &amp; b</p><br/>')).toBe('a & b');
    });
});

// ---------------------------------------------------------------------------
// Tags. The index only carries numeric tagIds (measured: its filterable
// attributes are createdAtStamp, isLowQuality, isNsfw, permanentToken, tagIds,
// totalToken), so labels are read from the site's own sidebar. The fixture below
// is verbatim markup from a browse page.
// ---------------------------------------------------------------------------
describe('tag vocabulary', () => {
    const sidebarHtml = `
      <ul>
        <li title="Male characters" class="mb-2 mr-2"><a data-astro-reload="true" href="/?query=tsundere&amp;tag_id=1&amp;page=1" class="block px-2 py-1 text-sm">👨‍🦰 Male<!-- --> </a></li>
        <li title="Female characters" class="mb-2 mr-2"><a data-astro-reload="true" href="/?query=tsundere&amp;tag_id=2&amp;page=1" class="block px-2 py-1 text-sm">👩‍🦰 Female<!-- --> </a></li>
        <li title="BDSM - Dominant character" class="mb-2 mr-2"><a data-astro-reload="true" href="/?query=tsundere&amp;tag_id=28&amp;page=1" class="block px-2 py-1 text-sm">⛓️ Dominant<!-- --> </a></li>
        <li title="For bots that are parodies, have silly scenarios, or are intended to make the user laugh." class="mb-2 mr-2"><a data-astro-reload="true" href="/?query=tsundere&amp;tag_id=52&amp;page=1" class="block px-2 py-1 text-sm">😂 Comedy<!-- --> </a></li>
        <li title="For bots written from a female user perspective." class="mb-2 mr-2"><a data-astro-reload="true" href="/?query=tsundere&amp;tag_id=54&amp;page=1" class="block px-2 py-1 text-sm">👩 FemPov<!-- --> </a></li>
      </ul>`;

    test('reads id, label and tooltip out of the sidebar', () => {
        const tags = parseJannyTagCloud(sidebarHtml);
        expect(tags).toEqual([
            { id: 1, name: '👨‍🦰 Male', title: 'Male characters' },
            { id: 2, name: '👩‍🦰 Female', title: 'Female characters' },
            { id: 28, name: '⛓️ Dominant', title: 'BDSM - Dominant character' },
            { id: 52, name: '😂 Comedy', title: 'For bots that are parodies, have silly scenarios, or are intended to make the user laugh.' },
            { id: 54, name: '👩 FemPov', title: 'For bots written from a female user perspective.' },
        ]);
    });

    test('falls back to bare anchors when the list markup changes', () => {
        const html = '<div><a href="/?tag_id=7">👤 Real</a><a href="/?tag_id=9">📺 Anime</a></div>';
        expect(parseJannyTagCloud(html).map(t => `${t.id}:${t.name}`)).toEqual(['7:👤 Real', '9:📺 Anime']);
    });

    test('ignores pages with no tag links', () => {
        expect(parseJannyTagCloud('<html><body>nothing</body></html>')).toEqual([]);
        expect(parseJannyTagCloud('')).toEqual([]);
    });

    test('the fallback list matches the ids the site actually uses', () => {
        // Measured on two real pages: 2,5,42,43,46,52 and 2,5,6,28,48,54.
        const byId = new Map(JANNY_TAGS_FALLBACK.map(t => [t.id, t.name]));
        expect(byId.get(2)).toContain('Female');
        expect(byId.get(5)).toContain('OC');
        expect(byId.get(42)).toContain('AnyPOV');
        expect(byId.get(43)).toContain('Angst');
        expect(byId.get(46)).toContain('Smut');
        expect(byId.get(52)).toContain('Comedy');
        expect(byId.get(54)).toContain('FemPov');
    });

    test('resolves names back to ids, tolerating emoji changes and case', () => {
        const catalog = [
            { id: 2, name: '👩‍🦰 Female' },
            { id: 46, name: '❤️‍🔥 Smut' },
            { id: 52, name: '😂 Comedy' },
        ];
        expect(resolveJannyTagIds(catalog, ['👩‍🦰 Female'])).toEqual([2]);
        // Label without the emoji still resolves.
        expect(resolveJannyTagIds(catalog, ['female'])).toEqual([2]);
        expect(resolveJannyTagIds(catalog, ['SMUT', 52])).toEqual([46, 52]);
        // Unknown names are dropped rather than sent as garbage, and duplicates collapse.
        expect(resolveJannyTagIds(catalog, ['nonsense', 'female', 'Female'])).toEqual([2]);
        expect(resolveJannyTagIds(catalog, [])).toEqual([]);
    });

    test('search body turns tag ids into index clauses', () => {
        const [andBody] = jannySearchAttempts({ tagIds: [2, 46] });
        expect(andBody.queries[0].filter).toContain('tagIds = 2');
        expect(andBody.queries[0].filter).toContain('tagIds = 46');

        const [orBody] = jannySearchAttempts({ tagIds: [2, 46], inclusiveOr: true });
        expect(orBody.queries[0].filter).toContain('tagIds IN [2, 46]');
        expect(orBody.queries[0].filter).not.toContain('tagIds = 2');
    });

    test('one selected tag stays an equality clause even in "match any" mode', () => {
        const [body] = jannySearchAttempts({ tagIds: [46], inclusiveOr: true });
        expect(body.queries[0].filter).toContain('tagIds = 46');
        expect(body.queries[0].filter).not.toContain('IN [');
    });

    test('junk tag ids are ignored instead of breaking the query', () => {
        const [body] = jannySearchAttempts({ tagIds: [0, -1, 'x', 2.5, 3] });
        expect(body.queries[0].filter).toContain('tagIds = 3');
        expect(body.queries[0].filter).not.toContain('tagIds = 0');
        expect(body.queries[0].filter).not.toContain('tagIds = NaN');
    });
});
