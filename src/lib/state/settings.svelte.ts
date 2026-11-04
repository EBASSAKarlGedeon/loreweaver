import { db } from '../db';
import type { Settings } from '../types';

const DEFAULT: Settings = {
	id: 1,
	apiKey: '',
	baseUrl: 'https://api.openai.com/v1',
	model: 'gpt-4o-mini'
};

// Singleton settings, reactive via Svelte 5 runes. Reading `settings.apiKey`
// in a component is reactive; mutate with saveSettings() so it also persists.
export const settings = $state<Settings>({ ...DEFAULT });

let loaded = false;

export async function loadSettings(): Promise<void> {
	if (loaded) return;
	const existing = await db.settings.get(1);
	if (existing) {
		Object.assign(settings, existing);
	} else {
		await db.settings.put({ ...DEFAULT });
	}
	loaded = true;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
	Object.assign(settings, patch);
	await db.settings.put({ ...settings, id: 1 });
}
