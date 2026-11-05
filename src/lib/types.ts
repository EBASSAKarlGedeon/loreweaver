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
	tags?: string[]; // free-form labels, filterable on the Characters page
	favorite?: boolean; // pinned to the "Favorites" filter on the landing page
	lorebookIds?: number[]; // lorebooks active for chats with this character (ST character lore)
	createdAt: number;
	updatedAt: number;
}

// The user's own character in the story (SillyTavern "persona").
// The active one is injected into every prompt so the model knows who it
// is talking to and can address the user by name.
export interface Persona {
	id?: number;
	name: string;
	description: string; // who the user is in the fiction
	avatar?: string; // optional image (URL or data URL)
	// Locks (SillyTavern connections): the persona pinned for...
	lockToCharacterId?: number; // ...every new chat with this character
	// Per-persona prompt placement (SillyTavern stores position/depth/role on
	// the persona, not globally). Older rows without these fields fall back to
	// the settings.persona* values.
	position?: PersonaPosition;
	depth?: number;
	depthRole?: 'system' | 'user' | 'assistant';
	lorebookIds?: number[]; // lorebooks scanned while this persona is active (ST persona lorebook)
	createdAt: number;
	updatedAt: number;
}

// Where the persona description goes in the prompt (SillyTavern position).
export type PersonaPosition = 'none' | 'system' | 'top' | 'bottom' | 'depth';

export interface Chat {
	id?: number;
	characterId: number;
	personaId?: number; // persona in use when the chat started/last switched; empty = none
	lorebookIds?: number[]; // lorebooks pinned to this chat (ST chat lorebook)
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
	bgFit: 'cover' | 'contain' | 'fill' | 'center';
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
	defaultPersonaId?: number; // persona stamped on new chats; empty = none
	personaPosition: PersonaPosition; // where the persona description goes in the prompt
	personaDepth: number; // messages from the end, when position = 'depth'
	personaDepthRole: 'system' | 'user' | 'assistant'; // role of the depth message
	personaAutoLock: boolean; // picking a persona locks it to the chat
	personaAllowMulti: boolean; // multiple persona locks per character
	personaNotifications: boolean; // toast when the persona switches
	// Lorebooks (ST World Info) — see the lorebook section below
	lorebookIds: number[]; // globally active lorebooks (ST selected_world_info)
	lorebookStrategy: LorebookStrategy; // how character books merge with global books
	lorebookDepth: number; // messages scanned, newest back (ST world_info_depth)
	lorebookIncludeNames: boolean; // prefix scan text with "Name: " (ST world_info_include_names)
	lorebookCaseSensitive: boolean; // global default (entries may override with null)
	lorebookMatchWholeWords: boolean; // global default (entries may override with null)
	appearance: Appearance;
}

// ============================================================================
// Lorebooks (SillyTavern "World Info")
// ============================================================================
// Lorebook entries are keyword-matched against recent chat history and injected
// into the prompt. The field set mirrors SillyTavern 1.18.0 exactly
// (reference/SillyTavern-1.18.0/public/scripts/world-info.js,
// newWorldInfoEntryDefinition:4002-4045), including fields only Phase 2
// evaluates (recursion, sticky/cooldown/delay, groups, budget) — storing them
// now keeps imports lossless and avoids a later migration.

// ST world_info_logic — secondary-key ("selective") logic codes (WI:33-38).
export const WI_LOGIC = {
	/** any secondary key matches */
	AND_ANY: 0,
	/** at least one secondary key does NOT match */
	NOT_ALL: 1,
	/** no secondary key matches */
	NOT_ANY: 2,
	/** all secondary keys match */
	AND_ALL: 3
} as const;
export type WiLogic = (typeof WI_LOGIC)[keyof typeof WI_LOGIC];

// ST world_info_position (WI:855-864).
export const WI_POSITION = {
	/** before character definitions */
	BEFORE: 0,
	/** after character definitions */
	AFTER: 1,
	/** before the author's note — folded into BEFORE in Phase 1 */
	AN_TOP: 2,
	/** after the author's note — folded into AFTER in Phase 1 */
	AN_BOTTOM: 3,
	/** in-chat at depth (entry.depth + entry.role), spliced into history */
	AT_DEPTH: 4,
	/** before example messages — Phase 2 */
	EM_TOP: 5,
	/** after example messages — Phase 2 */
	EM_BOTTOM: 6,
	/** consumed on demand by the {{outlet::name}} macro — Phase 2 */
	OUTLET: 7
} as const;
export type WiPosition = (typeof WI_POSITION)[keyof typeof WI_POSITION];

/** Which import format a lorebook came from (native = SillyTavern JSON map form). */
export type LorebookSourceFormat = 'native' | 'novelai' | 'agnai' | 'risu' | 'character_book';

/** ST world_info_character_strategy: how character books merge with global books (WI:27-31). */
export type LorebookStrategy = 'evenly' | 'character_first' | 'global_first';

export interface LorebookEntry {
	uid: number; // unique within its book; compound DB key with lorebookId
	key: string[]; // primary keywords; each may be a regex literal /pattern/flags
	keysecondary: string[]; // secondary keywords, evaluated via selectiveLogic
	comment: string; // memo/title shown in ST's editor (UI only)
	content: string; // the text injected when the entry activates
	constant: boolean; // always activates (still passes the probability roll)
	vectorized: boolean; // ST vector-storage extension flag; no evaluation effect
	selective: boolean; // secondary-key gate: false = activate on the primary match alone (WI:4812)
	selectiveLogic: number; // WI_LOGIC value; only consulted when keysecondary is non-empty
	addMemo: boolean; // ST editor flag: show comment inline
	order: number; // priority: processed descending, injected ascending (default 100)
	position: number; // WI_POSITION value
	disable: boolean; // disabled entries are skipped entirely
	ignoreBudget: boolean; // exempt from budget trimming (Phase 2)
	excludeRecursion: boolean; // not scanned during recursion passes (Phase 2)
	preventRecursion: boolean; // activates, but its content feeds no recursion (Phase 2)
	matchPersonaDescription: boolean; // add persona text to this entry's scan source (Phase 2)
	matchCharacterDescription: boolean; // ditto character description (Phase 2)
	matchCharacterPersonality: boolean; // ditto personality (Phase 2)
	matchCharacterDepthPrompt: boolean; // ditto depth prompt (Phase 2)
	matchScenario: boolean; // ditto scenario (Phase 2)
	matchCreatorNotes: boolean; // ditto creator notes (Phase 2)
	delayUntilRecursion: number; // only activates in recursion pass ≥ N (Phase 2)
	probability: number; // activation chance percent (0-100)
	useProbability: boolean; // false = never roll, always attempt
	depth: number; // messages from the end, when position = AT_DEPTH (ST DEFAULT_DEPTH 4)
	outletName: string; // outlet key for position = OUTLET (Phase 2)
	group: string; // inclusion group names, comma-separated (Phase 2)
	groupOverride: boolean; // highest order wins its group (Phase 2)
	groupWeight: number; // weighted-random weight within its group (Phase 2)
	scanDepth: number | null; // per-entry scan depth; null = use settings.lorebookDepth
	caseSensitive: boolean | null; // per-entry override; null = settings.lorebookCaseSensitive
	matchWholeWords: boolean | null; // per-entry override; null = settings.lorebookMatchWholeWords
	useGroupScoring: boolean | null; // per-entry override for group scoring (Phase 2)
	automationId: string; // ST automation hook id; no evaluation effect
	role: number; // 0 system | 1 user | 2 assistant, only when position = AT_DEPTH
	sticky: number | null; // stays active N messages after activation (Phase 2)
	cooldown: number | null; // blocks re-activation N messages after (Phase 2)
	delay: number | null; // suppressed until the chat has N messages (Phase 2)
	triggers: string[]; // restrict to generation types (Phase 2)
	characterFilter: { isExclude: boolean; names: string[]; tags: string[] }; // (Phase 2)
	displayIndex?: number; // editor ordering only; ST defaults it to uid
}

/** One lorebook row: metadata only; entries live in their own table. */
export interface Lorebook {
	id?: number;
	name: string;
	entryCount: number;
	sourceFormat: LorebookSourceFormat;
	/** raw pre-conversion source (e.g. an imported V2 character_book), kept
	 *  for lossless export — ST's data.originalData */
	originalData?: unknown;
	createdAt: number;
	updatedAt: number;
}

/** An entry row in the lorebookEntries table; compound primary key [lorebookId+uid]. */
export interface LorebookEntryRow extends LorebookEntry {
	lorebookId: number;
}

/** An entry paired with its book — the unit the evaluator consumes. */
export interface FlatLoreEntry {
	bookId: number;
	bookName: string;
	entry: LorebookEntry;
}

/** Position-AT_DEPTH output: one (depth, role) bucket, contents joined with \n. */
export interface LorebookAtDepthGroup {
	depth: number;
	role: Role;
	content: string;
}

/** What the evaluator produces and buildPromptMessages injects (Phase 1 positions). */
export interface LorebookInjection {
	/** positions BEFORE (+AN_TOP) — joined with \n, ascending order; '' when empty */
	before: string;
	/** positions AFTER (+AN_BOTTOM) — joined with \n, ascending order; '' when empty */
	after: string;
	/** position AT_DEPTH buckets */
	atDepth: LorebookAtDepthGroup[];
	/** every entry that activated, for tests and diagnostics */
	activated: { bookId: number; uid: number }[];
}
