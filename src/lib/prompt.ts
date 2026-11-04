import type { Character, ChatMessage } from './types';
import type { ApiMessage } from './llm';

// Assembles the prompt sent to the LLM from a character card + chat history.
// This is the embryo of SillyTavern's "prompt manager": for now it's
// system(character) + history. Phase 2 adds personas, lorebooks, presets.
export function buildPromptMessages(character: Character, history: ChatMessage[]): ApiMessage[] {
	const system = [
		character.description,
		character.personality ? `Personality: ${character.personality}` : '',
		character.scenario ? `Scenario: ${character.scenario}` : ''
	]
		.filter(Boolean)
		.join('\n\n');

	const messages: ApiMessage[] = [];
	if (system) messages.push({ role: 'system', content: system });

	for (const m of history) {
		if (m.role === 'system') continue; // we never store system turns in history
		messages.push({ role: m.role, content: m.content });
	}
	return messages;
}
