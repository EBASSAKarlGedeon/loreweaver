// Lorebook (SillyTavern "World Info") evaluation engine — a pure port of
// SillyTavern 1.18.0 activation logic. Source citations use "WI:<line>" for
// reference/SillyTavern-1.18.0/public/scripts/world-info.js and
// "script.js:<line>" for reference/SillyTavern-1.18.0/public/script.js.
//
// Phase 1 runs a SINGLE evaluation pass (no recursion): ST's
// world_info_recursive defaults to false (WI:75), so one pass matches default
// ST behaviour. Every gate ST only evaluates in later phases (triggers,
// character filter, sticky/cooldown/delay timers, delayUntilRecursion,
// excludeRecursion, external activation, budget, groups, recursion) is skipped
// and marked with "// Phase 2:".
//
// Performance: literal keys are matched with one inline Aho-Corasick automaton
// per (scanDepth, caseSensitive, matchWholeWords) bucket, so a scan costs
// O(text length + matches) per bucket instead of O(keys x messages).
//
// This module imports nothing but ./types — no Dexie, no settings singleton,
// no browser APIs — so it stays trivially testable.

import type {
	ChatMessage,
	FlatLoreEntry,
	LorebookAtDepthGroup,
	LorebookInjection,
	Role
} from './types';
import { WI_LOGIC, WI_POSITION } from './types';

// world-info.js:96,98
const DEFAULT_DEPTH = 4;
const MAX_SCAN_DEPTH = 1000;
// world-info.js:100
const KNOWN_DECORATORS: readonly string[] = ['@@activate', '@@dont_activate'];
// world-info.js:295-296 — the scan buffer joins messages with '\n' + '\x01'
const JOINER = '\n\x01';
// extension_prompt_roles (WI:5117,5124)
const ROLE_SYSTEM = 0;
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

/**
 * Settings the evaluator needs for one pass. This mirrors ST's
 * world_info_depth / world_info_include_names / world_info_case_sensitive /
 * world_info_match_whole_words plus the {{user}}/{{char}} substitution names.
 */
export interface LorebookGlobals {
	depth: number; // global scan depth (settings.lorebookDepth; ST world_info_depth)
	includeNames: boolean; // prefix "Name: " on scan lines (ST world_info_include_names)
	caseSensitive: boolean; // default for entries whose caseSensitive is null
	matchWholeWords: boolean; // default for entries whose matchWholeWords is null
	userName: string; // {{user}} substitution + name prefix
	characterName: string; // {{char}} substitution + name prefix
}

// ---------------------------------------------------------------------------
// Scan text
// ---------------------------------------------------------------------------

/**
 * Maps history (oldest -> newest) to scan lines and returns them NEWEST-FIRST,
 * mirroring ST's `coreChat.map(...).reverse()` (script.js:4565). Slicing the
 * first N of the result therefore takes the N most recent messages.
 */
export function buildScanMessages(history: ChatMessage[], globals: LorebookGlobals): string[] {
	const chatForWI = history.map((m) =>
		globals.includeNames
			? `${m.role === 'assistant' ? globals.characterName : globals.userName}: ${m.content}`
			: m.content
	);
	// script.js:4565 builds chatForWI then reverses it in place; .map() already
	// produced a fresh array, so reversing it cannot touch the caller's history.
	return chatForWI.reverse();
}

// ---------------------------------------------------------------------------
// Key/content preparation helpers
// ---------------------------------------------------------------------------

/**
 * Phase 1 macro subset. ST runs its full substituteParams (every {{...}} macro,
 * times, random roll, etc.) over keys and content; porting that whole macro
 * language is deferred to Phase 2. Only the two identity macros are handled
 * here, in the two first-letter case variants ST recognizes: {{user}}/{{User}}
 * and {{char}}/{{Char}}.
 */
function substituteMacros(text: string, globals: LorebookGlobals): string {
	// Function replacers so names containing '$&'-style replacement patterns
	// are inserted literally.
	return text
		.replace(/\{\{user\}\}/g, () => globals.userName)
		.replace(/\{\{User\}\}/g, () => globals.userName)
		.replace(/\{\{char\}\}/g, () => globals.characterName)
		.replace(/\{\{Char\}\}/g, () => globals.characterName);
}

/**
 * Port of parseDecorators (WI:4540-4586), line for line, quirks included:
 * - only leading consecutive '@@' lines are consumed;
 * - '@@@' lines are skipped until an unknown '@@' line has set the fallback
 *   flag, after which they are recorded with one '@' stripped;
 * - unknown '@@' lines are stripped from the content but not recorded;
 * - content made up solely of '@@' lines is returned UNCHANGED (the source
 *   never reaches its `newContent = ...` reassignment in that case).
 * Recognized decorators (WI:100): '@@activate' forces activation,
 * '@@dont_activate' forbids it.
 */
function parseDecorators(content: string): [string[], string] {
	const isKnownDecorator = (data: string): boolean => {
		if (data.startsWith('@@@')) {
			data = data.substring(1);
		}
		for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
			if (data.startsWith(KNOWN_DECORATORS[i])) {
				return true;
			}
		}
		return false;
	};

	if (content.startsWith('@@')) {
		let newContent = content;
		const splited = content.split('\n');
		const decorators: string[] = [];
		let fallbacked = false;

		for (let i = 0; i < splited.length; i++) {
			if (splited[i].startsWith('@@')) {
				if (splited[i].startsWith('@@@') && !fallbacked) {
					continue;
				}
				if (isKnownDecorator(splited[i])) {
					decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i]);
					fallbacked = false;
				} else {
					fallbacked = true;
				}
			} else {
				newContent = splited.slice(i).join('\n');
				break;
			}
		}
		return [decorators, newContent];
	}

	return [[], content];
}

/**
 * Port of parseRegexFromString (WI:2821-2846): '/pattern/flags' with optional
 * flags limited to [gimsuy] and every '/' inside the pattern escaped. Returns
 * null for anything else (including a pattern that fails to compile), in which
 * case the key is treated as a plain substring (WI:337-343).
 */
function parseRegexKey(key: string): RegExp | null {
	const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
	if (!match) {
		return null;
	}
	let pattern = match[1];
	const flags = match[2];
	// Reject an unescaped '/' delimiter (WI:2833-2835)...
	if (/(^|[^\\])\//.test(pattern)) {
		return null;
	}
	// ...then unescape it — only the first occurrence, as the source does.
	pattern = pattern.replace('\\/', '/');
	try {
		return new RegExp(pattern, flags);
	} catch {
		return null; // invalid syntax -> plain key (WI:2843-2845)
	}
}

/** One cleaned key: either a literal substring or a compiled regex literal. */
type CleanKey = { kind: 'literal'; needle: string } | { kind: 'regex'; re: RegExp };

/**
 * Macro-substitute -> trim -> drop empties -> classify (4c). Applies to primary
 * and secondary lists alike; ST does the same substitution per key at scan
 * time (WI:4803-4804, 4835-4836).
 */
function cleanKeys(keys: string[] | undefined, globals: LorebookGlobals): CleanKey[] {
	const out: CleanKey[] = [];
	if (!Array.isArray(keys)) return out; // ST guards with !Array.isArray (WI:4793)
	for (const raw of keys) {
		if (typeof raw !== 'string') continue;
		const substituted = substituteMacros(raw, globals).trim();
		if (!substituted) continue; // empty keys are dropped (4c)
		const re = parseRegexKey(substituted);
		out.push(re ? { kind: 'regex', re } : { kind: 'literal', needle: substituted });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Aho-Corasick (inline — no new dependencies)
// ---------------------------------------------------------------------------

/**
 * One literal keyword: shared by every entry in a bucket that uses it, with
 * the entry indices that need it as a PRIMARY match (candidate test) and as a
 * SECONDARY match (selectiveLogic) tracked separately (4f).
 */
interface KeywordRec {
	length: number; // needle length — needed for the boundary check on a hit
	boundary: boolean; // whole-word check required for this needle
	primary: number[]; // entry indices where this is a primary key
	secondary: Array<{ entry: number; pos: number }>; // entry + index into cleaned secondary keys
}

interface ACNode {
	children: Map<number, ACNode>; // keyed by UTF-16 code unit (String.includes semantics)
	fail: ACNode; // fail link; self until the BFS rewires it (root keeps the self link)
	dict: ACNode | null; // nearest fail-ancestor that carries outputs
	outputs: number[]; // keyword ids ending at this node
}

function makeAcNode(): ACNode {
	const node: ACNode = {
		children: new Map(),
		fail: undefined as unknown as ACNode, // replaced immediately below
		dict: null,
		outputs: []
	};
	node.fail = node;
	return node;
}

/** JS \w — [A-Za-z0-9_] only; used for ST's whole-word boundaries (WI:356). */
function isWordChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		code === 95 // _
	);
}

/**
 * One scan over one bucket's text with one automaton built from every literal
 * key of that bucket (4f). Each hit is boundary-checked when the key needs it,
 * then mapped back to the entries that use the keyword.
 *
 * The boundary check replicates ST's whole-word regex `(?:^|\W)(key)(?:$|\W)`
 * (WI:349-360) per occurrence: the characters immediately before/after the
 * match must be edges or non-word characters.
 */
function runAhoCorasick(bucket: Bucket, text: string, primaryHit: boolean[], prepared: PreparedEntry[]): void {
	// Automaton output ids <-> keyword records.
	const recs: KeywordRec[] = [];
	const ids = new Map<string, number>();
	for (const [needle, rec] of bucket.literals) {
		ids.set(needle, recs.length);
		recs.push(rec);
	}

	const root = makeAcNode();

	// Insert every keyword, code unit by code unit.
	for (const [needle, id] of ids) {
		let node = root;
		for (let j = 0; j < needle.length; j++) {
			const code = needle.charCodeAt(j);
			let child = node.children.get(code);
			if (!child) {
				child = makeAcNode();
				node.children.set(code, child);
			}
			node = child;
		}
		node.outputs.push(id);
	}

	// BFS fail links (depth-1 first), then the dictionary-suffix link: the
	// nearest fail-ancestor carrying outputs. Both are assigned when a node is
	// enqueued, so its fail target is always already resolved.
	const queue: ACNode[] = [];
	for (const child of root.children.values()) {
		child.fail = root;
		child.dict = root.outputs.length > 0 ? root : root.dict; // root never has outputs (empty keys are dropped)
		queue.push(child);
	}
	for (let qi = 0; qi < queue.length; qi++) {
		const cur = queue[qi];
		for (const [code, child] of cur.children) {
			let f = cur.fail;
			while (f !== root && !f.children.has(code)) {
				f = f.fail;
			}
			child.fail = f.children.get(code) ?? root;
			child.dict = child.fail.outputs.length > 0 ? child.fail : child.fail.dict;
			queue.push(child);
		}
	}

	// Scan once over the bucket's (folded) text.
	let node = root;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		let next = node.children.get(code);
		while (node !== root && !next) {
			node = node.fail;
			next = node.children.get(code);
		}
		node = next ?? root;
		if (!node.outputs.length && !node.dict) continue;

		for (let out: ACNode | null = node.outputs.length > 0 ? node : node.dict; out; out = out.dict) {
			for (const id of out.outputs) {
				const rec = recs[id];
				const start = i - rec.length + 1; // needle ends at i
				if (rec.boundary) {
					const beforeOk = start === 0 || !isWordChar(text.charCodeAt(start - 1));
					const afterOk = i + 1 === text.length || !isWordChar(text.charCodeAt(i + 1));
					if (!beforeOk || !afterOk) continue;
				}
				for (const idx of rec.primary) primaryHit[idx] = true;
				for (const s of rec.secondary) prepared[s.entry].secondaryHits[s.pos] = true;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Entries grouped by the three resolved match flags + effective scan depth (4f). */
interface Bucket {
	depth: number; // effectiveDepth = min(scanDepth ?? globals.depth, 1000)
	caseSensitive: boolean; // entry.caseSensitive ?? globals.caseSensitive
	wholeWords: boolean; // entry.matchWholeWords ?? globals.matchWholeWords
	/** literal needle (folded when case-insensitive) -> shared record */
	literals: Map<string, KeywordRec>;
	/** entry index -> compiled primary regex keys (WI:337-342: raw-text match) */
	regexPrimary: Map<number, RegExp[]>;
	/** entry index -> compiled secondary regex keys with their cleaned-list position */
	regexSecondary: Map<number, Array<{ pos: number; re: RegExp }>>;
}

/** Per-entry state prepared before the gate pass. */
interface PreparedEntry {
	flat: FlatLoreEntry;
	decorators: string[]; // from parseDecorators (4b)
	content: string; // decorator-stripped content; macros resolve at activation (4c)
	primaryCount: number; // cleaned primary keys (4c)
	secondaryCount: number; // cleaned secondary keys (4c)
	secondaryHits: boolean[]; // per secondary key, filled by the bucket scan
}

/**
 * Evaluates one pass of ST World Info activation and returns the Phase 1
 * injection payload.
 *
 * Processing order is the INPUT order (4a) — callers pre-sort (chat source,
 * then persona, then character/global per strategy; descending `order` within
 * each source) exactly like ST's getSortedEntries (WI:4463-4515). No
 * re-sorting happens until emission.
 */
export function evaluateLorebooks(
	entries: FlatLoreEntry[],
	scanMessages: string[],
	globals: LorebookGlobals
): LorebookInjection {
	// Dedupe by (bookId, uid) up front (4i) — ST keys its activated-entry map
	// the same way, `${world}.${uid}` (WI:4685, 4956).
	const seen = new Set<string>();
	const flat: FlatLoreEntry[] = [];
	for (const f of entries) {
		const key = `${f.bookId}:${f.entry.uid}`;
		if (seen.has(key)) continue;
		seen.add(key);
		flat.push(f);
	}
	if (flat.length === 0) {
		return { before: '', after: '', atDepth: [], activated: [] }; // 4i
	}

	// --- 1-2. Decorators + cleaned keys, one bucket per resolved flag triple ---
	const prepared: PreparedEntry[] = [];
	const buckets = new Map<string, Bucket>();
	const depthText = new Map<number, string>();

	const getRawText = (depth: number): string => {
		let text = depthText.get(depth);
		if (text === undefined) {
			text = scanMessages.slice(0, depth).join(JOINER); // 4e
			depthText.set(depth, text);
		}
		return text;
	};

	const getBucket = (depth: number, caseSensitive: boolean, wholeWords: boolean): Bucket => {
		const key = `${depth}|${caseSensitive ? 'cs' : 'ci'}|${wholeWords ? 'ww' : 'sub'}`;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				depth,
				caseSensitive,
				wholeWords,
				literals: new Map(),
				regexPrimary: new Map(),
				regexSecondary: new Map()
			};
			buckets.set(key, bucket);
		}
		return bucket;
	};

	for (let i = 0; i < flat.length; i++) {
		const entry = flat[i].entry;
		const [decorators, stripped] = parseDecorators(entry.content ?? ''); // 4b
		const caseSensitive = entry.caseSensitive ?? globals.caseSensitive;
		const wholeWords = entry.matchWholeWords ?? globals.matchWholeWords;
		// ST clamps scan depth to MAX_SCAN_DEPTH (WI:290-293) and returns ''
		// for depth <= 0 (WI:281-288); slicing makes both fall out naturally.
		const depth = Math.max(0, Math.min(entry.scanDepth ?? globals.depth, MAX_SCAN_DEPTH)); // 4e
		const bucket = getBucket(depth, caseSensitive, wholeWords);

		const primaryKeys = cleanKeys(entry.key, globals);
		const secondaryKeys = cleanKeys(entry.keysecondary, globals);

		for (const key of primaryKeys) {
			if (key.kind === 'regex') {
				const list = bucket.regexPrimary.get(i) ?? [];
				list.push(key.re);
				bucket.regexPrimary.set(i, list);
			} else {
				// Case-insensitive buckets store and match the folded needle so
				// one automaton serves every entry in the bucket (4f).
				const needle = bucket.caseSensitive ? key.needle : key.needle.toLowerCase();
				let rec = bucket.literals.get(needle);
				if (!rec) {
					rec = {
						length: needle.length,
						// Whole-word needles containing whitespace stay plain
						// substrings (WI:350-353).
						boundary: bucket.wholeWords && !/\s/.test(needle),
						primary: [],
						secondary: []
					};
					bucket.literals.set(needle, rec);
				}
				rec.primary.push(i);
			}
		}

		for (let pos = 0; pos < secondaryKeys.length; pos++) {
			const key = secondaryKeys[pos];
			if (key.kind === 'regex') {
				const list = bucket.regexSecondary.get(i) ?? [];
				list.push({ pos, re: key.re });
				bucket.regexSecondary.set(i, list);
			} else {
				const needle = bucket.caseSensitive ? key.needle : key.needle.toLowerCase();
				let rec = bucket.literals.get(needle);
				if (!rec) {
					rec = {
						length: needle.length,
						boundary: bucket.wholeWords && !/\s/.test(needle),
						primary: [],
						secondary: []
					};
					bucket.literals.set(needle, rec);
				}
				rec.secondary.push({ entry: i, pos });
			}
		}

		prepared.push({
			flat: flat[i],
			decorators,
			content: stripped,
			primaryCount: primaryKeys.length,
			secondaryCount: secondaryKeys.length,
			secondaryHits: new Array<boolean>(secondaryKeys.length).fill(false)
		});
	}

	// --- 3-4. Run every bucket's automaton over its own scan text (4f) ---
	const primaryHit = new Array<boolean>(flat.length).fill(false);
	for (const bucket of buckets.values()) {
		const rawText = getRawText(bucket.depth);
		// Case-insensitive buckets scan the folded text; the fold happens once
		// per bucket, never per keyword or per message.
		const text = bucket.caseSensitive ? rawText : rawText.toLowerCase();

		if (bucket.literals.size > 0) {
			runAhoCorasick(bucket, text, primaryHit, prepared);
		}

		// Regex-literal keys were compiled once per entry (cleanKeys) and run on
		// the RAW scan text — a regex key overrides the case/whole-word options
		// (WI:337-343). lastIndex is reset so 'g'/'y' flags behave like ST's
		// freshly constructed RegExp on every call (WI:2842).
		for (const [idx, regexes] of bucket.regexPrimary) {
			if (primaryHit[idx]) continue;
			for (const re of regexes) {
				re.lastIndex = 0;
				if (re.test(rawText)) {
					primaryHit[idx] = true;
					break;
				}
			}
		}
		for (const [idx, list] of bucket.regexSecondary) {
			const hits = prepared[idx].secondaryHits;
			for (const { pos, re } of list) {
				if (hits[pos]) continue;
				re.lastIndex = 0;
				if (re.test(rawText)) hits[pos] = true;
			}
		}
	}

	// --- 5. Gates in ST's order (WI:4673-4877), minus the Phase 2 gates ---
	// Phase 2 (skipped entirely, WI:4694-4761): generation-type triggers,
	// character/tag filter, delay/cooldown timers, delayUntilRecursion and
	// excludeRecursion. Phase 2: external activation (WI:4774-4778) and the
	// sticky short-circuit (WI:4787-4791) are also deferred.
	const candidates: number[] = [];
	for (let i = 0; i < flat.length; i++) {
		const prep = prepared[i];
		const entry = prep.flat.entry;

		if (entry.disable) continue; // WI:4689-4692

		// ST checks @@activate first, then @@dont_activate (WI:4763-4772), so a
		// content carrying both decorators activates — replicated verbatim.
		if (prep.decorators.includes('@@activate')) {
			candidates.push(i); // WI:4763-4767
			continue;
		}
		if (prep.decorators.includes('@@dont_activate')) continue; // WI:4769-4772

		if (entry.constant) {
			candidates.push(i); // WI:4781-4785
			continue;
		}

		// Empty key list after cleaning skips the entry (WI:4793-4796); entries
		// already candidates above never reach this line (4d).
		if (prep.primaryCount === 0) continue;
		if (!primaryHit[i]) continue; // WI:4807-4810

		// Secondary keys apply only when entry.selective is true AND the
		// cleaned list is non-empty (WI:4812-4816 — the "all entries are
		// selective now" text there is a comment on ST's UI, not on this
		// check). selective:false entries activate on the primary match alone.
		if (!entry.selective || prep.secondaryCount === 0) {
			candidates.push(i); // WI:4818-4823
			continue;
		}

		// Secondary logic per WI_LOGIC (WI:4827-4872).
		const hits = prep.secondaryHits;
		let hasAnyMatch = false;
		let hasAllMatch = true;
		for (let pos = 0; pos < hits.length; pos++) {
			if (hits[pos]) hasAnyMatch = true;
			else hasAllMatch = false;
		}
		const logic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY; // WI:4827
		const ok =
			logic === WI_LOGIC.AND_ANY
				? hasAnyMatch // any secondary matches
				: logic === WI_LOGIC.NOT_ALL
					? !hasAllMatch // at least one secondary does NOT match
					: logic === WI_LOGIC.NOT_ANY
						? !hasAnyMatch // none match
						: hasAllMatch; // WI_LOGIC.AND_ALL — all match
		if (ok) candidates.push(i);
	}

	// --- 6. Probability (WI:4909-4936) — after gates, before emission (4g) ---
	const activated: PreparedEntry[] = [];
	for (const i of candidates) {
		const entry = flat[i].entry;
		if (entry.useProbability && entry.probability < 100) {
			// Phase 2: ST skips the re-roll while the entry is sticky-active
			// (WI:4916-4920).
			if (!(Math.random() * 100 <= entry.probability)) continue;
		}
		// Macros in content resolve at activation time (4c); ST does it in the
		// same spot, right after the probability check (WI:4939).
		prepared[i].content = substituteMacros(prepared[i].content, globals);
		activated.push(prepared[i]);
	}

	// --- 7. Emission (WI:5070-5163) ---
	// Sort activated entries by order DESCENDING (sortFn, WI:88; Array.sort is
	// stable, so ties keep processing order), then unshift into position buckets
	// so every bucket reads ASCENDING in order (WI:5084).
	const sorted = [...activated].sort((a, b) => b.flat.entry.order - a.flat.entry.order);

	const before: string[] = [];
	const after: string[] = [];
	interface DepthGroup {
		depth: number; // raw entry.depth, as WI:5122 pushes it
		role: number; // extension_prompt_roles value
		contents: string[];
	}
	const depthGroups: DepthGroup[] = [];

	for (const prep of sorted) {
		const entry = prep.flat.entry;
		const content = prep.content;
		if (!content) continue; // WI:5088-5091 — empty content never reaches the prompt

		switch (entry.position) {
			case WI_POSITION.BEFORE:
			case WI_POSITION.AN_TOP:
				// Phase 1 fold: ST keeps ANTop/ANBottom in their own arrays
				// around the author's note (WI:5110-5115); Phase 1 collapses
				// them into before/after.
				before.unshift(content);
				break;
			case WI_POSITION.AFTER:
			case WI_POSITION.AN_BOTTOM:
				after.unshift(content);
				break;
			case WI_POSITION.AT_DEPTH: {
				// Port of WI:5116-5127 including the source's quirk: the lookup
				// compares the stored depth against (entry.depth ?? 4), but the
				// stored depth is the RAW entry.depth (no fallback applied).
				const matchDepth = entry.depth ?? DEFAULT_DEPTH;
				const role = entry.role ?? ROLE_SYSTEM;
				const existing = depthGroups.find((g) => g.depth === matchDepth && g.role === role);
				if (existing) {
					existing.contents.unshift(content);
				} else {
					depthGroups.push({ depth: entry.depth, role, contents: [content] });
				}
				break;
			}
			case WI_POSITION.EM_TOP:
			case WI_POSITION.EM_BOTTOM:
			case WI_POSITION.OUTLET:
				// Phase 2: example-message positions (WI:5100-5109) and the
				// {{outlet}} macro (WI:5129-5140) are dropped in Phase 1.
				break;
			default:
				break; // WI:5141-5142
		}
	}

	const mapRole = (role: number): Role =>
		role === ROLE_USER ? 'user' : role === ROLE_ASSISTANT ? 'assistant' : 'system';

	const atDepth: LorebookAtDepthGroup[] = depthGroups.map((g) => ({
		depth: g.depth,
		role: mapRole(g.role),
		content: g.contents.join('\n')
	}));

	return {
		before: before.join('\n'), // WI:5146 (join of [] is '')
		after: after.join('\n'), // WI:5147
		atDepth,
		// Every entry that survived gates + probability, in processing order —
		// ST reports the same set regardless of position bucket (WI:5162).
		activated: activated.map((p) => ({ bookId: p.flat.bookId, uid: p.flat.entry.uid }))
	};
}
