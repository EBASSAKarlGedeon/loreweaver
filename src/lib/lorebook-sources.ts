import { db } from './db';
import { settings } from './state/settings.svelte';
import type {
	Character,
	Chat,
	ChatMessage,
	FlatLoreEntry,
	LorebookEntry,
	LorebookInjection,
	Persona
} from './types';
import { buildScanMessages, evaluateLorebooks, type LorebookGlobals } from './lorebook';

// Resolves which lorebooks are active for a prompt and loads their entries,
// mirroring SillyTavern's getSortedEntries (world-info.js:4363-4532):
//
// - Four pools: global (settings.lorebookIds), chat, persona, character.
// - A book attached to several pools loads once. ST's skip checks give the
//   precedence global > chat > persona > character (getChatLore skips global,
//   getPersonaLore skips chat+global, getCharacterLore skips all three).
// - Within a pool, entries sort descending by `order` (stable, so book order
//   breaks ties); pools concatenate chat, persona, then global/character
//   merged per the strategy setting (world_info_character_strategy).

export interface ActiveLoreOpts {
	character?: Character | null;
	chat?: Chat | null;
	persona?: Persona | null;
}

const byOrderDesc = (a: FlatLoreEntry, b: FlatLoreEntry) => b.entry.order - a.entry.order;

/** Keeps ids not already claimed by a higher-precedence pool. */
function claim(ids: number[] | undefined, seen: Set<number>): number[] {
	const out: number[] = [];
	for (const id of ids ?? []) {
		if (!Number.isFinite(id) || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * Loads every entry attached to the active pools, deduped and ordered like
 * SillyTavern. Returns [] when nothing is attached. Throws only on Dexie
 * failures — callers treat that as "no lorebooks" (ST logs and returns [] too).
 */
export async function resolveActiveEntries(opts: ActiveLoreOpts): Promise<FlatLoreEntry[]> {
	// Dedup precedence: global first, then chat, then persona, then character.
	const seen = new Set<number>();
	const globalIds = claim(settings.lorebookIds, seen);
	const chatIds = claim(opts.chat?.lorebookIds, seen);
	const personaIds = claim(opts.persona?.lorebookIds, seen);
	const charIds = claim(opts.character?.lorebookIds, seen);

	const allIds = [...globalIds, ...chatIds, ...personaIds, ...charIds];
	if (allIds.length === 0) return [];

	const [metas, rows] = await Promise.all([
		db.lorebooks.bulkGet([...new Set(allIds)]),
		db.lorebookEntries.where('lorebookId').anyOf(allIds).toArray()
	]);

	const names = new Map<number, string>();
	for (const m of metas) if (m?.id != null) names.set(m.id, m.name);
	const rowsByBook = new Map<number, LorebookEntry[]>();
	for (const row of rows) {
		const { lorebookId, ...entry } = row;
		const list = rowsByBook.get(lorebookId);
		if (list) list.push(entry);
		else rowsByBook.set(lorebookId, [entry]);
	}

	// Flatten one pool: its books' entries in pool order, stripping the row key.
	const flat = (ids: number[]): FlatLoreEntry[] => {
		const out: FlatLoreEntry[] = [];
		for (const id of ids) {
			const entries = rowsByBook.get(id);
			if (!entries) continue; // book metadata deleted → its rows are stale; skip
			const bookName = names.get(id) ?? `#${id}`;
			for (const entry of entries) out.push({ bookId: id, bookName, entry });
		}
		return out;
	};

	// Chat and persona pools always sort as a whole; the strategy only shapes
	// how global and character pools merge (world-info.js:4496-4513).
	const chatFlat = flat(chatIds).sort(byOrderDesc);
	const personaFlat = flat(personaIds).sort(byOrderDesc);
	const globalFlat = flat(globalIds);
	const charFlat = flat(charIds);

	let merged: FlatLoreEntry[];
	switch (settings.lorebookStrategy) {
		case 'character_first':
			merged = [...charFlat.sort(byOrderDesc), ...globalFlat.sort(byOrderDesc)];
			break;
		case 'global_first':
			merged = [...globalFlat.sort(byOrderDesc), ...charFlat.sort(byOrderDesc)];
			break;
		case 'evenly':
		default:
			// Concatenate global first, then one stable sort over both (ties keep
			// global ahead of character, matching ST's evenly behavior).
			merged = [...globalFlat, ...charFlat].sort(byOrderDesc);
			break;
	}

	return [...chatFlat, ...personaFlat, ...merged];
}

/**
 * Builds the injection payload for one generation: resolve pools → scan the
 * history → evaluate. Returns null when no books are attached or nothing
 * activated, so prompt assembly skips lore entirely on the cheap path.
 */
export async function buildLoreInjection(
	opts: ActiveLoreOpts & { history: ChatMessage[] }
): Promise<LorebookInjection | null> {
	try {
		const entries = await resolveActiveEntries(opts);
		if (entries.length === 0) return null;

		const globals: LorebookGlobals = {
			depth: settings.lorebookDepth ?? 2,
			includeNames: settings.lorebookIncludeNames ?? true,
			caseSensitive: settings.lorebookCaseSensitive ?? false,
			matchWholeWords: settings.lorebookMatchWholeWords ?? false,
			userName: opts.persona?.name ?? 'You',
			characterName: opts.character?.name ?? 'Character'
		};

		const injection = evaluateLorebooks(entries, buildScanMessages(opts.history, globals), globals);
		if (!injection.before && !injection.after && injection.atDepth.length === 0) return null;
		return injection;
	} catch (err) {
		// ST logs and continues with no world info (getSortedEntries catch);
		// a broken book must never stop generation.
		console.error('[LW] Lorebook evaluation failed; continuing without lore', err);
		return null;
	}
}
