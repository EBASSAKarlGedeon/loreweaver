import Dexie, { type Table } from 'dexie';
import type { Character, Chat, ChatMessage, Persona, Settings } from './types';

// IndexedDB-backed local store. This is the offline-first foundation: everything
// you create (characters, chats, settings) lives in the browser and survives
// reloads. Phase 3 will sync these tables to your personal server.
export class LoreDB extends Dexie {
	characters!: Table<Character, number>;
	personas!: Table<Persona, number>;
	chats!: Table<Chat, number>;
	messages!: Table<ChatMessage, number>;
	settings!: Table<Settings, number>;

	constructor() {
		super('loreweaver');
		this.version(1).stores({
			characters: '++id, name, updatedAt',
			chats: '++id, characterId, updatedAt',
			messages: '++id, chatId, createdAt',
			settings: 'id'
		});
		// v2: personas table. v3 indexes lockToCharacterId for lookups.
		this.version(2).stores({
			characters: '++id, name, updatedAt',
			personas: '++id, name, updatedAt',
			chats: '++id, characterId, updatedAt',
			messages: '++id, chatId, createdAt',
			settings: 'id'
		});
		this.version(3).stores({
			characters: '++id, name, updatedAt',
			personas: '++id, name, updatedAt, lockToCharacterId',
			chats: '++id, characterId, updatedAt',
			messages: '++id, chatId, createdAt',
			settings: 'id'
		});
	}
}

export const db = new LoreDB();
