import type { Character, ChatMessage, Persona } from './types';
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

	const messages: ApiMessage[] = [];
	if (system) messages.push({ role: 'system', content: system });

	if (personaBlock) {
		const position = settings.personaPosition ?? 'system';
		if (position === 'system') {
			// A separate system message, so providers that emphasize system prompts
			// keep the user identity distinct from the character definition.
			messages.push({ role: 'system', content: personaBlock });
		} else if (position === 'top' || position === 'bottom') {
			// Wrapped as an author's-note-style system message around the history
			const note = `[Author's note: ${personaBlock}]`;
			messages.push({
				role: 'system',
				content: position === 'top' ? note : ''
			});
			if (position === 'bottom') {
				messages.pop();
				messages.push({ role: 'system', content: historyNote(note, history) });
			}
		}
		// 'depth': injected in the loop below
	}

	for (const m of history) {
		if (m.role === 'system') continue; // we never store system turns in history
		messages.push({ role: m.role, content: m.content });
	}

	// In-chat @ depth: insert the persona block N messages from the end,
	// with the configured role (SillyTavern depth injection).
	if (personaBlock && settings.personaPosition === 'depth') {
		const depth = Math.max(0, settings.personaDepth ?? 4);
		const role = settings.personaDepthRole ?? 'system';
		const insertAt = Math.max(1, messages.length - depth);
		messages.splice(insertAt, 0, { role, content: personaBlock });
	}
	return messages;
}

// For 'bottom' position we do not have an author's note field yet, so the
// persona rides in a system message right before the last turn.
function historyNote(note: string, _history: ChatMessage[]): string {
	return note;
}
