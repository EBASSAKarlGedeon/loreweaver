/**
 * M4 · Saucepan (saucepan.ai) extraction logic — ported from Glaze
 * saucepan_extractor.dart (a Dart port of JAR's saucepan.js, itself Saucepan's
 * client scheme). Pure functions only (no config/secrets imports) so the
 * fragment-reassembly port is unit-testable in isolation.
 *
 * Companion definitions ship as a SHUFFLED list of text fragments padded with
 * DECOY fragments. Each real fragment carries a `proof` hash the decoys fail;
 * reassembly validates the proof, orders the survivors by `key ^ mask`, and
 * concatenates. 32-bit unsigned math throughout — `Math.imul(h, prime) >>> 0`
 * because h * prime can exceed 2^53 (the Dart port's reason too).
 */

export const SAUCEPAN_BASE = 'https://saucepan.ai';
export const SAUCEPAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export const SAUCEPAN_CLOSED_MESSAGE =
    'This companion has a closed definition. Glaze cannot import it, and does not plan to support closed definitions.';

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function rotl32(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export function fragmentHash(mask, derivedKey, text) {
    const bytes = Buffer.from(text, 'utf8');
    let h = (FNV_OFFSET ^ rotl32(mask, 7) ^ rotl32(derivedKey, 13)) >>> 0;
    for (const b of bytes) {
        h ^= b;
        h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h >>> 0;
}

function u32(v) {
    return typeof v === 'number' && Number.isFinite(v) ? (v >>> 0) : 0;
}

export function assembleFragments(content) {
    if (!content || typeof content !== 'object' || !Array.isArray(content.fragments)) return '';
    const mask = u32(content.mask);
    const kept = [];
    for (const f of content.fragments) {
        if (!f || typeof f !== 'object' || typeof f.text !== 'string') continue;
        const key = u32(f.key);
        const derivedKey = (key ^ mask) >>> 0;
        if (fragmentHash(mask, derivedKey, f.text) === u32(f.proof)) {
            kept.push({ k: derivedKey, text: f.text });
        }
    }
    kept.sort((a, b) => a.k - b.k);
    return kept.map(e => e.text).join('');
}

export function parseCompanionId(url) {
    const m = /saucepan\.ai\/companion\/([a-f0-9-]{8,64})/i.exec(String(url));
    return m ? m[1] : null;
}

export function saucepanHeaders(token, extra = {}) {
    return {
        'User-Agent': SAUCEPAN_UA,
        Accept: '*/*',
        Origin: SAUCEPAN_BASE,
        Referer: `${SAUCEPAN_BASE}/`,
        'x-saucepan-client-version': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
    };
}

export async function saucepanGetJson(path, token) {
    const response = await fetch(`${SAUCEPAN_BASE}${path}`, { headers: saucepanHeaders(token) });
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json error body */ }
    return { status: response.status, data };
}

/**
 * Handle + password login (saucepan_extractor.dart login): mints a bearer
 * token that gates local extraction. The password is only sent to Saucepan —
 * the caller stores just the returned token.
 */
export async function saucepanLogin(handle, password) {
    const response = await fetch(`${SAUCEPAN_BASE}/api/v1/auth/sign_in_password`, {
        method: 'POST',
        headers: {
            ...saucepanHeaders(),
            'Content-Type': 'application/json',
            Referer: `${SAUCEPAN_BASE}/sign-in`,
        },
        body: JSON.stringify({ handle: handle.trim(), password }),
    });
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json error body */ }
    if (response.status >= 400) {
        const msg = (data?.error && typeof data.error === 'object' ? data.error.message : null)
            ?? `Saucepan HTTP ${response.status}`;
        const err = new Error(msg);
        err.status = response.status;
        throw err;
    }
    const token = [data?.token, data?.access_token, data?.session_token, data?.sessionToken]
        .find(t => typeof t === 'string' && t.length > 0);
    if (!token) {
        throw new Error('login succeeded but no token was returned');
    }
    return token;
}

/**
 * Pure normalization of a Saucepan extraction (definition + v2 companion JSON)
 * into a TavernCardV2 with vault provenance stamped in. Mirrors
 * saucepan_extractor.dart's extractCompanion body exactly.
 */
export function normalizeSaucepanExtraction(defData, compData, companionId) {
    const sections = new Map();
    const rawSections = Array.isArray(defData?.sections) ? defData.sections : [];
    for (const s of rawSections) {
        if (s && typeof s.title === 'string' && s.content != null) {
            sections.set(s.title, assembleFragments(s.content));
        }
    }
    const comp = compData && typeof compData === 'object' ? (compData.companion ?? null) : null;

    // Body: prefer the definition's "Companion Core", fall back to the v2 body.
    let description = sections.get('Companion Core') ?? '';
    if (!description && comp?.full_description_fragments != null) {
        description = assembleFragments(comp.full_description_fragments);
    }

    // Greetings live only on the v2 companion as starting scenarios.
    const greetings = [];
    if (Array.isArray(comp?.starting_scenarios_fragments)) {
        for (const sc of comp.starting_scenarios_fragments) {
            const text = sc && typeof sc === 'object' ? assembleFragments(sc.message) : '';
            if (text.trim()) greetings.push(text);
        }
    }

    // No sections, no reassembled body, no greetings = a definition withheld
    // from third-party clients (the closed case), not an empty character.
    if (sections.size === 0 && !description.trim() && greetings.length === 0) {
        return { closed: true };
    }

    // Advanced Prompt / Response Formatting have no dedicated V2 field — keep
    // them (labeled) in creator notes so nothing authored is silently dropped.
    const notesParts = [];
    const shortDesc = String(comp?.short_description ?? '').trim();
    if (shortDesc) notesParts.push(shortDesc);
    const advancedPrompt = sections.get('Advanced Prompt');
    if (advancedPrompt) notesParts.push(`--- Advanced Prompt ---\n${advancedPrompt}`);
    const responseFormatting = sections.get('Response Formatting Instructions');
    if (responseFormatting) notesParts.push(`--- Response Formatting ---\n${responseFormatting}`);

    const tags = Array.isArray(comp?.tags) ? comp.tags.map(t => String(t)) : [];
    const name = String(comp?.display_name ?? comp?.name ?? 'Unknown');

    const character = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality: '',
            scenario: '',
            first_mes: greetings[0] ?? '',
            mes_example: sections.get('Example Dialogue') ?? '',
            creator_notes: notesParts.join('\n\n'),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: greetings.slice(1),
            tags,
            creator: '',
            character_version: '',
            extensions: {
                vault_source: 'saucepan',
                vault_full_path: companionId,
                vault_url: `${SAUCEPAN_BASE}/companion/${companionId}`,
            },
        },
    };
    return { closed: false, character };
}
