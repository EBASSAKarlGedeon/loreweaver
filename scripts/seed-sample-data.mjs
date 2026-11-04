// Replaces the data in the headless browser profile with sample data, reloads
// the landing page, and saves a screenshot. Only run this against the throwaway
// profile from docs/TESTING.md: it clears characters, chats and messages.
//
// Usage: node scripts/seed-sample-data.mjs [screenshot-name]
import { connect, wait } from './cdp.mjs';

const name = process.argv[2] ?? 'landing-seeded';
const browser = await connect();

// Runs inside the page. Clears the three content stores, then adds sample rows.
const seed = `(async () => {
	const db = await new Promise((res, rej) => {
		// No version: Dexie already created the database (stored as version 10)
		const req = indexedDB.open('loreweaver');
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
	const stores = ['characters', 'chats', 'messages'];
	const clear = db.transaction(stores, 'readwrite');
	for (const s of stores) clear.objectStore(s).clear();
	await new Promise((res, rej) => { clear.oncomplete = res; clear.onerror = () => rej(clear.error); });

	const tx = db.transaction(stores, 'readwrite');
	const add = (store, row) => new Promise((res, rej) => {
		const r = tx.objectStore(store).add(row);
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const now = Date.now(), day = 86400000;
	const aria = await add('characters', { name: 'Aria Vale', description: 'A wandering archivist who keeps the last library of a drowned city.', personality: 'Curious, dry humor', scenario: 'A tide-lit ruin at dusk.', firstMessage: 'You found the stairs. Most people do not.', favorite: true, createdAt: now - 9 * day, updatedAt: now });
	const kael = await add('characters', { name: 'Kael Ashford', description: 'A mercenary with a debt to a dragon.', personality: 'Blunt, loyal', scenario: 'A border tavern.', firstMessage: 'Sit down. You look like trouble.', favorite: false, createdAt: now - 3 * day, updatedAt: now });
	await add('characters', { name: 'Mira Tessel', description: '', personality: 'Playful, sharp', scenario: '', firstMessage: 'Hello there!', favorite: true, createdAt: now - day, updatedAt: now });
	const ariaChat = await add('chats', { characterId: aria, title: 'Aria Vale', createdAt: now, updatedAt: now - 20 * 60000 });
	const kaelChat = await add('chats', { characterId: kael, title: 'Kael Ashford', createdAt: now, updatedAt: now - 3 * day });
	await add('messages', { chatId: ariaChat, role: 'assistant', content: 'The lamps still burn in the reading room. Shall we go down together?', createdAt: now });
	await add('messages', { chatId: kaelChat, role: 'assistant', content: '*Kael lifts a tankard* The usual? Or something stronger?', createdAt: now });
	await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
	db.close();
	return 'seeded 3 characters and 2 chats';
})()`;

console.log(await browser.evaluate(seed));
await browser.send('Page.reload', { ignoreCache: true });
await wait(2500); // liveQuery emits after the reload
console.log(`screenshot: ${await browser.screenshot(name)}`);
browser.close();
