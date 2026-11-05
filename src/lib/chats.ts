import { db } from './db';
import type { Character } from './types';

// Creates a new chat for a character and materializes its first message.
// Returns the new chat id. The starting persona is resolved from the
// character lock first, then the global default: persona.lockToCharacterId
// beats settings.defaultPersonaId (SillyTavern connection priority).
export async function createChat(character: Character, defaultPersonaId?: number): Promise<number> {
	if (character.id == null) throw new Error('Character has no id');
	const now = Date.now();
	let personaId = defaultPersonaId;
	const locked = await db.personas.where('lockToCharacterId').equals(character.id).first();
	if (locked) personaId = locked.id;
	return db.transaction('rw', [db.chats, db.messages], async () => {
		const chatId = await db.chats.add({
			characterId: character.id!,
			personaId,
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
