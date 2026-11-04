// Core domain types for LoreWeaver.
// These mirror SillyTavern's "character card" concept, kept minimal for the MVP.

export interface Character {
	id?: number;
	name: string;
	description: string; // who this character is — goes into the system prompt
	personality: string; // how they behave / speak
	scenario: string; // the setting / starting situation
	firstMessage: string; // the opening assistant turn when a chat begins
	model?: string; // optional per-character model; empty uses the default model in Studio
	image?: string; // optional portrait (URL or data URL) shown on landing cards
	favorite?: boolean; // pinned to the "Favorites" filter on the landing page
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

// Visual settings for the landing page. Stored inside the settings row.
export interface Appearance {
	// Colors
	theme: string; // preset id, see THEMES in $lib/landing/appearance
	accentColor: string | null; // null = use the preset's
	accent2Color: string | null;
	bgColor: string | null;
	// Background
	bgMode: 'gradient' | 'solid' | 'image';
	bgImageUrl: string;
	overlayOpacity: number; // 0–100
	ambient: boolean; // drifting glow orbs
	blur: number; // glass blur, px
	// Surfaces
	cardStyle: 'glass' | 'solid' | 'outline' | 'neon';
	radius: number; // px
	glow: boolean; // accent glow on hover
	animations: boolean;
	// Typography
	font: 'luxury' | 'system' | 'serif' | 'rounded' | 'mono';
	fontScale: number; // %
	// Layout
	density: 'compact' | 'comfortable' | 'spacious';
	sectionOrder: 'chats-first' | 'characters-first';
	cardHeight: number; // character art height, px
	cardMinWidth: number; // character card min width, px
	chatCardWidth: number; // px
	chatsShown: number; // chats in the "My Chats" carousel
	defaultSort: 'newest' | 'oldest' | 'name';
	// Header
	showHero: boolean;
	heroTitle: string; // empty = time-based greeting
	showStats: boolean;
	// Character card details
	showDescription: boolean;
	showChatCount: boolean;
	// Advanced
	customCss: string;
}

// A single settings row, keyed by id=1 (singleton).
export interface Settings {
	id: 1;
	apiKey: string;
	baseUrl: string; // OpenAI-compatible base, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
	model: string; // e.g. gpt-4o-mini, or a local model name
	appearance: Appearance;
}
