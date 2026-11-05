import type { Character, ChatMessage, Persona, PersonaPosition } from './types';
import type { ApiMessage } from './llm';
import { settings } from './state/settings.svelte';

// Assembles the prompt sent to the LLM from a character card + chat history.
// This is the embryo of SillyTavern's "prompt manager": for now it's
// system(character) + optional persona block + history. Phase 2 adds
// lorebooks, presets.
export function buildPromptMessages(
	character: Character,
	history: ChatMessage[],
	persona?: Persona | null
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
	if (system) messages.push({ role: 'system', content: system });

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
