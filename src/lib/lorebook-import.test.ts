// Unit tests for the lorebook importer/exporter — format detection and the
// per-source converters, checked against SillyTavern 1.18.0's importWorldInfo
// behaviour (reference/SillyTavern-1.18.0/public/scripts/world-info.js).
// saveLorebook() is NOT covered: it needs Dexie/IndexedDB, which the node test
// environment does not provide.

import { describe, expect, it } from 'vitest';
import { parseLorebook, serializeLorebook } from './lorebook-import';
import type { Lorebook, LorebookEntry } from './types';

/** The exact field set backfillEntry emits — anything else must be dropped. */
const ENTRY_FIELDS = [
	'uid',
	'key',
	'keysecondary',
	'comment',
	'content',
	'constant',
	'vectorized',
	'selective',
	'selectiveLogic',
	'addMemo',
	'order',
	'position',
	'disable',
	'ignoreBudget',
	'excludeRecursion',
	'preventRecursion',
	'matchPersonaDescription',
	'matchCharacterDescription',
	'matchCharacterPersonality',
	'matchCharacterDepthPrompt',
	'matchScenario',
	'matchCreatorNotes',
	'delayUntilRecursion',
	'probability',
	'useProbability',
	'depth',
	'outletName',
	'group',
	'groupOverride',
	'groupWeight',
	'scanDepth',
	'caseSensitive',
	'matchWholeWords',
	'useGroupScoring',
	'automationId',
	'role',
	'sticky',
	'cooldown',
	'delay',
	'triggers',
	'characterFilter',
	'displayIndex'
];

function makeBook(overrides: Partial<Lorebook> = {}): Lorebook {
	return {
		name: 'Test Book',
		entryCount: 0,
		sourceFormat: 'native',
		createdAt: 1,
		updatedAt: 1,
		...overrides
	};
}

// ---------------------------------------------------------------------------
// 16. Format detection
// ---------------------------------------------------------------------------

describe('parseLorebook format detection', () => {
	it('detects novelai first: {lorebookVersion, kind:"memory"} wins over agnai', () => {
		const parsed = parseLorebook({ lorebookVersion: 1, kind: 'memory', entries: [] }, 'Fallback');
		expect(parsed.sourceFormat).toBe('novelai');
		expect(parsed.name).toBe('Fallback');
		expect(parsed.entries).toEqual([]);
	});

	it('detects agnai from {kind:"memory"}', () => {
		const parsed = parseLorebook({ kind: 'memory', entries: [] }, 'Fallback');
		expect(parsed.sourceFormat).toBe('agnai');
	});

	it('detects risu from {type:"risu"}', () => {
		const parsed = parseLorebook({ type: 'risu', data: [] }, 'Fallback');
		expect(parsed.sourceFormat).toBe('risu');
	});

	it('detects native when entries is a plain object', () => {
		const parsed = parseLorebook({ entries: { '0': { content: 'hello' } } }, 'Fallback');
		expect(parsed.sourceFormat).toBe('native');
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].content).toBe('hello');
	});

	it('detects character_book for an entries array, keeping the raw json as originalData', () => {
		const json = { name: 'My Book', entries: [] };
		const parsed = parseLorebook(json, 'Fallback');
		expect(parsed.sourceFormat).toBe('character_book');
		expect(parsed.name).toBe('My Book');
		expect(parsed.originalData).toBe(json); // same reference, lossless re-export
	});

	it('falls back to the given name when the json has none', () => {
		expect(parseLorebook({ entries: [] }, 'Fallback').name).toBe('Fallback');
		expect(parseLorebook({ name: '', entries: [] }, 'Fallback').name).toBe('Fallback');
	});

	it('throws "Unrecognized lorebook format" for non-objects and unknown shapes', () => {
		expect(() => parseLorebook(null, 'FB')).toThrow('Unrecognized lorebook format');
		expect(() => parseLorebook('a string', 'FB')).toThrow('Unrecognized lorebook format');
		expect(() => parseLorebook(42, 'FB')).toThrow('Unrecognized lorebook format');
		expect(() => parseLorebook(['entries'], 'FB')).toThrow('Unrecognized lorebook format');
		expect(() => parseLorebook({}, 'FB')).toThrow('Unrecognized lorebook format');
		expect(() => parseLorebook({ entries: 'not a map' }, 'FB')).toThrow('Unrecognized lorebook format');
	});
});

// ---------------------------------------------------------------------------
// 17. Native converter
// ---------------------------------------------------------------------------

describe('native converter', () => {
	it('takes the uid from the map key', () => {
		const { entries } = parseLorebook({ entries: { '7': { content: 'seven' } } }, 'FB');
		expect(entries).toHaveLength(1);
		expect(entries[0].uid).toBe(7);
		expect(entries[0].content).toBe('seven');
	});

	it('gives non-integer and duplicate-parsed keys fresh uids from max+1', () => {
		// '3' parses to 3; '3.7' also parses to 3 (duplicate) and 'abc' is NaN,
		// so both fall back to fresh uids past the max of 3: 4 and 5.
		const { entries } = parseLorebook({ entries: { '3': {}, '3.7': {}, 'abc': {} } }, 'FB');
		expect(entries.map((e) => e.uid)).toEqual([3, 4, 5]);
	});

	it('backfills missing fields with the template defaults', () => {
		const { entries } = parseLorebook({ entries: { '0': {} } }, 'FB');
		expect(entries[0]).toMatchObject({
			uid: 0,
			key: [],
			keysecondary: [],
			comment: '',
			content: '',
			constant: false,
			selective: true, // template default, unlike the other converters
			selectiveLogic: 0,
			order: 100,
			position: 0,
			disable: false,
			probability: 100,
			useProbability: true,
			depth: 4,
			role: 0,
			displayIndex: 0, // defaults to the uid
			scanDepth: null,
			caseSensitive: null,
			matchWholeWords: null,
			characterFilter: { isExclude: false, names: [], tags: [] }
		});
	});

	it('wraps a string key into a one-element array', () => {
		const { entries } = parseLorebook({ entries: { '1': { key: 'solo' } } }, 'FB');
		expect(entries[0].key).toEqual(['solo']);
	});

	it('coerces junk types: numbers become strings, null falls back to defaults', () => {
		const { entries } = parseLorebook(
			{ entries: { '2': { comment: 42, content: 7, order: null, key: null, probability: 'nope' } } },
			'FB'
		);
		const entry = entries[0];
		expect(entry.comment).toBe('42');
		expect(entry.content).toBe('7');
		expect(entry.order).toBe(100); // null -> default
		expect(entry.key).toEqual([]); // null -> []
		expect(entry.probability).toBe(100); // non-number -> default
	});

	it('drops unknown extra fields — the entry has exactly the LorebookEntry keys', () => {
		const { entries } = parseLorebook(
			{ entries: { '0': { content: 'x', bogus: 'drop me', anotherOne: 5 } } },
			'FB'
		);
		const entry = entries[0];
		expect(Object.keys(entry).sort()).toEqual([...ENTRY_FIELDS].sort());
		expect(entry).not.toHaveProperty('bogus');
		expect(entry).not.toHaveProperty('anotherOne');
	});
});

// ---------------------------------------------------------------------------
// 18. NovelAI converter
// ---------------------------------------------------------------------------

describe('novelai converter', () => {
	it('maps Novel Lorebook fields onto LorebookEntry', () => {
		const { entries, name, sourceFormat } = parseLorebook(
			{
				lorebookVersion: 1,
				entries: [
					{
						keys: ['alpha', 'beta'],
						displayName: 'Memo',
						text: 'Body',
						enabled: true,
						contextConfig: { budgetPriority: 55 }
					},
					{ keys: ['gamma'], text: 'No enabled field' },
					{
						keys: ['delta'],
						text: 'Disabled',
						enabled: false,
						contextConfig: { budgetPriority: 'not-a-number' }
					}
				]
			},
			'Fallback'
		);
		expect(sourceFormat).toBe('novelai');
		expect(name).toBe('Fallback');

		const [a, b, c] = entries;
		expect(a.key).toEqual(['alpha', 'beta']);
		expect(a.comment).toBe('Memo');
		expect(a.content).toBe('Body');
		expect(a.order).toBe(55); // finite budgetPriority
		expect(a.addMemo).toBe(true);
		expect(a.constant).toBe(false);
		expect(a.selective).toBe(false);
		expect(a.disable).toBe(false); // enabled: true -> not disabled

		expect(b.disable).toBe(true); // missing `enabled` imports disabled
		expect(b.order).toBe(0); // no finite budgetPriority -> 0

		expect(c.disable).toBe(true); // enabled: false -> disabled
		expect(c.order).toBe(0); // non-number budgetPriority -> 0
	});
});

// ---------------------------------------------------------------------------
// 19. Agnai converter
// ---------------------------------------------------------------------------

describe('agnai converter', () => {
	it('maps Agnai memory-book fields onto LorebookEntry', () => {
		const { entries, sourceFormat } = parseLorebook(
			{
				kind: 'memory',
				entries: [
					{ keywords: ['k1', 'k2'], name: 'Mem', entry: 'Body', weight: 55, enabled: true },
					{ keywords: ['k3'], name: 'Second', entry: 'Other' }
				]
			},
			'Fallback'
		);
		expect(sourceFormat).toBe('agnai');

		const [a, b] = entries;
		expect(a.key).toEqual(['k1', 'k2']);
		expect(a.comment).toBe('Mem');
		expect(a.content).toBe('Body');
		expect(a.order).toBe(55);
		expect(a.disable).toBe(false);
		expect(a.constant).toBe(false);
		expect(a.selective).toBe(false);
		expect(a.addMemo).toBe(true);

		expect(b.disable).toBe(true); // missing enabled -> disabled
		expect(b.order).toBe(100); // missing weight -> default
	});
});

// ---------------------------------------------------------------------------
// 20. Risu converter
// ---------------------------------------------------------------------------

describe('risu converter', () => {
	it('splits CSV keys, maps alwaysActive/insertorder/activationPercent, and keeps the useProbability quirk', () => {
		const { entries, sourceFormat } = parseLorebook(
			{
				type: 'risu',
				data: [
					{
						key: 'a, b ,,c',
						secondkey: ' x , ,y ',
						content: 'C',
						comment: 'cm',
						alwaysActive: true,
						insertorder: 7,
						activationPercent: 30
					},
					{ key: 'd', content: 'D' }, // no activationPercent
					{ key: 'e', content: 'E', activationPercent: 0 } // ST quirk: 0 stays falsy
				]
			},
			'Fallback'
		);
		expect(sourceFormat).toBe('risu');

		const [a, b, c] = entries;
		expect(a.key).toEqual(['a', 'b', 'c']); // split, trimmed, empties dropped
		expect(a.keysecondary).toEqual(['x', 'y']);
		expect(a.content).toBe('C');
		expect(a.comment).toBe('cm');
		expect(a.constant).toBe(true); // alwaysActive
		expect(a.order).toBe(7); // insertorder
		expect(a.probability).toBe(30); // activationPercent
		expect(a.useProbability).toBeTruthy(); // 30 is truthy
		expect(a.addMemo).toBe(true);
		expect(a.disable).toBe(false); // risu never imports disabled

		expect(b.useProbability).toBe(true); // missing activationPercent -> ?? true
		expect(b.probability).toBe(100);

		// ST quirk: `activationPercent ?? true` yields 0, and `??`-style backfill
		// keeps the falsy 0 instead of falling back to true.
		expect(c.useProbability as unknown).toBe(0);
		expect(c.useProbability).toBeFalsy();
		expect(c.probability).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 21. character_book converter
// ---------------------------------------------------------------------------

describe('character_book converter', () => {
	it('maps V2 character_book fields, extensions and uid fallbacks', () => {
		const json = {
			name: 'CB',
			entries: [
				{
					keys: ['a'],
					secondary_keys: ['b'],
					insertion_order: 55,
					position: 'before_char',
					enabled: true,
					id: 9,
					comment: 'Note',
					extensions: { scan_depth: 7, case_sensitive: true, group: 'g', sticky: 3 }
				},
				{ keys: ['c'], position: 'after_char', id: 'not-a-number' }, // no enabled/comment
				{ keys: ['d'], extensions: { position: 4, display_index: 2 } }
			]
		};
		const { entries, sourceFormat, name, originalData } = parseLorebook(json, 'FB');
		expect(sourceFormat).toBe('character_book');
		expect(name).toBe('CB');
		expect(originalData).toBe(json);

		const [a, b, c] = entries;
		// Field mapping
		expect(a.key).toEqual(['a']);
		expect(a.keysecondary).toEqual(['b']);
		expect(a.order).toBe(55);
		expect(a.position).toBe(0); // before_char -> 0
		expect(a.constant).toBe(false);
		expect(a.selective).toBe(false);
		// uid + flags
		expect(a.uid).toBe(9); // finite entry.id wins
		expect(a.disable).toBe(false); // enabled: true
		expect(a.addMemo).toBe(true); // has a comment
		// snake_case extensions -> camelCase fields
		expect(a.scanDepth).toBe(7);
		expect(a.caseSensitive).toBe(true);
		expect(a.group).toBe('g');
		expect(a.sticky).toBe(3);
		expect(a.displayIndex).toBe(9); // no extensions.display_index -> defaults to uid

		expect(b.position).toBe(1); // after_char -> else branch
		expect(b.uid).toBe(1); // non-finite id -> array index
		expect(b.disable).toBe(true); // missing enabled -> disabled
		expect(b.addMemo).toBe(false); // no comment

		expect(c.position).toBe(4); // extensions.position wins
		expect(c.uid).toBe(2); // missing id -> array index
		expect(c.displayIndex).toBe(2); // extensions.display_index
	});
});

// ---------------------------------------------------------------------------
// 22. Round-trip serialization
// ---------------------------------------------------------------------------

describe('serializeLorebook round-trip', () => {
	it('parses -> serializes -> parses back to deep-equal entries', () => {
		const nativeJson = {
			entries: {
				'3': { content: 'three', key: ['a', 'b'], order: 200, comment: 'C3' },
				'17': { content: 'seventeen', position: 2, depth: 6 }
			}
		};
		const first = parseLorebook(nativeJson, 'RT');
		const text = serializeLorebook(makeBook({ entryCount: first.entries.length }), first.entries);
		const second = parseLorebook(JSON.parse(text), 'RT again');
		expect(second.entries).toEqual(first.entries);
	});

	it('writes 4-space-indented JSON keyed by decimal uid strings', () => {
		const first = parseLorebook({ entries: { '3': { content: 'three' }, '17': { content: 'seventeen' } } }, 'RT');
		const text = serializeLorebook(makeBook(), first.entries);

		const data = JSON.parse(text) as { entries: Record<string, unknown>; originalData?: unknown };
		expect(Object.keys(data.entries)).toEqual(['3', '17']);
		expect(data.originalData).toBeUndefined();
		// 4-space indentation, as ST writes world files.
		expect(text).toBe(JSON.stringify(JSON.parse(text), null, 4));
	});

	it('strips a stray lorebookId from the output', () => {
		const first = parseLorebook({ entries: { '3': { content: 'three' } } }, 'RT');
		const row = { ...first.entries[0], lorebookId: 42 } as LorebookEntry & { lorebookId: number };
		const text = serializeLorebook(makeBook(), [row]);
		const data = JSON.parse(text) as { entries: Record<string, Record<string, unknown>> };
		expect(data.entries['3']).not.toHaveProperty('lorebookId');
	});

	it('includes originalData only when the book has it', () => {
		const entries = parseLorebook({ entries: { '1': { content: 'x' } } }, 'RT').entries;
		const withOriginal = serializeLorebook(makeBook({ originalData: { hello: 'world' } }), entries);
		expect((JSON.parse(withOriginal) as { originalData: unknown }).originalData).toEqual({ hello: 'world' });

		const withoutOriginal = serializeLorebook(makeBook(), entries);
		expect(JSON.parse(withoutOriginal)).not.toHaveProperty('originalData');
	});
});
