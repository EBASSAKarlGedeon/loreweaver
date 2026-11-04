// Live view of the local library for the landing page.
// Dexie's liveQuery re-runs these queries whenever characters, chats or
// messages change, so the page updates without polling or manual refreshes.
import { liveQuery } from 'dexie';
import { db } from '../db';
import type { Character, Chat, ChatMessage } from '../types';

export interface ChatEntry {
	chat: Chat;
	character: Character;
	lastMessage: ChatMessage | undefined;
	messageCount: number;
}

export const library = $state({
	ready: false,
	characters: [] as Character[],
	// Newest activity first. Chats whose character was deleted are left out.
	entries: [] as ChatEntry[]
});

// Start watching the database. Returns the cleanup function for $effect.
export function startLibrary(): () => void {
	const sub = liveQuery(async () => {
		const [characters, chats] = await Promise.all([db.characters.toArray(), db.chats.toArray()]);
		const byId = new Map<number, Character>();
		for (const c of characters) if (c.id != null) byId.set(c.id, c);

		const entries: ChatEntry[] = [];
		for (const chat of chats) {
			const character = byId.get(chat.characterId);
			if (!character || chat.id == null) continue;
			const [lastMessage, messageCount] = await Promise.all([
				db.messages.where('chatId').equals(chat.id).last(),
				db.messages.where('chatId').equals(chat.id).count()
			]);
			entries.push({ chat, character, lastMessage, messageCount });
		}
		entries.sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
		return { characters, entries };
	}).subscribe({
		next: (value) => {
			library.characters = value.characters;
			library.entries = value.entries;
			library.ready = true;
		},
		error: (err) => console.error('Library query failed', err)
	});
	return () => sub.unsubscribe();
}
