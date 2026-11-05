import { db } from '../db';
import type { Appearance, Settings } from '../types';

export const DEFAULT_APPEARANCE: Appearance = {
	theme: 'obsidian',
	accentColor: null,
	accent2Color: null,
	bgColor: null,
	bgMode: 'gradient',
	bgImageUrl: '',
	bgFit: 'cover',
	overlayOpacity: 85,
	ambient: true,
	blur: 12,
	cardStyle: 'glass',
	radius: 14,
	glow: true,
	animations: true,
	font: 'luxury',
	fontScale: 100,
	density: 'comfortable',
	sectionOrder: 'chats-first',
	cardHeight: 260,
	cardMinWidth: 230,
	chatCardWidth: 340,
	chatsShown: 8,
	defaultSort: 'newest',
	showHero: true,
	heroTitle: '',
	showStats: true,
	showDescription: true,
	showChatCount: true,
	customCss: ''
};

const DEFAULT: Settings = {
	id: 1,
	apiKey: '',
	baseUrl: 'https://api.openai.com/v1',
	model: 'gpt-4o-mini',
	defaultPersonaId: undefined,
	personaPosition: 'system',
	personaDepth: 4,
	personaDepthRole: 'system',
	personaAutoLock: true,
	personaAllowMulti: false,
	personaNotifications: true,
	appearance: { ...DEFAULT_APPEARANCE }
};

// Singleton settings, reactive via Svelte 5 runes. Reading `settings.apiKey`
// in a component is reactive; mutate with saveSettings() so it also persists.
export const settings = $state<Settings>(structuredClone(DEFAULT));

let loaded = false;

export async function loadSettings(): Promise<void> {
	if (loaded) return;
	const existing = await db.settings.get(1);
	if (existing) {
		Object.assign(settings, existing);
		// Rows saved before the landing page existed have no appearance block
		settings.appearance = { ...DEFAULT_APPEARANCE, ...existing.appearance };
	} else {
		await db.settings.put(structuredClone(DEFAULT));
	}
	// Rows saved before personas existed have no persona settings
	if (settings.personaPosition == null) settings.personaPosition = DEFAULT.personaPosition;
	if (settings.personaDepth == null) settings.personaDepth = DEFAULT.personaDepth;
	if (settings.personaDepthRole == null) settings.personaDepthRole = DEFAULT.personaDepthRole;
	loaded = true;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
	Object.assign(settings, patch);
	// $state.snapshot strips the Svelte proxies; IndexedDB can't store them
	await db.settings.put({ ...$state.snapshot(settings), id: 1 });
}

// Appearance changes happen on every slider tick, so the UI updates
// immediately and the database write is debounced.
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function updateAppearance(patch: Partial<Appearance>): void {
	Object.assign(settings.appearance, patch);
	clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		saveSettings({}).catch((err) => console.error('Failed to save appearance', err));
	}, 250);
}
