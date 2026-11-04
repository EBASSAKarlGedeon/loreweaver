import { db } from './db';
import type { Character } from './types';

// Creates a new chat for a character and materializes its first message.
// Returns the new chat id.
export async function createChat(character: Character): Promise<number> {
	if (character.id == null) throw new Error('Character has no id');
	const now = Date.now();
	return db.transaction('rw', [db.chats, db.messages], async () => {
		const chatId = await db.chats.add({
			characterId: character.id!,
			title: character.name,
			createdAt: now,
			updatedAt: now
		});
		if (character.firstMessage) {
			await db.messages.add({
				chatId,
				role: 'assistant',
				content: character.firstMessage,
				createdAt: now
			});
		}
		return chatId;
	});
}
