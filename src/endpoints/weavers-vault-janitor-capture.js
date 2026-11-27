/**
 * Weaver's Vault — JanitorAI `/generateAlpha` capture.
 *
 * Turns a card whose definition JanitorAI hides into real card fields by making
 * the site assemble a prompt for it: create a chat, force the account onto a
 * throwaway proxy preset, send a message, and scrape the assembled prompt out of
 * the response the site's own client receives.
 *
 * Ported from Glaze 0.10.1 (`janitor_webview_proxy.dart` `captureGenerateAlpha`,
 * `janitor_extractor.dart` `extract`), notes in `docs/janitor-source/`.
 *
 * What our port does differently, and why:
 *  - **No persona is created.** `/hampter/personas` answers 404 (measured
 *    2026-11-24), so Glaze's `{{user}}` persona step cannot be reproduced as
 *    written. v1 creates the chat without `persona_id`, which makes the site bake
 *    the account's *own* persona name into every `{{user}}` it expands; the
 *    capture reads that name from `/hampter/profiles/mine` and swaps it back to
 *    `{{user}}` (as Glaze's `bakedUserName` swap-back does). Fewer account
 *    mutations is the safer direction for the riskiest stage.
 *  - **The snapshot is durable.** Glaze restores only in a `finally`, so a killed
 *    process leaves the account with a dummy preset selected, `source: 'proxy'`
 *    and `context_length: 0` — after which every normal chat has no context. Here
 *    the pre-flight snapshot is handed to a `persist` callback *before* the first
 *    mutation, and `restoreJanitorAccount` can replay it from disk later.
 *  - **A dirty account is refused.** Stacking a second mutation on a half-restored
 *    account makes the restore ambiguous, so the capture stops and says what to
 *    fix. That is the one place where refusing beats proceeding.
 *
 * AGPL-3.0 — part of Loreweaver, forked from SillyTavern.
 */
import fs from 'node:fs';
const fsp = fs.promises;
import path from 'node:path';

import {
    janitorAccountDiff,
    janitorAccountSnapshot,
    janitorDirtyReason,
    janitorDummyPreset,
    janitorRestorePlan,
    janitorStrayPresets,
} from './weavers-vault-janitor-account.js';
import { JANITOR_API, janitorAccountNames, janitorAvatarUrl, janitorBioToNotes, janitorPublicUrl } from './weavers-vault-janitor.js';
import {
    extractCard,
    extractCharName,
    extractExample,
    extractFirstMessage,
    extractScenario,
    mergeLorebookTexts,
    restoreMacros,
    separate,
    splitEntries,
    stripJanitorCredit,
    tidy,
} from './weavers-vault-janitor-separate.js';

/** Where the pre-flight snapshot survives a killed process. */
export function janitorAccountStatePath(dataRoot) {
    return path.join(dataRoot, '_vault-janitor-account.json');
}

/**
 * @param {string} file
 * @returns {{phase: string, takenAt: string, snapshot: object, presetId?: string, chatId?: string}|null}
 */
export function readJanitorAccountState(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.snapshot) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * @param {string} file
 * @param {object|null} state
 */
export function writeJanitorAccountState(file, state) {
    try {
        if (!state) {
            fs.rmSync(file, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, file);
    } catch (error) {
        console.warn('[Weaver\'s Vault] janitor account state write failed:', error.message);
    }
}

/** Timings, all from Glaze and all measured there rather than guessed. */
export const CAPTURE_TIMINGS = Object.freeze({
    probeMs: 60_000,
    triggerMs: 120_000,
    pollMs: 700,
    composerMs: 60_000,
    composerPollMs: 400,
    apiMs: 25_000,
});

/**
 * One authenticated JanitorAI API call, from inside the page.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {{method?: string, url: string, body?: unknown, authHeaders: Record<string,string>, timeoutMs?: number}} options
 * @returns {Promise<{status: number, json: any, body: string}>}
 */
async function apiCall(browser, { method = 'GET', url, body = null, authHeaders = {}, timeoutMs = CAPTURE_TIMINGS.apiMs }) {
    // `Content-Type` only when there is a body: the site answers 400 "Body cannot
    // be empty when content-type is set to 'application/json'" to a DELETE that
    // declares JSON and sends none, which silently left every capture preset
    // behind (measured).
    const expression = `(async () => {
        const headers = Object.assign(
            { "Accept": "application/json, text/plain, */*" },
            ${JSON.stringify(authHeaders)},
        );
        ${body === null ? '' : 'headers["Content-Type"] = "application/json";'}
        const options = { method: ${JSON.stringify(method)}, headers, credentials: "include" };
        ${body === null ? '' : `options.body = ${JSON.stringify(JSON.stringify(body))};`}
        try {
            const r = await fetch(${JSON.stringify(url)}, options);
            return { status: r.status, body: await r.text() };
        } catch (error) {
            return { status: -1, body: String(error) };
        }
    })()`;
    const value = await browser.evaluateInPage(expression, { timeoutMs: timeoutMs + 5_000 });
    const status = Number(value?.status ?? -1);
    const text = String(value?.body ?? '');
    let json = null;
    try {
        json = JSON.parse(text);
    } catch { /* an HTML error page is not JSON, and callers check status */ }
    return { status, json, body: text };
}

/**
 * The account's live API settings, for the dirt check the UI and status route do.
 * @returns {Promise<{status: number, json: any}>}
 */
export async function readJanitorApiSettings(browser, authHeaders) {
    return readApiSettings(browser, authHeaders);
}

/** @returns {Promise<{status: number, json: any}>} */
async function readApiSettings(browser, authHeaders) {
    const result = await apiCall(browser, { url: `${JANITOR_API}/api-settings`, authHeaders });
    return { status: result.status, json: result.json };
}

/**
 * The account identities the site expands `{{user}}` into.
 *
 * The capture creates no persona (see the module comment), so whatever persona
 * the account already has is the one the site substitutes. Its name is not in
 * the assembled prompt as a labelled field — only baked into the prose — so it
 * is read from the profile endpoint and every candidate is returned (display
 * name and handle can differ, and the response version decides which one is
 * filled).
 *
 * A failed read is logged, never thrown: the capture has already mutated the
 * account by the time the text is processed, so spending that work is worse than
 * importing the card with a literal name in it. The warning says exactly which
 * happened.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {Record<string,string>} authHeaders
 * @param {{logger?: Console}} [options]
 * @returns {Promise<string[]>}
 */
async function readAccountUserNames(browser, authHeaders, { logger = console } = {}) {
    try {
        const result = await apiCall(browser, { url: `${JANITOR_API}/profiles/mine`, authHeaders });
        if (result.status !== 200 || !result.json) {
            logger.warn?.(`[Weaver's Vault] janitor capture: account profile read failed (HTTP ${result.status}); the persona name will stay literal in the card`);
            return [];
        }
        return janitorAccountNames(result.json);
    } catch (error) {
        logger.warn?.("[Weaver's Vault] janitor capture: account profile read failed; the persona name will stay literal in the card:", error.message);
        return [];
    }
}

/**
 * Force the account onto a throwaway preset so the site assembles a prompt.
 *
 * Reproduced literally from Glaze, including the two patches that are applied
 * independently so a rejection of one cannot undo the other, and the re-read that
 * finds the server's id for the preset (the create response is not trusted to
 * carry it).
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {Record<string,string>} authHeaders
 * @param {{logger?: Console}} [options]
 */
async function enterExtractionMode(browser, authHeaders, { logger = console, contextLength = 0 } = {}) {
    const before = await readApiSettings(browser, authHeaders);
    if (before.status !== 200 || !before.json) {
        throw new Error(`Could not read the account's API settings (HTTP ${before.status}).`);
    }
    const snapshot = janitorAccountSnapshot(before.json);
    const preset = janitorDummyPreset();

    const created = await apiCall(browser, {
        method: 'POST',
        url: `${JANITOR_API}/api-settings/proxy-configs`,
        body: preset,
        authHeaders,
    });
    if (created.status >= 400) {
        throw new Error(`Could not create the capture preset (HTTP ${created.status}).`);
    }

    const after = await readApiSettings(browser, authHeaders);
    const configs = Array.isArray(after.json?.proxy_configs) ? after.json.proxy_configs : [];
    const match = configs.find(config => String(config?.client_id ?? '') === preset.client_id);
    if (!match?.id) {
        throw new Error('The capture preset was not found after creating it.');
    }

    const selected = await apiCall(browser, {
        method: 'PATCH',
        url: `${JANITOR_API}/api-settings`,
        body: { selected_proxy_config_id: match.id },
        authHeaders,
    });
    if (selected.status >= 400) {
        await deletePreset(browser, authHeaders, match.id);
        throw new Error(`Could not select the capture preset (HTTP ${selected.status}).`);
    }

    // Independently, per the original: a rejection here must not deselect.
    await apiCall(browser, { method: 'PATCH', url: `${JANITOR_API}/api-settings`, body: { source: 'proxy' }, authHeaders });
    // 0 means "no declared window", under which JanitorAI fills its ~120k-token
    // lore cap with the lorebook's first entries regardless of the message. A
    // real window forces it to choose by relevance, which is the only way a
    // probe reaches entries past that prefix.
    const generation = snapshot.generationSettings
        ? { ...snapshot.generationSettings, context_length: contextLength }
        : { context_length: contextLength };
    await apiCall(browser, {
        method: 'PATCH',
        url: `${JANITOR_API}/api-settings`,
        body: { generation_settings: generation },
        authHeaders,
    });

    logger.info?.(`[Weaver's Vault] janitor capture: extraction mode on (preset ${match.id}, context_length ${contextLength})`);
    return { snapshot, presetId: match.id };
}

/**
 * Delete a capture preset.
 *
 * A 404 means it is already gone, which is the outcome we want — treating it as
 * a failure made every restore after the first one report a problem it did not
 * have. The status is logged either way, because "delete failed" without a status
 * is exactly the kind of message that wastes an afternoon.
 * @returns {Promise<boolean>}
 */
async function deletePreset(browser, authHeaders, presetId, { logger = console } = {}) {
    if (!presetId) return false;
    const result = await apiCall(browser, {
        method: 'DELETE',
        url: `${JANITOR_API}/api-settings/proxy-configs/${presetId}`,
        authHeaders,
    });
    if (result.status === 404) return true;
    if (result.status >= 400) {
        logger.warn?.(`[Weaver's Vault] janitor capture: preset delete answered ${result.status} ${String(result.body ?? '').slice(0, 160)}`);
        return false;
    }
    return true;
}

/**
 * Put the account back exactly as the snapshot says.
 *
 * Never throws: a failed restore is reported, because the caller must be able to
 * tell "restored" from "still dirty" — the difference is what the UI shows and
 * what `POST /janitor/account/restore` retries.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {object|null} snapshot
 * @param {{presetId?: string|null, authHeaders: Record<string,string>, logger?: Console}} options
 * @returns {Promise<{restored: boolean, problems: string[], diff: Array<object>}>}
 */
export async function restoreJanitorAccount(browser, snapshot, { presetId = null, authHeaders, logger = console }) {
    const problems = [];
    const plan = janitorRestorePlan(snapshot);

    try {
        const selection = await apiCall(browser, {
            method: 'PATCH',
            url: `${JANITOR_API}/api-settings`,
            body: { selected_proxy_config_id: plan.selected },
            authHeaders,
        });
        if (selection.status >= 400) problems.push(`selected_proxy_config_id (HTTP ${selection.status})`);
    } catch (error) {
        problems.push(`selected_proxy_config_id (${error.message})`);
    }

    try {
        const source = await apiCall(browser, {
            method: 'PATCH',
            url: `${JANITOR_API}/api-settings`,
            body: { source: plan.source },
            authHeaders,
        });
        if (source.status >= 400) problems.push(`source (HTTP ${source.status})`);
    } catch (error) {
        problems.push(`source (${error.message})`);
    }

    if (plan.generationSettings) {
        try {
            const generation = await apiCall(browser, {
                method: 'PATCH',
                url: `${JANITOR_API}/api-settings`,
                body: { generation_settings: plan.generationSettings },
                authHeaders,
            });
            if (generation.status >= 400) problems.push(`generation_settings (HTTP ${generation.status})`);
        } catch (error) {
            problems.push(`generation_settings (${error.message})`);
        }
    }

    // The preset itself goes last: deleting it while it is still selected would
    // leave the account pointing at nothing.
    if (presetId) {
        try {
            if (!(await deletePreset(browser, authHeaders, presetId))) problems.push(`delete preset ${presetId}`);
        } catch (error) {
            problems.push(`delete preset (${error.message})`);
        }
    }

    // Verify rather than assume: the whole point of this module.
    let diff = [];
    try {
        const live = await readApiSettings(browser, authHeaders);
        diff = janitorAccountDiff(snapshot, live.json);
        const strays = presetId ? [] : janitorStrayPresets(live.json);
        if (strays.length) problems.push(`${strays.length} leftover capture preset(s)`);
    } catch (error) {
        problems.push(`verify (${error.message})`);
    }

    if (problems.length) logger.warn?.(`[Weaver's Vault] janitor capture restore problems: ${problems.join(', ')}`);
    return { restored: problems.length === 0 && diff.length === 0, problems, diff };
}

/**
 * Send one message through the site's composer and wait for the assembled prompt.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {string} text
 * @param {{budgetMs: number, logger?: Console}} options
 * @returns {Promise<{payload: object|null, problem: string, diagnostics: string[]}>}
 */
/**
 * Send one message as a human would, using trusted input events.
 *
 * This is the one place we do **not** port Glaze. Its `__glazeSend` types with
 * `HTMLTextAreaElement.prototype`'s value setter plus a synthetic `input` event,
 * because a WebView bridge cannot dispatch trusted input. Measured on the live
 * site, that leaves the message in the composer with the Send button still
 * `disabled` — React never saw the edit, so the send is a no-op and the capture
 * times out. CDP's `Input.insertText`/`dispatchMouseEvent` are trusted, so the
 * editor accepts the text and the button enables.
 *
 * The `__glazeSend` in the ported page script is kept for reference but unused.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {string} text
 * @returns {Promise<{ok: boolean, reason?: string, diag?: string}>}
 */
/**
 * Find the message composer, in-page.
 *
 * JanitorAI has more than one `textarea`: measured on a live chat, a 670x32 field
 * at y=0 with no placeholder sits under a `_menuWrapper` overlay, so a click at its
 * centre lands on the menu and it never takes focus. Taking the last one in DOM
 * order (or the first) picks that field and every send silently fails. The real
 * composer is `textarea._chatTextarea_` near the bottom with
 * "Enter to send. Shift+Enter for linebreak.", and its centre genuinely hits it.
 *
 * So: score the candidates and require a clickable centre.
 */
const PICK_COMPOSER = `(() => {
    const candidates = [...document.querySelectorAll('textarea, div[contenteditable="true"]')]
        .filter(element => element.offsetParent !== null)
        .map(element => {
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            const clickable = Boolean(hit) && (hit === element || element.contains(hit));
            const placeholder = element.getAttribute('placeholder') || element.getAttribute('aria-label') || '';
            let score = 0;
            if (/enter to send/i.test(placeholder)) score += 1000;
            if (clickable) score += 200;
            if (rect.height >= 40) score += 100;
            score += Math.min(99, Math.round(rect.y) / 10);
            return { element, x, y, score, clickable, placeholder, tag: element.tagName };
        })
        .filter(candidate => candidate.clickable)
        .sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best) return null;
    for (const candidate of candidates) candidate.element.removeAttribute('data-wv-composer');
    best.element.setAttribute('data-wv-composer', '1');
    best.element.focus();
    return { x: best.x, y: best.y, tag: best.tag, placeholder: best.placeholder };
})()`;

async function typeAndSend(browser, text, { logger = console } = {}) {
    const composer = await browser.evaluateInPage(PICK_COMPOSER, { timeoutMs: 15_000 });
    if (!composer) return { ok: false, reason: 'no-input' };
    logger.info?.(`[Weaver's Vault] janitor capture: composer at ${Math.round(composer.x)},${Math.round(composer.y)} (${JSON.stringify(composer.placeholder).slice(0, 50)})`);

    // A modal over the composer (persona picker, disclaimer) swallows clicks, so
    // clear it first with the ported dismisser.
    await browser.evaluateInPage('window.__glazeDismissModals ? window.__glazeDismissModals() : null', { timeoutMs: 20_000 }).catch(() => {});
    await browser.clickPoint(composer.x, composer.y);
    await browser.insertText(text);

    // Everything below reads back through this marker, never through "whatever
    // textarea looks like a composer right now". Measured failure: a modal opened
    // over the chat composer and the picker then returned the modal's own empty
    // textarea, so "the composer is empty" read as "the message was sent".
    const readTagged = `(() => {
        const element = document.querySelector('[data-wv-composer="1"]');
        if (!element || !element.isConnected) return null;
        return String((element.value !== undefined && element.value !== null ? element.value : element.textContent) || '');
    })()`;

    const typedDeadline = Date.now() + 10_000;
    let typed = null;
    while (Date.now() < typedDeadline) {
        typed = await browser.evaluateInPage(readTagged, { timeoutMs: 10_000 }).catch(() => null);
        if (typed === null) break;
        if (typed.trim().length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (typed === null) return { ok: false, reason: 'not-typed', diag: 'the composer disappeared' };
    if (typed.trim().length === 0) {
        logger.warn?.(`[Weaver's Vault] janitor capture: the composer stayed empty after typing ${text.length} chars`);
        return { ok: false, reason: 'not-typed', diag: JSON.stringify(composer.placeholder ?? '') };
    }

    // The send button enables a few frames after the editor accepts the text, and
    // its centre must actually hit it — an overlay above the button swallows the
    // click.
    const deadline = Date.now() + 20_000;
    let sendRect = null;
    while (Date.now() < deadline) {
        sendRect = await browser.evaluateInPage(`(() => {
            const button = [...document.querySelectorAll('button[aria-label*="send" i], button[class*="sendButton" i]')]
                .find(candidate => candidate.offsetParent !== null && !candidate.disabled
                    && !/stop|cancel/i.test(candidate.getAttribute('aria-label') || ''));
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            const clickable = Boolean(hit) && (hit === button || button.contains(hit));
            return { x, y, clickable };
        })()`, { timeoutMs: 10_000 }).catch(() => null);
        if (sendRect) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (sendRect?.clickable) {
        await browser.clickPoint(sendRect.x, sendRect.y);
    } else {
        // Some layouts only send on Enter even with the button present.
        await browser.pressKey({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
    }

    // Poll the tagged composer. "Cleared" only counts when that exact field lost
    // the text; the read also catches the persona wall, which is a setup step for
    // the human and must be named rather than retried.
    const clearedDeadline = Date.now() + 12_000;
    let leftover = typed;
    while (Date.now() < clearedDeadline) {
        await new Promise(resolve => setTimeout(resolve, 400));
        const profileModal = await browser.evaluateInPage(`(() => {
            const text = String(document.body.innerText || '');
            if (!/complete your profile/i.test(text)) return null;
            const nameInput = [...document.querySelectorAll('input, textarea')]
                .find(element => element.offsetParent !== null && /persona name/i.test(element.placeholder || ''));
            return (nameInput ? 'persona name field present: ' : 'text present: ') + text.replace(/[ ]{2,}/g, ' ').trim().slice(0, 160);
        })()`, { timeoutMs: 10_000 }).catch(() => null);
        if (profileModal) {
            logger.warn?.("[Weaver's Vault] janitor capture: JanitorAI is asking for a persona (Complete your profile)");
            return { ok: false, reason: 'profile-required', diag: String(profileModal) };
        }
        const current = await browser.evaluateInPage(readTagged, { timeoutMs: 10_000 }).catch(() => null);
        if (current === null) return { ok: true };
        leftover = current;
        if (!String(current ?? '').trim()) return { ok: true };
    }

    // What is actually on screen, so the next run needs no guessing.
    const dom = await browser.evaluateInPage(`(() => {
        const fields = [...document.querySelectorAll('input, textarea')]
            .filter(element => element.offsetParent !== null)
            .map(element => (element.placeholder || element.getAttribute('aria-label') || element.tagName) + '=' + String(element.value || '').slice(0, 24));
        const layers = [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="Modal" i], [class*="dialog" i], [class*="Dialog" i], [class*="overlay" i]')]
            .filter(element => element.offsetParent !== null)
            .map(element => (element.getAttribute('role') || '-') + ':' + String(element.className || '').slice(0, 48));
        return JSON.stringify({ fields, layers: layers.slice(0, 8), text: String(document.body.innerText || '').replace(/[ ]{2,}/g, ' ').slice(0, 300) });
    })()`, { timeoutMs: 10_000 }).catch(() => '');
    logger.warn?.(`[Weaver's Vault] janitor capture: the message stayed in the composer (${String(leftover).length} chars, send button ${sendRect?.clickable ? 'clicked' : 'unreachable'}); dom: ${dom}`);
    return {
        ok: false,
        reason: 'not-sent',
        diag: `${String(leftover).length} chars left; send button ${sendRect?.clickable ? 'clicked' : 'unreachable'}; ${String(dom ?? '').slice(0, 600)}`,
    };
}

async function captureOneSend(browser, text, { budgetMs, logger = console }) {
    const send = await typeAndSend(browser, text, { logger });
    if (send?.ok !== true) {
        if (send?.reason === 'profile-required') {
            return {
                payload: null,
                profileRequired: true,
                problem: 'JanitorAI will not generate anything until this account has a persona — it is showing "Complete your profile" (persona name and appearance). Fill that in once in the JanitorAI window, then run the capture again.',
                diagnostics: [String(send.diag ?? '')],
            };
        }
        return {
            payload: null,
            problem: send?.reason === 'no-input'
                ? 'Could not reach the chat composer (it never appeared).'
                : `The message would not send — it stayed in the composer after typing and pressing Send. ${String(send?.diag ?? '').slice(0, 500)}`,
            diagnostics: [String(send?.diag ?? '')],
        };
    }

    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, CAPTURE_TIMINGS.pollMs));
        const captured = await browser.evaluateInPage(
            'window.__glazeAlpha ? JSON.stringify(window.__glazeAlpha) : null',
            { timeoutMs: 15_000 },
        );
        if (captured) {
            try {
                return { payload: JSON.parse(captured), problem: '', diagnostics: [] };
            } catch {
                return { payload: null, problem: 'The captured prompt was not valid JSON.', diagnostics: [] };
            }
        }
        // A refusal answers instead of a prompt; report it rather than waiting out
        // the whole budget for a prompt that is never coming.
        const refusal = await readRefusal(browser);
        if (refusal) return { payload: null, problem: refusal, diagnostics: [] };
    }

    const log = await readAlphaLog(browser);
    const net = await readNetLog(browser);
    const alertText = String(await browser.evaluateInPage(`(() => {
        const nodes = [...document.querySelectorAll('[role="alert"], [role="dialog"], [class*="toast" i], [class*="modal" i], [class*="error" i]')]
            .filter(element => element.offsetParent !== null);
        return nodes.slice(0, 4).map(element => element.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).join(' || ');
    })()`, { timeoutMs: 15_000 }).catch(() => '') ?? '');
    const shot = await browser.screenshot().catch(() => '');
    const newest = log.slice(-2).map(entry => `${entry.status}${entry.body ? `: ${String(entry.body).slice(0, 120)}` : ''}`);
    const posts = net.slice(-6).map(entry => `${entry.m} ${entry.u} -> ${entry.s}`);
    logger.warn?.(`[Weaver's Vault] janitor capture timed out; alpha log: ${JSON.stringify(log)}; non-GET requests: ${JSON.stringify(net.slice(-12))}`);
    return {
        payload: null,
        problem: newest.length
            ? `JanitorAI answered /generateAlpha with ${newest.join(' | ')}`
            : `No /generateAlpha request left the page — the message was sent but JanitorAI never asked the server to assemble a prompt (generation refused, or the chat is still busy). Requests it did make: ${posts.length ? posts.join('; ') : 'none'}${alertText ? `. On screen: ${alertText}` : ''}`,
        diagnostics: [...log.map(entry => JSON.stringify(entry)), ...net.map(entry => JSON.stringify(entry)), ...(alertText ? [alertText] : [])],
        screenshot: shot || null,
    };
}

/**
 * Every non-GET request the page made, whatever its path.
 *
 * The alpha log only keeps `/generateAlpha`, so a renamed endpoint looks like
 * silence. This is the evidence that distinguishes "never asked" from "asked
 * somewhere else".
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 */
async function readNetLog(browser) {
    try {
        const raw = await browser.evaluateInPage(
            'window.__glazeNetLog ? JSON.stringify(window.__glazeNetLog) : null',
            { timeoutMs: 15_000 },
        );
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

async function readAlphaLog(browser) {
    try {
        const raw = await browser.evaluateInPage(
            'window.__glazeAlphaLog ? JSON.stringify(window.__glazeAlphaLog) : null',
            { timeoutMs: 15_000 },
        );
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/** A refusal in the alpha log, as a sentence, or ''. */
async function readRefusal(browser) {
    const log = await readAlphaLog(browser);
    for (const entry of log) {
        const status = Number(entry?.status) || 0;
        if (status === 401) return 'JanitorAI refused the capture: the session expired (401). Sign in again.';
        if (status === 403) return 'JanitorAI refused the capture (403). The server will not assemble a prompt for this character.';
        if (status === 429) return 'JanitorAI rate-limited the capture (429). Wait a little and try again.';
    }
    return '';
}

/** Reset the capture globals between sends. */
async function resetCapture(browser) {
    try {
        await browser.evaluateInPage('window.__glazeAlpha = null; window.__glazeAlphaLog = []; "ok"', { timeoutMs: 10_000 });
    } catch { /* the next navigation clears them anyway */ }
}

/**
 * Replace the chat's first bot message with `.`.
 *
 * The greeting is part of the message history JanitorAI scans for lorebook
 * keys, and a guide-style greeting that lists every character fires the whole
 * character book on message one. Rewriting it to a neutral dot leaves the scan
 * with only what the caller sends, which is what makes a targeted probe work
 * on a saturated book.
 * @returns {Promise<boolean>} true when the greeting was rewritten
 */
async function blankChatGreeting(browser, authHeaders, chatId, { logger = console, text = '.' } = {}) {
    const chat = await apiCall(browser, { url: `${JANITOR_API}/chats/${chatId}`, authHeaders });
    const messages = Array.isArray(chat.json?.chatMessages) ? chat.json.chatMessages : [];
    const first = messages.find(message => message?.is_bot && message?.id);
    if (!first) {
        logger.warn?.('[Weaver\'s Vault] janitor capture: no bot greeting to blank');
        return false;
    }
    const patched = await apiCall(browser, {
        method: 'PATCH',
        url: `${JANITOR_API}/chats/${chatId}/messages/${first.id}`,
        body: { message: text },
        authHeaders,
    });
    if (patched.status >= 400) {
        logger.warn?.(`[Weaver\'s Vault] janitor capture: greeting blank answered ${patched.status} ${String(patched.body ?? '').slice(0, 120)}`);
        return false;
    }
    return true;
}

/**
 * The greetings the site stored on the chat object.
 * @returns {Promise<string[]>}
 */
async function fetchChatGreetings(browser, authHeaders, chatId) {
    const chat = await apiCall(browser, { url: `${JANITOR_API}/chats/${chatId}`, authHeaders });
    const character = chat.json?.character ?? chat.json?.data?.character;
    if (!character) return [];
    const list = [];
    if (typeof character.first_message === 'string') list.push(character.first_message);
    for (const entry of Array.isArray(character.first_messages) ? character.first_messages : []) {
        if (typeof entry === 'string') list.push(entry);
        else if (entry && typeof entry === 'object') list.push(String(entry.first_message ?? entry.message ?? ''));
    }
    // The site pads the array with empties and invisible-character placeholders.
    return list.filter(text => typeof text === 'string' && /[\p{L}\p{N}]/u.test(text));
}

/**
 * The message that trips a closed lorebook's keys.
 *
 * A key only fires on words that are in the sent message, so the trigger is the
 * card's own text (which is what the card would say in its first turn, and is
 * free coverage) plus whatever the caller names — a coverage pass has to be able
 * to say "morrowfen" even when the card never uses that word — plus the
 * greetings. Parts are trimmed and empty ones dropped, so the joins never leave
 * stray separators; a capture with nothing to say falls back to `"."`.
 * Measured 2026-11-24: this text is the only vocabulary the scan window sees.
 */
export function janitorTriggerMessage({ card = '', triggerText = '', greetings = [] } = {}) {
    return [card, String(triggerText ?? '').trim(), greetings.join('\n\n---\n\n')]
        .map(part => String(part ?? '').trim())
        .filter(Boolean)
        .join('\n\n') || '.';
}

/**
 * Capture one card.
 *
 * Single-turn capture (v1): a `"."` probe send supplies the card, one trigger
 * send supplies the triggered closed-lore entries. No split passes yet.
 * @param {{
 *   browser: import('./weavers-vault-browser.js').VaultBrowser,
 *   characterId: string,
 *   authHeaders: Record<string,string>,
 *   pageScript: string,
 *   triggerText?: string,
 *   persist?: (state: object|null) => void,
 *   onPhase?: (phase: string) => void,
 *   logger?: Console,
 * }} options
 * @returns {Promise<{
 *   characterId: string, card: string, scenario: string, example: string,
 *   firstMes: string, alternateGreetings: string[], lorebookText: string,
 *   entryCount: number, userNames: string[], greetings: string[], probeSystemChars: number,
 *   triggerSystemChars: number, snapshot: object, restored: object,
 * }>}
 */
/**
 * Save a failure screenshot next to the account state, so a refused capture leaves
 * evidence instead of a sentence about network silence.
 * @param {string} shot base64 PNG
 * @param {string} dataRoot
 * @param {{info?: Function, warn?: Function}} logger
 */
async function saveFailureShot(shot, dataRoot, logger) {
    if (!shot || !dataRoot) return null;
    try {
        const target = path.join(dataRoot, '_vault-janitor-capture-fail.png');
        await fsp.writeFile(target, Buffer.from(shot, 'base64'));
        logger.warn?.(`[Weaver's Vault] janitor capture: wrote ${target}`);
        return target;
    } catch {
        return null;
    }
}

/**
 * The macro restorer for one capture.
 *
 * Every text field the import keeps goes through this: the card body, scenario,
 * example dialogues, every greeting and the whole lorebook. `separate.js` can
 * only restore a macro it can name, so the restorer is built from both name sets
 * — the card's own name(s) from the `<…'s Persona>` tag and the account's
 * persona name(s) from the profile read — and applies them in one place so no
 * field can quietly skip the swap.
 * @param {{charNames?: string[], userNames?: string[]}} [options]
 * @returns {(text: string) => string}
 */
export function janitorMacroRestorer({ charNames = [], userNames = [] } = {}) {
    return text => restoreMacros(stripJanitorCredit(text), { charNames, userNames });
}

export async function captureJanitorCard({
    browser,
    characterId,
    authHeaders,
    pageScript,
    triggerText = '',
    settleSends = 0,
    minimalTrigger = false,
    blankGreeting = false,
    greetingText = '.',
    greetingClicks = 0,
    contextLength = 0,
    onPayload = null,
    persist = () => {},
    onPhase = () => {},
    logger = console,
    dataRoot = '',
}) {
    const phase = name => {
        onPhase(name);
        logger.info?.(`[Weaver's Vault] janitor capture phase: ${name}`);
    };

    // ── pre-flight: refuse to stack a mutation on a half-restored account ────
    phase('checking account');
    const pre = await readApiSettings(browser, authHeaders);
    if (pre.status !== 200 || !pre.json) {
        throw new Error(`Could not read the account's API settings (HTTP ${pre.status}).`);
    }
    const strays = janitorStrayPresets(pre.json);
    if (strays.length) {
        throw new Error(janitorDirtyReason({ diff: [], strays })
            .replace('Restore it before importing again.', 'Run the account restore and try again.'));
    }

    // Read-only and before the first mutation: the persona name is needed to undo
    // the site's `{{user}}` expansion on the captured text.
    phase('reading account name');
    const userNames = await readAccountUserNames(browser, authHeaders, { logger });

    let entered = null;
    let chatId = null;
    let capture = null;
    let restored = null;

    try {
        phase('configuring proxy');
        entered = await enterExtractionMode(browser, authHeaders, { logger, contextLength });
        // Durable BEFORE the first irreversible step: from here a kill is
        // recoverable, because the snapshot is on disk.
        persist({ phase: 'capturing', takenAt: new Date().toISOString(), snapshot: entered.snapshot, presetId: entered.presetId });

        phase('opening chat');
        const created = await apiCall(browser, {
            method: 'POST',
            url: `${JANITOR_API}/chats`,
            body: { character_id: characterId },
            authHeaders,
        });
        chatId = String(created.json?.id ?? created.json?.data?.id ?? '');
        if (!chatId) throw new Error('Could not create a chat (no id in the response).');
        persist({ phase: 'capturing', takenAt: new Date().toISOString(), snapshot: entered.snapshot, presetId: entered.presetId, chatId });

        await browser.addInitScript(pageScript);
        await browser.navigate(`https://janitorai.com/chats/${chatId}`);
        // JanitorAI caches the selected proxy preset in its client store, so the
        // chat is loaded twice on purpose (Glaze: "reloading for preset").
        phase('reloading for preset');
        // The chat page, not the origin: reloading to the origin replaced the chat
        // with the home page, so the composer could never appear.
        await browser.reloadPage();
        await waitForComposer(browser, { logger });

        if (greetingClicks > 0) {
            phase(`switching greeting x${greetingClicks}`);
            for (let click = 0; click < greetingClicks; click++) {
                const moved = await browser.evaluateInPage(`(() => {
                    const next = document.querySelector('button[aria-label="Next"]');
                    if (!next) return 'no-button';
                    next.click();
                    return 'clicked';
                })()`, { timeoutMs: 15_000 }).catch(() => 'error');
                if (moved !== 'clicked') {
                    logger.warn?.(`[Weaver's Vault] janitor capture: greeting switch ${click + 1} found no Next button (${moved})`);
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 900));
            }
        }

        phase('reading greetings');
        const greetings = await fetchChatGreetings(browser, authHeaders, chatId);

        if (blankGreeting) {
            phase('blanking greeting');
            await blankChatGreeting(browser, authHeaders, chatId, { logger, text: greetingText });
        }

        phase('sending probe');
        await resetCapture(browser);
        const probe = await captureOneSend(browser, '.', { budgetMs: CAPTURE_TIMINGS.probeMs, logger });
        if (!probe.payload) {
            await saveFailureShot(probe.screenshot, dataRoot, logger);
            const error = new Error(probe.problem);
            if (probe.profileRequired) error.code = 'janitor_profile_required';
            throw error;
        }

        const rawCard = extractCard(probe.payload);
        // A saturated lorebook needs the opposite of the importer's maximising
        // trigger: card and greetings are themselves keyword soup, so a probe that
        // includes them fires the same entries every time and never reaches past
        // JanitorAI's cap. Minimal mode scans only what the caller asked for.
        const trigger = minimalTrigger ? String(triggerText ?? '') : janitorTriggerMessage({ card: rawCard, triggerText, greetings });

        // A lorebook whose greeting (or card) names most of its own entries fires
        // them on the first message and saturates JanitorAI's ~120k-token lore cap,
        // so a targeted trigger adds nothing. Settle sends push the greeting out of
        // the scan window before the real trigger, which frees the cap for it.
        for (let k = 0; k < settleSends; k++) {
            phase(`settling ${k + 1}/${settleSends}`);
            await resetCapture(browser);
            const filler = await captureOneSend(browser, '.', { budgetMs: CAPTURE_TIMINGS.probeMs, logger });
            if (!filler.payload) {
                logger.warn?.(`[Weaver's Vault] janitor capture: settle send ${k + 1} of ${settleSends} did not answer`);
                break;
            }
        }

        phase('sending trigger');
        await resetCapture(browser);
        const full = await captureOneSend(browser, trigger, { budgetMs: CAPTURE_TIMINGS.triggerMs, logger });
        // The trigger payload is preferred, but a probe-only capture still holds
        // the card; only a refusal on the trigger makes the run fail.
        const payload = full.payload ?? probe.payload;
        if (payload && typeof onPayload === 'function') {
            try { onPayload(payload); } catch { /* diagnostics must not break a capture */ }
        }
        if (!payload) {
            await saveFailureShot(full.screenshot, dataRoot, logger);
            throw new Error(full.problem);
        }

        phase('separating');
        const separated = separate(payload, { knownCard: rawCard });
        const name = extractCharName(payload) || extractCharName(probe.payload);

        const charNames = [name, extractCharName(probe.payload)].filter(Boolean);
        const macro = janitorMacroRestorer({ charNames, userNames });
        const cardSource = probe.payload;
        const card = macro(extractCard(cardSource));
        const scenario = macro(extractScenario(cardSource));
        const example = macro(extractExample(cardSource));
        const capturedFirst = macro(extractFirstMessage(cardSource));
        const siteGreetings = greetings.map(macro);
        const firstMes = capturedFirst || siteGreetings[0] || '';
        const alternates = [...new Set([
            ...siteGreetings.filter(text => text && text !== firstMes),
            ...(full.payload ? [macro(extractFirstMessage(full.payload))] : []).filter(text => text && text !== firstMes),
        ])];
        const lorebookText = macro(mergeLorebookTexts([separated.lorebookText]));

        capture = {
            characterId,
            card,
            scenario,
            example,
            firstMes,
            alternateGreetings: alternates,
            lorebookText,
            entryCount: splitEntries(lorebookText).length,
            userNames,
            greetings: siteGreetings,
            probeSystemChars: String(probe.payload?.messages?.[0]?.content ?? '').length,
            triggerSystemChars: String(payload?.messages?.[0]?.content ?? '').length,
            snapshot: entered.snapshot,
        };
    } finally {
        // Order matters: chat first (it holds a reference to the preset), then the
        // account, so a failure anywhere still tries the cleanup below.
        if (chatId) {
            phase('deleting chat');
            try {
                await apiCall(browser, { method: 'DELETE', url: `${JANITOR_API}/chats/${chatId}`, authHeaders });
            } catch (error) {
                logger.warn?.("[Weaver's Vault] janitor capture: chat delete failed:", error.message);
            }
        }
        phase('restoring settings');
        restored = await restoreJanitorAccount(browser, entered?.snapshot ?? null, {
            presetId: entered?.presetId ?? null,
            authHeaders,
            logger,
        });
        if (restored.restored) persist(null);
        else persist({
            phase: 'dirty',
            takenAt: new Date().toISOString(),
            snapshot: entered?.snapshot ?? null,
            presetId: entered?.presetId ?? null,
            problems: restored.problems,
            diff: restored.diff,
        });
        try {
            await browser.clearInitScripts();
        } catch { /* the next navigation clears them anyway */ }
        phase('restored');
    }

    return { ...capture, restored };
}

/**
 * Poll until the site's composer has hydrated.
 * @param {import('./weavers-vault-browser.js').VaultBrowser} browser
 * @param {{composerMs?: number, logger?: Console}} [options]
 */
async function waitForComposer(browser, { composerMs = CAPTURE_TIMINGS.composerMs, logger = console } = {}) {
    const deadline = Date.now() + composerMs;
    while (Date.now() < deadline) {
        const ready = await browser.evaluateInPage(
            'typeof window.__glazeComposerReady === "function" ? window.__glazeComposerReady() : false',
            { timeoutMs: 10_000 },
        ).catch(() => false);
        if (ready) return true;
        await new Promise(resolve => setTimeout(resolve, CAPTURE_TIMINGS.composerPollMs));
    }
    // A composer that never appears is not fatal in the original either: the send
    // itself reports "no-input", which is a better message than a timeout here.
    logger.warn?.("[Weaver's Vault] janitor capture: composer never appeared — sending anyway");
    return false;
}

/**
 * Card fields for a captured card, shaped like the public-card path so the import
 * is identical whichever way the text arrived.
 * @param {Record<string, any>} meta detail payload
 * @param {{capture: object, retrievedAt?: string}} options
 */
export function janitorCapturedCardCharacter(meta, { capture, retrievedAt = new Date().toISOString() }) {
    const id = String(meta?.id ?? capture?.characterId ?? '').trim();
    const tags = [
        ...(Array.isArray(meta?.tags) ? meta.tags.map(tag => (typeof tag === 'string' ? tag : tag?.name ?? tag?.slug ?? '')) : []),
        ...(Array.isArray(meta?.custom_tags) ? meta.custom_tags.filter(tag => typeof tag === 'string') : []),
    ].map(tag => String(tag).trim()).filter(Boolean);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: String(meta?.name ?? capture?.name ?? 'Unknown'),
            description: tidy(capture.card),
            // Empty by design: the body already carries it (Glaze emits '' too).
            personality: '',
            scenario: tidy(capture.scenario || String(meta?.scenario ?? '')),
            first_mes: capture.firstMes,
            mes_example: tidy(capture.example || String(meta?.example_dialogs ?? meta?.mes_example ?? '')),
            // Same converter as the public path: the bio keeps its formatting.
            creator_notes: janitorBioToNotes(String(meta?.description ?? ''), String(meta?.creator_name ?? meta?.creator ?? '')),
            creator: String(meta?.creator_name ?? meta?.creator ?? ''),
            creatorId: String(meta?.creator_id ?? ''),
            system_prompt: '',
            post_history_instructions: '',
            character_book: null,
            character_version: '',
            tags: [...new Set(tags)],
            alternate_greetings: capture.alternateGreetings ?? [],
            extensions: {
                vault_source: 'janitor',
                vault_full_path: id,
                vault_url: janitorPublicUrl(id),
                janitor: {
                    characterId: id,
                    creatorId: String(meta?.creator_id ?? ''),
                    recovered: true,
                    recoveredAt: retrievedAt,
                    closedLoreEntryCount: capture.entryCount ?? 0,
                    avatarUrl: janitorAvatarUrl(meta?.avatar),
                },
            },
        },
    };
}
