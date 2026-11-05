// Unit tests for the SillyTavern-ported lorebook (World Info) engine.
// Expected behaviour follows SillyTavern 1.18.0 activation semantics as cited
// in lorebook.ts ("WI:<line>" = reference/SillyTavern-1.18.0/public/scripts/world-info.js).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScanMessages, evaluateLorebooks, type LorebookGlobals } from './lorebook';
import { WI_LOGIC, WI_POSITION } from './types';
import type { ChatMessage, FlatLoreEntry, LorebookEntry, LorebookInjection, Role } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USER = 'Alice';
const CHARACTER = 'Bob';

function makeGlobals(overrides: Partial<LorebookGlobals> = {}): LorebookGlobals {
	return {
		depth: 4,
		includeNames: false,
		caseSensitive: false,
		matchWholeWords: false,
		userName: USER,
		characterName: CHARACTER,
		...overrides
	};
}

/** A full LorebookEntry; only the fields a test cares about are overridden. */
function makeEntry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
	return {
		uid: 0,
		key: [],
		keysecondary: [],
		comment: '',
		content: '',
		constant: false,
		vectorized: false,
		selective: false,
		selectiveLogic: 0,
		addMemo: false,
		order: 100,
		position: 0,
		disable: false,
		ignoreBudget: false,
		excludeRecursion: false,
		preventRecursion: false,
		matchPersonaDescription: false,
		matchCharacterDescription: false,
		matchCharacterPersonality: false,
		matchCharacterDepthPrompt: false,
		matchScenario: false,
		matchCreatorNotes: false,
		delayUntilRecursion: 0,
		probability: 100,
		useProbability: true,
		depth: 4,
		outletName: '',
		group: '',
		groupOverride: false,
		groupWeight: 100,
		scanDepth: null,
		caseSensitive: null,
		matchWholeWords: null,
		useGroupScoring: null,
		automationId: '',
		role: 0,
		sticky: null,
		cooldown: null,
		delay: null,
		triggers: [],
		characterFilter: { isExclude: false, names: [], tags: [] },
		...overrides
	};
}

function flat(entry: LorebookEntry, bookId = 1, bookName = 'Test Book'): FlatLoreEntry {
	return { bookId, bookName, entry };
}

function msg(role: Role, content: string, createdAt = 0): ChatMessage {
	return { chatId: 1, role, content, createdAt };
}

/** Evaluates a single entry over a newest-first scan text. */
function evaluate(
	entry: LorebookEntry,
	scan: string[],
	globals: Partial<LorebookGlobals> = {}
): LorebookInjection {
	return evaluateLorebooks([flat(entry)], scan, makeGlobals(globals));
}

function uids(injection: LorebookInjection): number[] {
	return injection.activated.map((a) => a.uid);
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. buildScanMessages
// ---------------------------------------------------------------------------

describe('buildScanMessages', () => {
	it('returns lines newest-first and does not mutate the input history', () => {
		const history = [msg('user', 'first', 1), msg('assistant', 'second', 2), msg('user', 'third', 3)];
		const snapshot = history.map((m) => ({ ...m }));

		const lines = buildScanMessages(history, makeGlobals({ includeNames: false }));

		expect(lines).toEqual(['third', 'second', 'first']);
		expect(history).toEqual(snapshot);
	});

	it('returns raw content when includeNames is false', () => {
		const history = [msg('user', 'hi there'), msg('assistant', 'hello back')];
		expect(buildScanMessages(history, makeGlobals({ includeNames: false }))).toEqual([
			'hello back',
			'hi there'
		]);
	});

	it('prefixes "Name: " by role when includeNames is true (assistant -> character, else user)', () => {
		const history = [msg('user', 'hi'), msg('assistant', 'yo'), msg('system', 'meta')];
		const lines = buildScanMessages(history, makeGlobals({ includeNames: true }));
		expect(lines).toEqual([`${USER}: meta`, `${CHARACTER}: yo`, `${USER}: hi`]);
	});
});

// ---------------------------------------------------------------------------
// 2. Empty input
// ---------------------------------------------------------------------------

describe('evaluateLorebooks with no entries', () => {
	it('returns an empty injection', () => {
		expect(evaluateLorebooks([], ['anything'], makeGlobals())).toEqual({
			before: '',
			after: '',
			atDepth: [],
			activated: []
		});
	});
});

// ---------------------------------------------------------------------------
// 3. Activation gates
// ---------------------------------------------------------------------------

describe('activation gates', () => {
	it('activates a constant entry with no keyword', () => {
		const inj = evaluate(makeEntry({ constant: true, content: 'CONST' }), ['nothing relevant']);
		expect(uids(inj)).toEqual([0]);
		expect(inj.before).toBe('CONST');
	});

	it('skips a disabled entry even when its keyword matches', () => {
		const inj = evaluate(makeEntry({ key: ['needle'], disable: true }), ['a needle here']);
		expect(uids(inj)).toEqual([]);
		expect(inj.before).toBe('');
	});

	it('activates on a default case-insensitive substring match', () => {
		const hit = evaluate(makeEntry({ key: ['purple'], content: 'HIT' }), ['the PURPLE cat']);
		expect(uids(hit)).toEqual([0]);
		const miss = evaluate(makeEntry({ key: ['purple'], content: 'HIT' }), ['the green cat']);
		expect(uids(miss)).toEqual([]);
	});

	it('never activates when the primary key list is empty after cleaning', () => {
		// Whitespace-only and empty keys are dropped during cleaning (4c).
		const inj = evaluate(makeEntry({ key: ['   ', ''] }), ['anything at all']);
		expect(uids(inj)).toEqual([]);
		expect(inj.before).toBe('');
	});
});

// ---------------------------------------------------------------------------
// 4. Content decorators
// ---------------------------------------------------------------------------

describe('content decorators', () => {
	it('@@activate forces activation with no keyword', () => {
		const inj = evaluate(makeEntry({ content: '@@activate\nthe body' }), ['no keyword here']);
		expect(uids(inj)).toEqual([0]);
		expect(inj.before).toBe('the body'); // decorator line is stripped
	});

	it('@@dont_activate blocks activation despite a matching keyword', () => {
		const inj = evaluate(
			makeEntry({ key: ['needle'], content: '@@dont_activate\nthe body' }),
			['a needle here']
		);
		expect(uids(inj)).toEqual([]);
		expect(inj.before).toBe('');
	});

	it('activates when both decorators are present (@@activate wins)', () => {
		const inj = evaluate(
			makeEntry({ content: '@@activate\n@@dont_activate\nthe body' }),
			['no keyword here']
		);
		expect(uids(inj)).toEqual([0]);
		expect(inj.before).toBe('the body');
	});

	it('an @@activate line at the END of content is not a decorator', () => {
		const inj = evaluate(makeEntry({ content: 'the body\n@@activate' }), ['no keyword here']);
		expect(uids(inj)).toEqual([]);
		expect(inj.before).toBe('');
	});
});

// ---------------------------------------------------------------------------
// 5. Selectivity (secondary keys + selectiveLogic)
// ---------------------------------------------------------------------------

function selectiveEntry(logic: number): LorebookEntry {
	return makeEntry({
		key: ['primary'],
		keysecondary: ['foo', 'bar'],
		selective: true,
		selectiveLogic: logic,
		content: 'HIT'
	});
}

describe('selective entries', () => {
	it('selective:false activates on the primary match alone even with keysecondary present', () => {
		const inj = evaluate(
			makeEntry({ key: ['primary'], keysecondary: ['foo'], selective: false, content: 'HIT' }),
			['primary only']
		);
		expect(uids(inj)).toEqual([0]);
	});

	it('selective:true with an empty keysecondary activates on the primary alone', () => {
		const inj = evaluate(
			makeEntry({ key: ['primary'], keysecondary: [], selective: true, content: 'HIT' }),
			['primary only']
		);
		expect(uids(inj)).toEqual([0]);
	});

	it('AND_ANY passes when any secondary key matches and fails when none do', () => {
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.AND_ANY), ['primary foo']))).toEqual([0]);
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.AND_ANY), ['primary']))).toEqual([]);
	});

	it('NOT_ALL passes when at least one secondary key misses and fails when all match', () => {
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.NOT_ALL), ['primary foo']))).toEqual([0]);
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.NOT_ALL), ['primary foo bar']))).toEqual([]);
	});

	it('NOT_ANY passes when no secondary key matches and fails when one does', () => {
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.NOT_ANY), ['primary']))).toEqual([0]);
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.NOT_ANY), ['primary foo']))).toEqual([]);
	});

	it('AND_ALL passes when every secondary key matches and fails when one misses', () => {
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.AND_ALL), ['primary foo bar']))).toEqual([0]);
		expect(uids(evaluate(selectiveEntry(WI_LOGIC.AND_ALL), ['primary foo']))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 6. Case sensitivity and whole-word matching
// ---------------------------------------------------------------------------

describe('case sensitivity and whole-word matching', () => {
	it('entry.caseSensitive true blocks a differently-cased match', () => {
		const entry = () => makeEntry({ key: ['purple'], caseSensitive: true });
		expect(uids(evaluate(entry(), ['PURPLE']))).toEqual([]);
		expect(uids(evaluate(entry(), ['purple']))).toEqual([0]);
	});

	it('entry.caseSensitive null inherits the global setting (true blocks, false matches)', () => {
		expect(uids(evaluate(makeEntry({ key: ['purple'] }), ['PURPLE'], { caseSensitive: true }))).toEqual([]);
		expect(uids(evaluate(makeEntry({ key: ['purple'] }), ['PURPLE'], { caseSensitive: false }))).toEqual([0]);
	});

	it('matchWholeWords rejects "concatenate" but matches "the cat sat"', () => {
		const entry = () => makeEntry({ key: ['cat'], matchWholeWords: true });
		expect(uids(evaluate(entry(), ['concatenate']))).toEqual([]);
		expect(uids(evaluate(entry(), ['the cat sat']))).toEqual([0]);
	});

	it('matchWholeWords null inherits the global setting', () => {
		expect(uids(evaluate(makeEntry({ key: ['cat'] }), ['concatenate'], { matchWholeWords: true }))).toEqual([]);
		expect(uids(evaluate(makeEntry({ key: ['cat'] }), ['the cat sat'], { matchWholeWords: true }))).toEqual([0]);
	});

	it('whitespace-containing keys stay plain substrings under whole-word matching', () => {
		const inj = evaluate(
			makeEntry({ key: ['purple ele'], matchWholeWords: true }),
			['a purple elephant walks']
		);
		expect(uids(inj)).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// 7. scanDepth
// ---------------------------------------------------------------------------

describe('scanDepth', () => {
	it('limits the scan to the newest N messages', () => {
		const scan = ['fresh', 'middle', 'the marker sits back here'];
		const entry = (depth: number) => makeEntry({ key: ['marker'], scanDepth: depth, content: 'HIT' });
		expect(uids(evaluate(entry(2), scan))).toEqual([]); // marker is 3rd back
		expect(uids(evaluate(entry(3), scan))).toEqual([0]); // within depth
	});

	it('falls back to globals.depth when scanDepth is null', () => {
		const scan = ['newest', 'the keyword sits here'];
		const entry = makeEntry({ key: ['keyword'], scanDepth: null });
		expect(uids(evaluate(entry, scan, { depth: 1 }))).toEqual([]);
		expect(uids(evaluate(entry, scan, { depth: 2 }))).toEqual([0]);
	});

	it('scanDepth 0 scans nothing but constants still activate', () => {
		expect(uids(evaluate(makeEntry({ key: ['keyword'], scanDepth: 0 }), ['keyword']))).toEqual([]);
		expect(
			uids(evaluate(makeEntry({ constant: true, scanDepth: 0, content: 'CONST' }), ['nothing here']))
		).toEqual([0]);
	});

	it('clamps the scan depth at 1000 messages', () => {
		const marker = 'qzxmarker9000';
		const total = 1005;

		// Marker only in the OLDEST message (index 1004, newest-first) — the
		// depth clamp of 1000 must keep it out of the scan window.
		const oldestOnly = Array.from({ length: total }, (_, i) => `filler ${i}`);
		oldestOnly[total - 1] = `the ${marker} sleeps`;
		expect(uids(evaluate(makeEntry({ key: [marker], scanDepth: 9999 }), oldestOnly))).toEqual([]);

		// Marker in the newest message — always inside the window.
		const newestOnly = Array.from({ length: total }, (_, i) => `filler ${i}`);
		newestOnly[0] = `the ${marker} wakes`;
		expect(uids(evaluate(makeEntry({ key: [marker], scanDepth: 9999 }), newestOnly))).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// 8. Regex keys
// ---------------------------------------------------------------------------

describe('regex keys', () => {
	it('a /pattern/i key overrides entry.caseSensitive', () => {
		const inj = evaluate(
			makeEntry({ key: ['/purple/i'], caseSensitive: true }),
			['a PURPLE flower']
		);
		expect(uids(inj)).toEqual([0]);
	});

	it('a regex key overrides matchWholeWords', () => {
		const inj = evaluate(
			makeEntry({ key: ['/cat/'], matchWholeWords: true }),
			['concatenate']
		);
		expect(uids(inj)).toEqual([0]);
	});

	it('runs on the raw (unfolded) scan text, not the case-folded bucket text', () => {
		// globals.caseSensitive false folds the bucket text to lowercase, but the
		// regex tests the raw text — so /Purple/ (no i flag) still matches.
		const inj = evaluate(makeEntry({ key: ['/Purple/'] }), ['Purple rain'], { caseSensitive: false });
		expect(uids(inj)).toEqual([0]);
	});

	it('a g-flagged regex gives the same result on two consecutive calls (lastIndex reset)', () => {
		const entry = makeEntry({ key: ['/purple/g'], content: 'HIT' });
		expect(uids(evaluate(entry, ['purple']))).toEqual([0]);
		expect(uids(evaluate(entry, ['purple']))).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// 9. Macros
// ---------------------------------------------------------------------------

describe('macros', () => {
	it('{{user}} and {{User}} keys match the user name in scan text', () => {
		expect(uids(evaluate(makeEntry({ key: ['{{user}}'] }), [`${USER} walked in`]))).toEqual([0]);
		expect(uids(evaluate(makeEntry({ key: ['{{User}}'] }), [`${USER} walked in`]))).toEqual([0]);
	});

	it('{{char}} and {{Char}} content substitutes the character name at activation', () => {
		expect(evaluate(makeEntry({ key: ['greet'], content: '{{char}} says hi' }), ['greet']).before).toBe(
			`${CHARACTER} says hi`
		);
		expect(evaluate(makeEntry({ key: ['greet'], content: '{{Char}} waves' }), ['greet']).before).toBe(
			`${CHARACTER} waves`
		);
	});
});

// ---------------------------------------------------------------------------
// 10. Probability
// ---------------------------------------------------------------------------

describe('probability', () => {
	it('rolls after the gates: probability 50 activates and 40 does not at Math.random() = 0.49', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.49);
		expect(uids(evaluate(makeEntry({ key: ['k'], probability: 50, content: 'HIT' }), ['k']))).toEqual([0]);
		expect(uids(evaluate(makeEntry({ key: ['k'], probability: 40, content: 'HIT' }), ['k']))).toEqual([]);
	});

	it('useProbability:false never rolls and activates at probability 0', () => {
		const spy = vi.spyOn(Math, 'random').mockReturnValue(0.49);
		const inj = evaluate(makeEntry({ key: ['k'], useProbability: false, probability: 0, content: 'HIT' }), ['k']);
		expect(uids(inj)).toEqual([0]);
		expect(spy).not.toHaveBeenCalled();
	});

	it('probability 100 skips the roll entirely', () => {
		const spy = vi.spyOn(Math, 'random').mockReturnValue(0.49);
		const inj = evaluate(makeEntry({ key: ['k'], probability: 100, content: 'HIT' }), ['k']);
		expect(uids(inj)).toEqual([0]);
		expect(spy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 11. Emission ordering
// ---------------------------------------------------------------------------

describe('emission ordering', () => {
	it('sorts the before bucket so the lower order comes first', () => {
		const low = makeEntry({ uid: 1, order: 100, position: WI_POSITION.BEFORE, constant: true, content: 'LOW' });
		const high = makeEntry({ uid: 2, order: 200, position: WI_POSITION.BEFORE, constant: true, content: 'HIGH' });
		const inj = evaluateLorebooks([flat(low), flat(high)], [], makeGlobals());
		expect(inj.before.split('\n')).toEqual(['LOW', 'HIGH']);
	});

	it('sorts the after bucket so the lower order comes first', () => {
		const low = makeEntry({ uid: 1, order: 100, position: WI_POSITION.AFTER, constant: true, content: 'LOW' });
		const high = makeEntry({ uid: 2, order: 200, position: WI_POSITION.AFTER, constant: true, content: 'HIGH' });
		const inj = evaluateLorebooks([flat(low), flat(high)], [], makeGlobals());
		expect(inj.after.split('\n')).toEqual(['LOW', 'HIGH']);
	});
});

// ---------------------------------------------------------------------------
// 12. Positions
// ---------------------------------------------------------------------------

describe('positions', () => {
	it('folds AN_TOP into before and AN_BOTTOM into after', () => {
		const anTop = makeEntry({ uid: 1, position: WI_POSITION.AN_TOP, constant: true, content: 'ANTOP' });
		const anBottom = makeEntry({ uid: 2, position: WI_POSITION.AN_BOTTOM, constant: true, content: 'ANBOTTOM' });
		const inj = evaluateLorebooks([flat(anTop), flat(anBottom)], [], makeGlobals());
		expect(inj.before).toBe('ANTOP');
		expect(inj.after).toBe('ANBOTTOM');
	});

	it('drops EM_TOP, EM_BOTTOM and OUTLET entries from every output bucket', () => {
		const positions = [WI_POSITION.EM_TOP, WI_POSITION.EM_BOTTOM, WI_POSITION.OUTLET];
		const entries = positions.map((position, i) =>
			makeEntry({ uid: i + 1, position, constant: true, content: `POS${position}` })
		);
		const inj = evaluateLorebooks(entries.map((e) => flat(e)), [], makeGlobals());
		// They still activate (they are reported), they just emit nothing.
		expect(inj.activated).toHaveLength(3);
		expect(inj.before).toBe('');
		expect(inj.after).toBe('');
		expect(inj.atDepth).toEqual([]);
	});

	it('keeps an empty-content activation out of before/after/atDepth', () => {
		const inj = evaluate(makeEntry({ content: '', constant: true }), []);
		expect(uids(inj)).toEqual([0]);
		expect(inj.before).toBe('');
		expect(inj.after).toBe('');
		expect(inj.atDepth).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 13. AT_DEPTH grouping
// ---------------------------------------------------------------------------

describe('AT_DEPTH position', () => {
	it('groups two entries with the same depth and role into one item, ascending by order', () => {
		const a = makeEntry({ uid: 1, order: 100, position: WI_POSITION.AT_DEPTH, depth: 4, role: 0, constant: true, content: 'A' });
		const b = makeEntry({ uid: 2, order: 200, position: WI_POSITION.AT_DEPTH, depth: 4, role: 0, constant: true, content: 'B' });
		const inj = evaluateLorebooks([flat(a), flat(b)], [], makeGlobals());
		expect(inj.atDepth).toHaveLength(1);
		expect(inj.atDepth[0].depth).toBe(4);
		expect(inj.atDepth[0].role).toBe('system');
		expect(inj.atDepth[0].content).toBe('A\nB');
	});

	it('keeps different depths in separate items', () => {
		const near = makeEntry({ uid: 1, order: 200, position: WI_POSITION.AT_DEPTH, depth: 3, role: 0, constant: true, content: 'NEAR' });
		const far = makeEntry({ uid: 2, order: 100, position: WI_POSITION.AT_DEPTH, depth: 5, role: 0, constant: true, content: 'FAR' });
		const inj = evaluateLorebooks([flat(near), flat(far)], [], makeGlobals());
		expect(inj.atDepth).toHaveLength(2);
		expect(inj.atDepth.find((g) => g.depth === 3)?.content).toBe('NEAR');
		expect(inj.atDepth.find((g) => g.depth === 5)?.content).toBe('FAR');
	});

	it('maps role 0/1/2 to system/user/assistant', () => {
		const entries = [0, 1, 2].map((role) =>
			makeEntry({ uid: role, position: WI_POSITION.AT_DEPTH, depth: 4, role, constant: true, content: `R${role}` })
		);
		const inj = evaluateLorebooks(entries.map((e) => flat(e)), [], makeGlobals());
		expect(inj.atDepth).toHaveLength(3);
		expect(inj.atDepth.find((g) => g.depth === 4 && g.role === 'system')?.content).toBe('R0');
		expect(inj.atDepth.find((g) => g.depth === 4 && g.role === 'user')?.content).toBe('R1');
		expect(inj.atDepth.find((g) => g.depth === 4 && g.role === 'assistant')?.content).toBe('R2');
	});
});

// ---------------------------------------------------------------------------
// 14. Dedup and activated ordering
// ---------------------------------------------------------------------------

describe('dedup and activated ordering', () => {
	it('reports the same FlatLoreEntry once even when fed twice', () => {
		const entry = flat(makeEntry({ uid: 1, constant: true }));
		const inj = evaluateLorebooks([entry, entry], [], makeGlobals());
		expect(inj.activated).toEqual([{ bookId: 1, uid: 1 }]);
	});

	it('lists activated entries in INPUT order, not order-sorted', () => {
		const low = flat(makeEntry({ uid: 1, order: 100, constant: true, content: 'LOW' }));
		const high = flat(makeEntry({ uid: 2, order: 300, constant: true, content: 'HIGH' }));
		const inj = evaluateLorebooks([low, high], [], makeGlobals());
		expect(inj.activated).toEqual([
			{ bookId: 1, uid: 1 },
			{ bookId: 1, uid: 2 }
		]);
		// Emission still sorts descending-then-unshifted, so LOW prints first.
		expect(inj.before.split('\n')).toEqual(['LOW', 'HIGH']);
	});
});

// ---------------------------------------------------------------------------
// 15. Performance smoke test
// ---------------------------------------------------------------------------

describe('performance', () => {
	it('evaluates 10,000 entries with 5 keywords each over a 50-message history in under 5000 ms', () => {
		const scan = Array.from({ length: 50 }, (_, i) => `filler message ${i}`);
		scan[2] = 'kw5000c appears here'; // inside the default depth of 4

		const entries: FlatLoreEntry[] = [];
		for (let i = 0; i < 10_000; i++) {
			entries.push(
				flat(
					makeEntry({
						uid: i,
						key: [`kw${i}a`, `kw${i}b`, `kw${i}c`, `kw${i}d`, `kw${i}e`],
						content: `entry ${i}`,
						probability: 100 // no randomness: deterministic result
					})
				)
			);
		}

		const started = Date.now();
		const inj = evaluateLorebooks(entries, scan, makeGlobals());
		const elapsed = Date.now() - started;

		expect(uids(inj)).toEqual([5000]); // only entry 5000's keyword appears
		expect(elapsed).toBeLessThan(5000);
	});
});
