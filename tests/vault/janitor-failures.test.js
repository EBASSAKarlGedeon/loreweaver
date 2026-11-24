import { describe, test, expect } from '@jest/globals';
import {
    JANITOR_FAILURE_REASONS,
    janitorFailureReason,
} from '../../src/endpoints/weavers-vault-janitor.js';

/**
 * S9: every failure states a reason, in one vocabulary.
 *
 * The routes carry a transport `code` (`janitor_challenge`); the ledger wants
 * the phenomenon (`challenge`). `janitorFailureReason` is the only place that
 * mapping exists — the client records `payload.reason` verbatim, so a code with
 * no mapping here means a failure the ledger cannot explain.
 */

describe('janitorFailureReason — route codes', () => {
    test.each([
        ['janitor_challenge', 'challenge'],
        ['janitor_signed_out', 'signed-out'],
        ['janitor_rate_limited', 'rate-limited'],
        ['janitor_missing', 'missing'],
        ['janitor_unreachable', 'transport'],
        ['janitor_error', 'server'],
        ['janitor_parse', 'unparseable'],
        ['janitor_browser', 'no-browser'],
        ['janitor_id', 'bad-id'],
        ['janitor_profile_required', 'profile-required'],
        ['janitor_unproxyable', 'unproxyable'],
        ['janitor_private', 'private'],
        ['janitor_deleted', 'deleted'],
        ['janitor_card', 'transport'],
        ['janitor_lorebooks', 'transport'],
    ])('%s → %s', (code, reason) => {
        expect(janitorFailureReason({ code })).toBe(reason);
    });

    test('a failed capture is closed-capture-failed, not a transport error', () => {
        // The drive reached the site and ran; the card is what it did not get.
        expect(janitorFailureReason({ code: 'janitor_capture' })).toBe('closed-capture-failed');
    });

    test('codes are matched case-insensitively and after trimming', () => {
        expect(janitorFailureReason({ code: '  JANITOR_CHALLENGE ' })).toBe('challenge');
    });
});

describe('janitorFailureReason — block reasons already in the vocabulary', () => {
    // `janitorBlockReason` answers these strings and some paths send them as the
    // code, so they must survive the mapping unchanged rather than becoming
    // 'unknown'.
    test.each([...JANITOR_FAILURE_REASONS])('%s passes through', (reason) => {
        expect(janitorFailureReason({ code: reason })).toBe(reason);
    });
});

describe('janitorFailureReason — status fallbacks', () => {
    test.each([
        [429, 'rate-limited'],
        [401, 'signed-out'],
        [403, 'signed-out'],
        [404, 'missing'],
        [500, 'server'],
        [503, 'server'],
        [-1, 'transport'],
        [418, 'http-418'],
    ])('status %s → %s', (status, reason) => {
        expect(janitorFailureReason({ status })).toBe(reason);
    });

    test('a challenge flag outranks every code and status', () => {
        expect(janitorFailureReason({ code: 'janitor_card', status: 500, challenged: true })).toBe('challenge');
    });

    test('nothing known yields "unknown" rather than an empty reason', () => {
        expect(janitorFailureReason({})).toBe('unknown');
        expect(janitorFailureReason()).toBe('unknown');
    });
});

describe('the vocabulary itself', () => {
    test('every reason is a stable lowercase token', () => {
        for (const reason of JANITOR_FAILURE_REASONS) {
            expect(reason).toMatch(/^[a-z0-9-]+$/);
        }
    });

    test('names the plan asks for are all present', () => {
        // Plan §S9 wording: unproxyable, closed-capture-failed, challenge,
        // signed-out, rate-limited.
        for (const reason of ['unproxyable', 'closed-capture-failed', 'challenge', 'signed-out', 'rate-limited']) {
            expect(JANITOR_FAILURE_REASONS).toContain(reason);
        }
    });

    test('has no duplicates', () => {
        expect(new Set(JANITOR_FAILURE_REASONS).size).toBe(JANITOR_FAILURE_REASONS.length);
    });
});
