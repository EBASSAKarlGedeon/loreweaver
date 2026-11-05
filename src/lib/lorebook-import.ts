import { db } from './db';
import type { Lorebook, LorebookEntry, LorebookEntryRow, LorebookSourceFormat } from './types';

// Lorebook (SillyTavern "World Info") import/export.
//
// parseLorebook() recognizes the formats SillyTavern's importWorldInfo converts
// (world-info.js:5731-5812) plus ST's own native JSON shape, and normalizes
// every entry to the LorebookEntry vocabulary in types.ts through a single
// template-defaults backfill. saveLorebook() persists the result to Dexie;
// serializeLorebook() writes it back out the way ST saves world files
// (src/endpoints/worldinfo.js:154).
//
// Parsing is pure: nothing here touches Dexie except saveLorebook().

/** A parsed lorebook, ready to save. Entries are normalized and have no lorebookId. */
export interface ParsedLorebook {
	name: string;
	sourceFormat: LorebookSourceFormat;
	entries: LorebookEntry[]; // normalized; no lorebookId (assigned on save)
	originalData?: unknown; // raw source for lossless re-export (character_book only)
}

/** A parsed JSON object as it comes out of JSON.parse. */
type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Coercions shared by every converter via the backfill
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Raw {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function asRecord(value: unknown): Raw {
	return isPlainObject(value) ? value : {};
}

/** Strings: keep strings, stringify numbers/booleans, everything else → default. */
function toStr(value: unknown, def = ''): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return def;
}

/** Booleans via `?? default` — never truthiness, so `false` survives (WI:4002-4045). */
function toBool(value: unknown, def: boolean): boolean {
	return (value ?? def) as boolean;
}

/** Nullable booleans: only `null`/`undefined` mean "inherit the global setting". */
function toBoolOrNull(value: unknown): boolean | null {
	return (value ?? null) as boolean | null;
}

/** Numbers: nullish → default; non-finite or non-number junk → default. */
function toNum(value: unknown, def: number): number {
	const num = value ?? def;
	return typeof num === 'number' && Number.isFinite(num) ? num : def;
}

/** Nullable numbers (WI's "number?" fields): same rule, default null. */
function toNumOrNull(value: unknown): number | null {
	const num = value ?? null;
	return typeof num === 'number' && Number.isFinite(num) ? num : null;
}

/** Arrays: a single string wraps to `[s]`, nullish/junk → []. */
function toArray(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return [...value] as string[];
	return [];
}

/** Risu's comma-separated key lists: split, trim, drop empties (WI:5403-5446). */
function splitCsv(value: unknown): string[] {
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
	}
	if (Array.isArray(value)) {
		return value
			.filter((part): part is string => typeof part === 'string')
			.map((part) => part.trim())
			.filter((part) => part !== '');
	}
	return [];
}

/**
 * The character filter: an object with the expected structure, else the legacy
 * flat characterFilterNames/characterFilterTags/characterFilterExclude fields
 * that older ST files stored (world-info.js:4041-4043), else the default
 * (world-info.js:2125-2132).
 */
function toCharacterFilter(raw: Raw): { isExclude: boolean; names: string[]; tags: string[] } {
	const filter = raw.characterFilter;
	if (isPlainObject(filter)) {
		return {
			isExclude: toBool(filter.isExclude, false),
			names: toArray(filter.names),
			tags: toArray(filter.tags)
		};
	}
	if (
		'characterFilterNames' in raw ||
		'characterFilterTags' in raw ||
		'characterFilterExclude' in raw
	) {
		return {
			isExclude: toBool(raw.characterFilterExclude, false),
			names: toArray(raw.characterFilterNames),
			tags: toArray(raw.characterFilterTags)
		};
	}
	return { isExclude: false, names: [], tags: [] };
}

// ---------------------------------------------------------------------------
// The single template-defaults backfill
// ---------------------------------------------------------------------------

/**
 * Fills every missing field on a raw entry with its template default and
 * coerces values to their expected types — the port of addMissingWorldInfoFields
 * (world-info.js:2104-2136) against the default set in
 * newWorldInfoEntryDefinition (world-info.js:4002-4045):
 *
 * - missing fields → template defaults (displayIndex defaults to uid, the same
 *   fallback ST applies at world-info.js:2365);
 * - booleans via `?? default` (never truthiness), with incoming `true` on the
 *   numeric delayUntilRecursion coerced to 1;
 * - numbers via nullish + Number.isFinite, falling back to the default;
 * - key/keysecondary/triggers normalize to arrays;
 * - legacy flat characterFilter* fields fold into characterFilter
 *   (world-info.js:4041-4043);
 * - unknown extra fields are dropped: the result is exactly a LorebookEntry.
 */
function backfillEntry(raw: Raw, uid: number): LorebookEntry {
	return {
		uid,
		key: toArray(raw.key),
		keysecondary: toArray(raw.keysecondary),
		comment: toStr(raw.comment),
		content: toStr(raw.content),
		constant: toBool(raw.constant, false),
		vectorized: toBool(raw.vectorized, false),
		selective: toBool(raw.selective, true),
		selectiveLogic: toNum(raw.selectiveLogic, 0),
		addMemo: toBool(raw.addMemo, false),
		order: toNum(raw.order, 100),
		position: toNum(raw.position, 0),
		disable: toBool(raw.disable, false),
		ignoreBudget: toBool(raw.ignoreBudget, false),
		excludeRecursion: toBool(raw.excludeRecursion, false),
		preventRecursion: toBool(raw.preventRecursion, false),
		matchPersonaDescription: toBool(raw.matchPersonaDescription, false),
		matchCharacterDescription: toBool(raw.matchCharacterDescription, false),
		matchCharacterPersonality: toBool(raw.matchCharacterPersonality, false),
		matchCharacterDepthPrompt: toBool(raw.matchCharacterDepthPrompt, false),
		matchScenario: toBool(raw.matchScenario, false),
		matchCreatorNotes: toBool(raw.matchCreatorNotes, false),
		delayUntilRecursion:
			raw.delayUntilRecursion === true ? 1 : toNum(raw.delayUntilRecursion, 0),
		probability: toNum(raw.probability, 100),
		useProbability: toBool(raw.useProbability, true),
		depth: toNum(raw.depth, 4),
		outletName: toStr(raw.outletName),
		group: toStr(raw.group),
		groupOverride: toBool(raw.groupOverride, false),
		groupWeight: toNum(raw.groupWeight, 100),
		scanDepth: toNumOrNull(raw.scanDepth),
		caseSensitive: toBoolOrNull(raw.caseSensitive),
		matchWholeWords: toBoolOrNull(raw.matchWholeWords),
		useGroupScoring: toBoolOrNull(raw.useGroupScoring),
		automationId: toStr(raw.automationId),
		role: toNum(raw.role, 0),
		sticky: toNumOrNull(raw.sticky),
		cooldown: toNumOrNull(raw.cooldown),
		delay: toNumOrNull(raw.delay),
		triggers: toArray(raw.triggers),
		characterFilter: toCharacterFilter(raw),
		displayIndex: toNum(raw.displayIndex, uid)
	};
}

/**
 * Normalizes one raw native entry under its uid (world-info.js:2104-2136):
 * the template backfill plus type coercion; unknown fields dropped.
 */
function normalizeNativeEntry(value: unknown, uid: number): LorebookEntry {
	return backfillEntry(asRecord(value), uid);
}

// ---------------------------------------------------------------------------
// Converters — one per source format
// ---------------------------------------------------------------------------

/**
 * Novel Lorebook → WI entries (world-info.js:5448-5496): keys→key,
 * displayName→comment (+addMemo), text→content, enabled===false→disable,
 * contextConfig.budgetPriority→order when finite (else the source's `?? 0`);
 * everything else takes the template defaults.
 */
function convertNovelai(json: Raw): LorebookEntry[] {
	const list = Array.isArray(json.entries) ? json.entries : [];
	return list.map((item, index) => {
		const entry = asRecord(item);
		const budgetPriority = asRecord(entry.contextConfig).budgetPriority;
		return backfillEntry(
			{
				key: entry.keys,
				comment: toStr(entry.displayName),
				content: toStr(entry.text),
				constant: false,
				selective: false,
				order:
					typeof budgetPriority === 'number' && Number.isFinite(budgetPriority)
						? budgetPriority
						: 0,
				// ST inverts truthiness, not strict === false: an entry with no
				// `enabled` field imports disabled, exactly like WI:5470.
				disable: !entry.enabled,
				addMemo: true
			},
			index
		);
	});
}

/**
 * Agnai memory book → WI entries (world-info.js:5358-5401): keywords→key,
 * name→comment (+addMemo), entry→content, weight→order, enabled→disable
 * inverted exactly as the source's `!entry.enabled` coercion; constant and
 * selective forced false; the rest are template defaults.
 */
function convertAgnai(json: Raw): LorebookEntry[] {
	const list = Array.isArray(json.entries) ? json.entries : [];
	return list.map((item, index) => {
		const entry = asRecord(item);
		return backfillEntry(
			{
				key: entry.keywords,
				comment: toStr(entry.name),
				content: toStr(entry.entry),
				constant: false,
				selective: false,
				order: entry.weight,
				disable: !entry.enabled,
				addMemo: true
			},
			index
		);
	});
}

/**
 * Risu lorebook → WI entries (world-info.js:5403-5446): key/secondkey
 * comma-split into key/keysecondary (trimmed, empties dropped), alwaysActive→
 * constant, insertorder→order, activationPercent→probability and — as in the
 * source — `activationPercent ?? true`→useProbability (the backfill's `??`
 * reproduces it, including a falsy 0); addMemo forced on.
 */
function convertRisu(json: Raw): LorebookEntry[] {
	const list = Array.isArray(json.data) ? json.data : [];
	return list.map((item, index) => {
		const entry = asRecord(item);
		return backfillEntry(
			{
				key: splitCsv(entry.key),
				keysecondary: splitCsv(entry.secondkey),
				comment: toStr(entry.comment),
				content: toStr(entry.content),
				constant: entry.alwaysActive,
				selective: entry.selective,
				order: entry.insertorder,
				disable: false,
				addMemo: true,
				probability: entry.activationPercent,
				useProbability: entry.activationPercent
			},
			index
		);
	});
}

/**
 * V2 character_book → WI entries (world-info.js:5498-5555): keys→key,
 * secondary_keys→keysecondary, insertion_order→order, enabled===false→disable,
 * position = extensions.position ?? (before_char ? 0 : 1), and the snake_case
 * `extensions` fields mapped to their camelCase LorebookEntry names. uid comes
 * from entry.id when finite, else the array index. The raw object itself is
 * kept by parseLorebook as originalData for lossless re-export.
 */
function convertCharacterBook(json: Raw): LorebookEntry[] {
	const list = Array.isArray(json.entries) ? json.entries : [];
	return list.map((item, index) => {
		const entry = asRecord(item);
		const extensions = asRecord(entry.extensions);
		const id = entry.id;
		const uid = typeof id === 'number' && Number.isFinite(id) ? id : index;
		return backfillEntry(
			{
				key: entry.keys,
				keysecondary: entry.secondary_keys,
				comment: toStr(entry.comment),
				content: toStr(entry.content),
				constant: entry.constant,
				selective: entry.selective ?? false,
				order: entry.insertion_order,
				position: extensions.position ?? (entry.position === 'before_char' ? 0 : 1),
				disable: !entry.enabled, // ST truthiness invert (WI:5521): missing field → disabled
				addMemo: !!entry.comment,
				displayIndex: extensions.display_index,
				probability: extensions.probability,
				useProbability: extensions.useProbability,
				depth: extensions.depth,
				selectiveLogic: extensions.selectiveLogic,
				outletName: extensions.outlet_name,
				group: extensions.group,
				groupOverride: extensions.group_override,
				groupWeight: extensions.group_weight,
				scanDepth: extensions.scan_depth,
				caseSensitive: extensions.case_sensitive,
				matchWholeWords: extensions.match_whole_words,
				useGroupScoring: extensions.use_group_scoring,
				automationId: extensions.automation_id,
				role: extensions.role,
				vectorized: extensions.vectorized,
				sticky: extensions.sticky,
				cooldown: extensions.cooldown,
				delay: extensions.delay,
				matchPersonaDescription: extensions.match_persona_description,
				matchCharacterDescription: extensions.match_character_description,
				matchCharacterPersonality: extensions.match_character_personality,
				matchCharacterDepthPrompt: extensions.match_character_depth_prompt,
				matchScenario: extensions.match_scenario,
				matchCreatorNotes: extensions.match_creator_notes,
				ignoreBudget: extensions.ignore_budget,
				excludeRecursion: extensions.exclude_recursion,
				preventRecursion: extensions.prevent_recursion,
				delayUntilRecursion: extensions.delay_until_recursion,
				triggers: extensions.triggers
			},
			uid
		);
	});
}

/**
 * Native ST world file → WI entries. ST stores entries as a map keyed by uid
 * (world-info.js:2358-2370): each key parses via parseInt; keys that are not a
 * finite non-negative int get a running index starting at max+1, skipping uids
 * already taken.
 */
function convertNative(json: Raw): LorebookEntry[] {
	const entries = asRecord(json.entries);
	const keys = Object.keys(entries);

	let maxUid = -1;
	for (const key of keys) {
		const parsed = parseInt(key, 10);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed > maxUid) maxUid = parsed;
	}

	const taken = new Set<number>();
	let next = maxUid + 1;
	return keys.map((key) => {
		const parsed = parseInt(key, 10);
		let uid: number;
		if (Number.isFinite(parsed) && parsed >= 0 && !taken.has(parsed)) {
			uid = parsed;
		} else {
			while (taken.has(next)) next += 1;
			uid = next;
			next += 1;
		}
		taken.add(uid);
		return normalizeNativeEntry(entries[key], uid);
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function unrecognized(json: unknown): Error {
	let detail: string;
	try {
		const text = JSON.stringify(json);
		detail = text === undefined ? typeof json : text.slice(0, 200);
	} catch {
		detail = typeof json;
	}
	return new Error(`Unrecognized lorebook format: ${detail}`);
}

/**
 * Parses any supported lorebook JSON into normalized entries. Format detection
 * follows importWorldInfo's order (world-info.js:5731-5812): novelai → agnai →
 * risu → native (entries is a plain object) → character_book (entries is an
 * array; a V2 character_book `{name?, entries: [...]}` always carries one) →
 * throw. Pure: no Dexie access.
 */
export function parseLorebook(json: unknown, fallbackName: string): ParsedLorebook {
	if (!isPlainObject(json)) throw unrecognized(json);

	// Convert Novel Lorebook (world-info.js:5756-5759).
	if (json.lorebookVersion !== undefined) {
		return { name: fallbackName, sourceFormat: 'novelai', entries: convertNovelai(json) };
	}

	// Convert Agnai Memory Book (world-info.js:5762-5765).
	if (json.kind === 'memory') {
		return { name: fallbackName, sourceFormat: 'agnai', entries: convertAgnai(json) };
	}

	// Convert Risu Lorebook (world-info.js:5768-5771).
	if (json.type === 'risu') {
		return { name: fallbackName, sourceFormat: 'risu', entries: convertRisu(json) };
	}

	// Native ST world file: entries is a plain object keyed by uid.
	if (isPlainObject(json.entries)) {
		return { name: fallbackName, sourceFormat: 'native', entries: convertNative(json) };
	}

	// V2 character_book (or a bare entries array).
	if (Array.isArray(json.entries)) {
		return {
			name: toStr(json.name) || fallbackName,
			sourceFormat: 'character_book',
			entries: convertCharacterBook(json),
			originalData: json
		};
	}

	throw unrecognized(json);
}

/**
 * Upserts a lorebook by exact name and writes its entries in one transaction:
 * an existing book's entries are deleted and the row updated (entryCount,
 * sourceFormat, originalData, updatedAt); otherwise a fresh row is inserted.
 * Entry rows are bulkPut in chunks of 500 so a 10k+ entry book imports without
 * blowing up a single batch. Returns the lorebook id.
 */
export async function saveLorebook(parsed: ParsedLorebook): Promise<number> {
	const now = Date.now();
	return db.transaction('rw', [db.lorebooks, db.lorebookEntries], async () => {
		const existing = await db.lorebooks.where('name').equals(parsed.name).first();
		let id: number;
		if (existing?.id !== undefined) {
			id = existing.id;
			// The import is authoritative: replace the whole entry set.
			await db.lorebookEntries.where('lorebookId').equals(id).delete();
			await db.lorebooks.put({
				...existing,
				entryCount: parsed.entries.length,
				sourceFormat: parsed.sourceFormat,
				originalData: parsed.originalData,
				updatedAt: now
			});
		} else {
			id = await db.lorebooks.add({
				name: parsed.name,
				entryCount: parsed.entries.length,
				sourceFormat: parsed.sourceFormat,
				originalData: parsed.originalData,
				createdAt: now,
				updatedAt: now
			});
		}
		// Chunked bulkPut: one huge batch can blow IndexedDB's transaction
		// limits, so 10k+ entry books go in 500-row slices.
		for (let i = 0; i < parsed.entries.length; i += 500) {
			const rows: LorebookEntryRow[] = parsed.entries.slice(i, i + 500).map((entry) => ({
				...entry,
				lorebookId: id
			}));
			await db.lorebookEntries.bulkPut(rows);
		}
		return id;
	});
}

/**
 * Writes a lorebook the way ST saves world files: `JSON.stringify(data, null, 4)`
 * (src/endpoints/worldinfo.js:154) with entries keyed by decimal uid, plus
 * originalData when the book has it. Round-trip invariant: parsing the result
 * back with parseLorebook reproduces the same entries field-for-field.
 */
export function serializeLorebook(book: Lorebook, entries: LorebookEntry[]): string {
	const map: Record<string, LorebookEntry> = {};
	for (const entry of entries) {
		const copy = { ...entry } as LorebookEntry & { lorebookId?: number };
		delete copy.lorebookId; // plain LorebookEntry in; strip rows passed by mistake
		map[String(entry.uid)] = copy;
	}
	const data: { entries: Record<string, LorebookEntry>; originalData?: unknown } = {
		entries: map
	};
	if (book.originalData) data.originalData = book.originalData;
	return JSON.stringify(data, null, 4);
}