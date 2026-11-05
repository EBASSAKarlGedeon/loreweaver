import type { Character, ChatMessage, Persona } from './types';
import type { ApiMessage } from './llm';

// Assembles the prompt sent to the LLM from a character card + chat history.
// This is the embryo of SillyTavern's "prompt manager": for now it's
// system(character) + optional system(persona) + history. Phase 2 adds
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
	// A separate system message, so providers that emphasize system prompts
	// keep the user identity distinct from the character definition.
	if (personaBlock) messages.push({ role: 'system', content: personaBlock });

	for (const m of history) {
		if (m.role === 'system') continue; // we never store system turns in history
		messages.push({ role: m.role, content: m.content });
	}
	return messages;
}
