// Global UI state that more than one component reads: the Studio drawer.
export type StudioTab = 'theme' | 'background' | 'layout' | 'cards' | 'advanced';

// What a chat page contributes to the global PersonaManager overlay:
// which persona is active and where switching is stamped. Null outside a chat.
export type PersonaContext = {
	characterId?: number;
	activeId?: number;
	onselect: (id: number | undefined) => void;
};

export const ui = $state({
	studioOpen: false,
	paletteOpen: false,
	modelOpen: false,
	personaOpen: false,
	personaContext: null as PersonaContext | null,
	studioTab: 'theme' as StudioTab
});

export function openStudio(tab?: StudioTab): void {
	if (tab) ui.studioTab = tab;
	ui.studioOpen = true;
}

export function openModel(): void {
	ui.modelOpen = true;
}

export function openPersona(): void {
	ui.personaOpen = true;
}

export function closePersona(): void {
	ui.personaOpen = false;
}

export function setPersonaContext(ctx: PersonaContext | null): void {
	ui.personaContext = ctx;
}

export function closeModel(): void {
	ui.modelOpen = false;
}

export function closeStudio(): void {
	ui.studioOpen = false;
}

// Command palette (Ctrl/Cmd+K). Its handler lives in CommandPalette.svelte.
export function openPalette(): void {
	ui.paletteOpen = true;
}

export function closePalette(): void {
	ui.paletteOpen = false;
}
