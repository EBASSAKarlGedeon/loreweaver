import { describe, test, expect } from '@jest/globals';
import {
    fragmentHash,
    assembleFragments,
    parseCompanionId,
    normalizeSaucepanExtraction,
} from '../../src/endpoints/weavers-vault-saucepan.js';

// ---------------------------------------------------------------------------
// Independent reference implementation: BigInt arithmetic instead of the
// production Math.imul/>>>0 path. If the two ever disagree, the port is wrong.
// ---------------------------------------------------------------------------
const MASK32 = 4294967296n;
const FNV_OFFSET = 2166136261n;
const FNV_PRIME = 16777619n;

function refRotl(v, bits) {
    const big = BigInt(v) & (MASK32 - 1n);
    const b = BigInt(bits);
    return ((big << b) | (big >> (32n - b))) & (MASK32 - 1n);
}

function refFragmentHash(mask, derivedKey, text) {
    const bytes = Buffer.from(text, 'utf8');
    let h = FNV_OFFSET;
    h = (h ^ refRotl(mask, 7) ^ refRotl(derivedKey, 13)) & (MASK32 - 1n);
    for (const b of bytes) {
        h = (h ^ BigInt(b)) & (MASK32 - 1n);
        h = (h * FNV_PRIME) & (MASK32 - 1n);
    }
    return Number(h);
}

// Builds a Saucepan-style content object: real fragments (shuffled, with valid
// proofs) + decoy fragments (wrong proofs, interleaved).
function makeFragmentPayload(prose, mask, opts = {}) {
    const { chunkSize = 7, decoys = 3, keyStride = 7919 } = opts;
    const chunks = [];
    for (let i = 0; i < prose.length; i += chunkSize) chunks.push(prose.slice(i, i + chunkSize));
    const fragments = chunks.map((text, i) => {
        // Reading position i must decode to key ^ mask = i * keyStride, so the
        // encoder assigns key = position ^ mask (decoys have no such invariant).
        const position = (i * keyStride) >>> 0;
        const key = (position ^ mask) >>> 0;
        return { key, text, proof: refFragmentHash(mask, position, text) };
    });
    for (let i = 0; i < decoys; i++) {
        const text = `decoy-${i}-${'x'.repeat(5 + i)}`;
        fragments.push({ key: (0xDEAD0000 + i) >>> 0, text, proof: 0x12345678 });
    }
    // Shuffle deterministically-ish (rotate) so order-independence is exercised.
    const rotated = fragments.slice(2).concat(fragments.slice(0, 2));
    return { fragments: rotated, mask };
}

describe('fragmentHash (FNV-1a proof scheme, vs BigInt reference)', () => {
    test('matches the independent BigInt implementation on plain text', () => {
        const cases = [
            [0x12345678, 0x0000ABCD, 'hello world'],
            [0xFFFFFFFF, 0xFFFFFFFF, 'wraparound edge'],
            [0x00000001, 0x7FFFFFFF, 'a'],
            [0xCAFEBABE, 0xDEADBEEF, ''],
        ];
        for (const [mask, derivedKey, text] of cases) {
            expect(fragmentHash(mask, derivedKey, text)).toBe(refFragmentHash(mask, derivedKey, text));
        }
    });

    test('matches on multi-byte UTF-8 (emoji, CJK) — byte iteration must match', () => {
        const texts = [' 👯‍♀️ cheer', '日本語テキスト', 'café ñoño 中文 🎴'];
        for (const text of texts) {
            const mask = 0x5EED1234, derivedKey = 0x00C0FFEE;
            expect(fragmentHash(mask, derivedKey, text)).toBe(refFragmentHash(mask, derivedKey, text));
        }
    });

    test('is 32-bit safe across the full u32 input range (sampled)', () => {
        for (let i = 0; i < 200; i++) {
            const mask = (i * 214013 + 2531011) >>> 0;
            const derivedKey = (i * 1103515245 + 12345) >>> 0;
            const text = `sample-${i}`;
            expect(fragmentHash(mask, derivedKey, text)).toBe(refFragmentHash(mask, derivedKey, text));
        }
    });
});

describe('assembleFragments (decoy-drop, proof validation, key^mask ordering)', () => {
    test('reassembles shuffled real fragments and drops decoys', () => {
        const prose = 'The quick brown fox jumps over the lazy dog and keeps running through the night.';
        const mask = 0x51CE0000;
        const payload = makeFragmentPayload(prose, mask);
        expect(assembleFragments(payload)).toBe(prose);
    });

    test('empty fragments list / malformed content → empty string', () => {
        expect(assembleFragments(null)).toBe('');
        expect(assembleFragments('nope')).toBe('');
        expect(assembleFragments({})).toBe('');
        expect(assembleFragments({ mask: 5, fragments: [] })).toBe('');
        expect(assembleFragments({ mask: 5, fragments: [null, 42, { noText: true }] })).toBe('');
    });

    test('all-decoy payload → empty string (proof rejects everything)', () => {
        const payload = {
            mask: 7,
            fragments: [
                { key: 1, text: 'a', proof: 0 },
                { key: 2, text: 'b', proof: 1 },
            ],
        };
        expect(assembleFragments(payload)).toBe('');
    });

    test('long prose with many chunks + heavy decoys, extreme mask', () => {
        const prose = Array.from({ length: 40 }, (_, i) => `fragment number ${i} of the payload; `).join('');
        const mask = 0xFFFFFFFF;
        const payload = makeFragmentPayload(prose, mask, { chunkSize: 24, decoys: 15, keyStride: 65537 });
        expect(assembleFragments(payload)).toBe(prose);
    });
});

describe('parseCompanionId', () => {
    test('accepts the canonical and variant URL forms', () => {
        const id = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c';
        expect(parseCompanionId(`https://saucepan.ai/companion/${id}`)).toBe(id);
        expect(parseCompanionId(`http://www.saucepan.ai/companion/${id}?x=1`)).toBe(id);
        expect(parseCompanionId(`HTTPS://SAUCEPAN.AI/COMPANION/${id}`)).toBe(id);
        expect(parseCompanionId(`https://saucepan.ai/companion/${id}/extra`)).toBe(id);
    });

    test('rejects non-companion URLs', () => {
        expect(parseCompanionId('https://chub.ai/characters/someone/card')).toBeNull();
        expect(parseCompanionId('https://saucepan.ai/companion/short')).toBeNull();
        expect(parseCompanionId('https://evil.com/companion/a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c')).toBeNull();
        expect(parseCompanionId('')).toBeNull();
    });
});

describe('normalizeSaucepanExtraction', () => {
    const CID = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c';

    function fragmentBody(mask, text) {
        const key = 1234;
        const derivedKey = (key ^ mask) >>> 0;
        return {
            fragments: [{ key, text, proof: refFragmentHash(mask, derivedKey, text) }],
            mask,
        };
    }

    test('builds a V2 card with provenance, notes labels and greetings split', () => {
        const defData = {
            sections: [
                { title: 'Companion Core', content: fragmentBody(0x1000, 'Full character body.') },
                { title: 'Example Dialogue', content: fragmentBody(0x2000, '{{user}}: hi\n{{char}}: hey') },
                { title: 'Advanced Prompt', content: fragmentBody(0x3000, 'You are a meticulous writer.') },
            ],
        };
        const compData = {
            companion: {
                display_name: 'Test Companion',
                short_description: 'A test companion.',
                starting_scenarios_fragments: [
                    { message: fragmentBody(0x4000, 'First greeting.') },
                    { message: fragmentBody(0x5000, 'Second greeting.') },
                ],
                tags: ['fantasy', 'roleplay'],
                image: { id: 'img-1' },
            },
        };
        const out = normalizeSaucepanExtraction(defData, compData, CID);
        expect(out.closed).toBe(false);
        const d = out.character.data;
        expect(out.character.spec).toBe('chara_card_v2');
        expect(d.name).toBe('Test Companion');
        expect(d.description).toBe('Full character body.');
        expect(d.first_mes).toBe('First greeting.');
        expect(d.alternate_greetings).toEqual(['Second greeting.']);
        expect(d.mes_example).toBe('{{user}}: hi\n{{char}}: hey');
        expect(d.creator_notes).toBe('A test companion.\n\n--- Advanced Prompt ---\nYou are a meticulous writer.');
        expect(d.tags).toEqual(['fantasy', 'roleplay']);
        expect(d.extensions).toEqual({
            vault_source: 'saucepan',
            vault_full_path: CID,
            vault_url: `https://saucepan.ai/companion/${CID}`,
        });
    });

    test('falls back to full_description_fragments when Companion Core is absent', () => {
        const defData = { sections: [] };
        const compData = {
            companion: {
                display_name: 'Body Only',
                full_description_fragments: fragmentBody(0xABCD, 'Reassembled v2 body.'),
            },
        };
        const out = normalizeSaucepanExtraction(defData, compData, CID);
        expect(out.closed).toBe(false);
        expect(out.character.data.description).toBe('Reassembled v2 body.');
        expect(out.character.data.first_mes).toBe('');
    });

    test('closed definition → { closed: true } (no sections, no body, no greetings)', () => {
        const out = normalizeSaucepanExtraction(
            { sections: [] },
            { companion: { starting_scenarios_fragments: [] } },
            CID,
        );
        expect(out.closed).toBe(true);
    });

    test('missing companion (v2 endpoint failure) still imports from sections', () => {
        const defData = {
            sections: [{ title: 'Companion Core', content: fragmentBody(0x777, 'Section-only body.') }],
        };
        const out = normalizeSaucepanExtraction(defData, {}, CID);
        expect(out.closed).toBe(false);
        expect(out.character.data.name).toBe('Unknown');
        expect(out.character.data.description).toBe('Section-only body.');
        expect(out.character.data.tags).toEqual([]);
    });
});
