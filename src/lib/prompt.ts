import type { Character, ChatMessage, LorebookInjection, Persona, PersonaPosition, Role } from './types';
import type { ApiMessage } from './llm';
import { settings } from './state/settings.svelte';

// Assembles the prompt sent to the LLM from a character card + chat history.
// This is the embryo of SillyTavern's "prompt manager": system(character) +
// lorebook buckets + optional persona block + history + in-chat injections.
// Phase 2 adds presets.
export function buildPromptMessages(
	character: Character,
	history: ChatMessage[],
	persona?: Persona | null,
	lore?: LorebookInjection | null
): ApiMessage[] {
	const system = [
		character.description,
		character.personality ? `Personality: ${character.personality}` : '',
		character.scenario ? `Scenario: ${character.scenario}` : ''
	]
		.filter(Boolean)
		.join('\n\n');

	const personaBlock = persona
		? [`[The human user is ${persona.name}.]`, persona.description].filter(Boolean).join('\n')
		: '';

	// Placement lives on the persona itself (persona-exclusive, like
	// SillyTavern's persona description position); settings only back-fill
	// personas saved before these fields existed. Invalid values (restored
	// from a hand-edited backup) fall back instead of dropping the persona.
	const rawPosition = persona?.position ?? settings.personaPosition;
	const position: PersonaPosition =
		rawPosition === 'none' ||
		rawPosition === 'system' ||
		rawPosition === 'top' ||
		rawPosition === 'bottom' ||
		rawPosition === 'depth'
			? rawPosition
			: 'system';

	const messages: ApiMessage[] = [];
	// Lorebook buckets: ST's "Before Char Defs" sits ahead of the character
	// card, "After Char Defs" follows it (positions 0/1; AN top/bottom 2/3
	// fold in for Phase 1). Both are system messages in ST's chat-completion
	// mapping (openai.js:1365-1368).
	if (lore?.before) messages.push({ role: 'system', content: lore.before });
	if (system) messages.push({ role: 'system', content: system });
	if (lore?.after) messages.push({ role: 'system', content: lore.after });

	if (personaBlock && position === 'system') {
		// A separate system message, so providers that emphasize system prompts
		// keep the user identity distinct from the character definition.
		messages.push({ role: 'system', content: personaBlock });
	} else if (personaBlock && position === 'top') {
		// Wrapped as an author's-note-style system message above the history
		messages.push({ role: 'system', content: `[Author's note: ${personaBlock}]` });
	}
	// 'bottom' lands after the history; 'depth' splices into it; 'none' skips.

	for (const m of history) {
		if (m.role === 'system') continue; // we never store system turns in history
		messages.push({ role: m.role, content: m.content });
	}

	// Lorebook in-chat @ depth (position 4). ST injects depth N immediately
	// before the Nth most recent message, depth 0 after the last one, and
	// within a slot lands assistant → user → system (openai.js:801-866 splices
	// roles system→user→assistant from the newest end, then reverses). Anchors
	// to the end of history so persona injections below don't shift depths.
	if (lore?.atDepth.length) {
		const historyEnd = messages.length;
		const historyStart = historyEnd - history.length; // clamps beyond-history depths
		// Blocks splice at descending indices (depth ascending), so each insert
		// sits below every earlier one and never moves its target.
		const roleRank: Record<Role, number> = { assistant: 0, user: 1, system: 2 };
		const byDepth = new Map<number, typeof lore.atDepth>();
		for (const group of lore.atDepth) {
			const key = Number.isFinite(group.depth) ? group.depth : 4;
			const bucket = byDepth.get(key);
			if (bucket) bucket.push(group);
			else byDepth.set(key, [group]);
		}
		for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
			const groups = byDepth.get(depth)!;
			groups.sort((a, b) => roleRank[a.role] - roleRank[b.role]);
			const d = Math.max(0, Math.min(9999, Math.floor(depth)));
			const target = Math.max(historyStart, historyEnd - d);
			messages.splice(target, 0, ...groups.map((g) => ({ role: g.role, content: g.content })));
		}
	}

	// Bottom of Author's Note: right after the last turn, so it is the
	// freshest instruction the model sees.
	if (personaBlock && position === 'bottom') {
		messages.push({ role: 'system', content: `[Author's note: ${personaBlock}]` });
	}

	// In-chat @ depth: insert the persona block N messages from the end,
	// with the configured role (SillyTavern depth injection).
	if (personaBlock && position === 'depth') {
		const rawDepth = persona?.depth ?? settings.personaDepth ?? 4;
		// Guard: a non-finite depth would splice the block at NaN (index 0).
		const depth = Number.isFinite(rawDepth)
			? Math.max(0, Math.min(9999, Math.floor(rawDepth)))
			: 4;
		const rawRole = persona?.depthRole ?? settings.personaDepthRole ?? 'system';
		const role = rawRole === 'user' || rawRole === 'assistant' ? rawRole : 'system';
		const insertAt = Math.max(1, messages.length - depth);
		messages.splice(insertAt, 0, { role, content: personaBlock });
	}
	return messages;
}
