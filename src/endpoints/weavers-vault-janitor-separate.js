/**
 * Weaver's Vault — the `/generateAlpha` prompt separator.
 *
 * Port of Glaze's `janitor_separate.dart` (which is itself a port of the
 * SillyTavern `janitor-lorebook` plugin's `separate.cjs`), notes in
 * `docs/janitor-source/janitor_separate.md`.
 *
 * The assembled prompt has a shape this file depends on:
 *
 *     [ jailbreak / system prefix ]
 *     <{{char}}'s Persona> … </…Persona>     <- the hidden card
 *     <UserPersona> … </UserPersona>         <- the user's persona
 *     <Scenario> … </Scenario>
 *     <Example…> … </Example…>
 *     <triggered lorebook entries …>         <- everything left over
 *
 * Pure functions only: no browser, no disk, no network. Everything here is
 * covered by `tests/vault/janitor-separate.test.js`.
 *
 * AGPL-3.0 — part of Loreweaver, forked from SillyTavern.
 */

/** Collapse whitespace, lowercase: the de-duplication and line-match key. */
function norm(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The first `system` message of a captured payload.
 *
 * A payload whose `messages` is not an array answers `''` rather than throwing,
 * because a malformed capture must read as "nothing captured" instead of
 * breaking the import that follows it.
 * @param {unknown} payload
 * @returns {string}
 */
export function getSystemContent(payload) {
    const messages = payload && typeof payload === 'object' ? payload.messages : null;
    if (!Array.isArray(messages)) return '';
    for (const message of messages) {
        if (message && message.role === 'system' && typeof message.content === 'string') {
            return message.content;
        }
    }
    return '';
}

const RE_LEADING_JAILBREAK = /^\s*(?:\[[^\]]*\]\s*)+/;
const RE_PERSONA_BLOCK = /<[^<>\n]*?Persona>[\s\S]*?<\/[^<>\n]*?Persona>/gi;
const RE_SCENARIO_BLOCK = /<Scenario>[\s\S]*?<\/Scenario>/gi;
const RE_EXAMPLE_BLOCK = /<Example[^<>\n]*>[\s\S]*?<\/Example[^<>\n]*>/gi;
// The *block* starts with '<', so the tag test has to allow it: Glaze's pattern
// is `^<\s*userpersona`. Without the '<' every user persona was labelled 'card',
// which made diagnostics read backwards.
const RE_USER_TAG = /^<\s*userpersona/i;

/**
 * Remove the wrapper blocks, keeping what was removed for diagnostics.
 *
 * Each block is replaced with `'\n'`, never `''`: the empty string would glue the
 * lore blocks on either side into one entry. Only the first leading bracketed run
 * is removed, matching the original.
 * @param {string} text
 * @returns {{out: string, removed: Array<{label: string, text: string}>}}
 */
export function stripWrappers(text) {
    const removed = [];
    let out = String(text ?? '');

    out = out.replace(RE_LEADING_JAILBREAK, match => {
        if (match.trim()) removed.push({ label: 'jailbreak', text: match.trim() });
        return '';
    });
    out = out.replace(RE_PERSONA_BLOCK, match => {
        removed.push({ label: RE_USER_TAG.test(match) ? 'userPersona' : 'card', text: match });
        return '\n';
    });
    out = out.replace(RE_SCENARIO_BLOCK, match => {
        removed.push({ label: 'scenario', text: match });
        return '\n';
    });
    out = out.replace(RE_EXAMPLE_BLOCK, match => {
        removed.push({ label: 'example', text: match });
        return '\n';
    });

    return { out, removed };
}

/**
 * Line-set subtraction of the known card from the residue.
 *
 * The 12-character floor is load-bearing: without it a shared short line
 * ("He nods.") deletes real lore.
 * @param {string} text
 * @param {string} knownCard
 * @returns {{out: string, removed: string[]}}
 */
function subtractKnownCard(text, knownCard) {
    const known = new Set();
    for (const line of String(knownCard ?? '').split('\n')) {
        const key = norm(line);
        if (key.length >= 12) known.add(key);
    }
    if (!known.size) return { out: text, removed: [] };
    const kept = [];
    const removed = [];
    for (const line of String(text ?? '').split('\n')) {
        const key = norm(line);
        if (key.length >= 12 && known.has(key)) removed.push(line);
        else kept.push(line);
    }
    return { out: kept.join('\n'), removed };
}

/**
 * A literal needle as a whitespace- and glyph-tolerant pattern.
 *
 * JanitorAI rewrites apostrophes, quotes and dashes between assembled prompts,
 * so a needle has to accept all three variants of each or nothing matches.
 * @param {string} needle
 * @returns {string} a regular expression source
 */
export function loosePattern(needle) {
    const escaped = String(needle ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped
        .replace(/\s+/g, '\\s+')
        .replace(/['\u2018\u2019\u02BC]/g, "['\u2018\u2019\u02BC]")
        .replace(/["\u201C\u201D]/g, '["\u201C\u201D]')
        .replace(/[-\u2013\u2014]/g, '[-\u2013\u2014]');
}

/**
 * @param {string} text
 * @param {string[]} publicContents
 * @returns {{out: string, removed: string[]}}
 */
function stripPublicEntries(text, publicContents) {
    const removed = [];
    let out = String(text ?? '');
    for (const content of publicContents ?? []) {
        const needle = String(content ?? '').trim();
        if (needle.length < 12) continue;
        let pattern;
        try {
            pattern = new RegExp(loosePattern(needle), 'gi');
        } catch {
            // A pathological entry must not take the whole subtraction down.
            continue;
        }
        out = out.replace(pattern, match => {
            removed.push(match);
            return '\n';
        });
    }
    return { out, removed };
}

/** The canonical whitespace shape of all lorebook text in this pipeline. */
export function tidy(text) {
    return String(text ?? '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * @param {string} text
 * @param {string[]} [publicContents]
 * @returns {string}
 */
export function withoutPublicEntries(text, publicContents = []) {
    if (!publicContents.length) return String(text ?? '');
    return tidy(stripPublicEntries(text, publicContents).out);
}

/** Entry boundaries are blank lines. */
export function splitEntries(text) {
    return String(text ?? '')
        .split(/\n\s*\n/)
        .map(entry => entry.trim())
        .filter(Boolean);
}

/**
 * De-duplicate entries across capture passes, keeping first-seen order.
 * @param {string[]} texts
 * @returns {string}
 */
export function mergeLorebookTexts(texts) {
    const seen = new Set();
    const kept = [];
    for (const text of texts ?? []) {
        for (const entry of splitEntries(text)) {
            const key = norm(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push(entry);
        }
    }
    return kept.join('\n\n');
}

/**
 * Everything that is not a wrapper, the card, or a known public entry: the
 * closed lorebook as one string.
 * @param {unknown} payload
 * @param {{knownCard?: string, publicContents?: string[]}} [options]
 * @returns {{systemContent: string, lorebookText: string, removed: Array<{label: string, text: string}>, entries: string[]}}
 */
export function separate(payload, { knownCard = '', publicContents = [] } = {}) {
    const systemContent = getSystemContent(payload);
    const wrapped = stripWrappers(systemContent);
    const subtracted = subtractKnownCard(wrapped.out, knownCard);
    const stripped = stripPublicEntries(subtracted.out, publicContents);
    const lorebookText = tidy(stripped.out);

    const removed = [...wrapped.removed];
    if (subtracted.removed.length) removed.push({ label: 'knownCard', text: subtracted.removed.join('\n') });
    if (stripped.removed.length) removed.push({ label: 'publicLorebook', text: stripped.removed.join('\n\n') });

    return { systemContent, lorebookText, removed, entries: splitEntries(lorebookText) };
}

// ─── field extractors (they read the system content only) ────────────────────

const RE_CARD = /<([^<>\n]*?)Persona>([\s\S]*?)<\/[^<>\n]*?Persona>/gi;
const RE_CHAR_NAME = /<([^<>\n]*?)Persona>/i;
const RE_SCENARIO = /<Scenario>([\s\S]*?)<\/Scenario>/i;
const RE_EXAMPLE = /<Example[^<>\n]*?>([\s\S]*?)<\/Example[^<>\n]*>/i;

/**
 * The hidden card: the first non-user persona block.
 *
 * `<User's Persona>` is skipped by the `^\s*user` test on the tag name, which is
 * the same rule the original uses (and the same blind spot: a card whose own tag
 * begins with "user" would be skipped).
 * @param {unknown} payload
 * @returns {string}
 */
export function extractCard(payload) {
    const content = getSystemContent(payload);
    RE_CARD.lastIndex = 0;
    let match;
    while ((match = RE_CARD.exec(content)) !== null) {
        if (/^\s*user/i.test(match[1] ?? '')) continue;
        return String(match[2] ?? '').trim();
    }
    return '';
}

/**
 * The character name out of the card's own wrapper tag.
 * @param {unknown} payload
 * @returns {string}
 */
export function extractCharName(payload) {
    const match = RE_CHAR_NAME.exec(getSystemContent(payload));
    if (!match) return '';
    const name = String(match[1] ?? '').replace(/['\u2019]s\s*$/i, '').trim();
    return name.toLowerCase() === 'user' ? '' : name;
}

/** @param {unknown} payload @returns {string} */
export function extractScenario(payload) {
    const match = RE_SCENARIO.exec(getSystemContent(payload));
    return match ? String(match[1] ?? '').trim() : '';
}

/** @param {unknown} payload @returns {string} */
export function extractExample(payload) {
    const match = RE_EXAMPLE.exec(getSystemContent(payload));
    return match ? String(match[1] ?? '').trim() : '';
}

/**
 * The opening line: the first assistant turn of the assembled prompt.
 * @param {unknown} payload
 * @returns {string}
 */
export function extractFirstMessage(payload) {
    const messages = payload && typeof payload === 'object' ? payload.messages : null;
    if (!Array.isArray(messages)) return '';
    for (const message of messages) {
        if (message && message.role === 'assistant' && typeof message.content === 'string') {
            return message.content.trim();
        }
    }
    return '';
}

/**
 * Put macros back where the server expanded them.
 *
 * The assembled prompt has already replaced `{{char}}` with the card's name and
 * `{{user}}` with the account's persona name. Both have to be swapped back, or
 * the imported card carries one person's name where the macro belongs — a card
 * whose description says "Hiro" is unusable by any other persona.
 *
 * Names shorter than three characters are skipped: a two-letter name matches
 * everywhere and would shred the text. Names are swapped longest-first so
 * "Anna Lee" is replaced before "Anna", and a persona's display name is handled
 * before its shorter handle for the same reason.
 *
 * `userNames` is the multi-candidate form: the site's profile endpoint carries
 * a display name and a handle, and either can be the one baked into the prompt.
 * `userName` stays for callers that know exactly one.
 * @param {string} text
 * @param {{charNames?: string[], userName?: string, userNames?: string[]}} [options]
 * @returns {string}
 */
export function restoreMacros(text, { charNames = [], userName = '', userNames = [] } = {}) {
    const input = String(text ?? '');
    if (!input) return input;
    const pick = names => [...new Set(names.map(name => String(name ?? '').trim()).filter(name => name.length >= 3))]
        .sort((a, b) => b.length - a.length);
    let out = input;
    for (const name of pick(charNames)) out = out.split(name).join('{{char}}');
    for (const name of pick([userName, ...userNames])) out = out.split(name).join('{{user}}');
    return out;
}

// `created by <author> 2026© on janitorai.com`, alone on its line or appended to
// real text. The 1–120 lazy author span is what lets the year/copyright variants
// match without swallowing the following line.
const CREDIT_CORE = 'created[ \\t]+by[ \\t]+[^\\n]{1,120}?[ \\t]+on[ \\t]+'
    + '(?:https?://)?(?:www\\.)?janitor\\.?ai(?:\\.com)?\\b/?';
const CREDIT_DECOR = '[\\[\\]()*_~|>\\-\u2013\u2014.! \\t]*';
const RE_CREDIT_LINE = new RegExp(`^${CREDIT_DECOR}${CREDIT_CORE}${CREDIT_DECOR}(?:\\r?\\n|$)`, 'gim');
const RE_CREDIT_INLINE = new RegExp(`[ \\t]*[\\[(\\*_~]*[ \\t]*${CREDIT_CORE}[\\])*_~]*[.!]?`, 'i');

/**
 * Strip the "created by … on janitorai.com" credit line.
 * @param {string} text
 * @returns {string}
 */
export function stripJanitorCredit(text) {
    const input = String(text ?? '');
    if (!input || !RE_CREDIT_INLINE.test(input)) return input;
    return tidy(input.replace(RE_CREDIT_LINE, '').replace(RE_CREDIT_INLINE, ''));
}
