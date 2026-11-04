// Core domain types for LoreWeaver.
// These mirror SillyTavern's "character card" concept, kept minimal for the MVP.

export interface Character {
	id?: number;
	name: string;
	description: string; // who this character is — goes into the system prompt
	personality: string; // how they behave / speak
	scenario: string; // the setting / starting situation
	firstMessage: string; // the opening assistant turn when a chat begins
	createdAt: number;
	updatedAt: number;
}

export interface Chat {
	id?: number;
	characterId: number;
	title: string;
	createdAt: number;
	updatedAt: number;
}

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
	id?: number;
	chatId: number;
	role: Role;
	content: string;
	createdAt: number;
}

// A single settings row, keyed by id=1 (singleton).
export interface Settings {
	id: 1;
	apiKey: string;
	baseUrl: string; // OpenAI-compatible base, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
	model: string; // e.g. gpt-4o-mini, or a local model name
}
