// Global UI state that more than one component reads: the Studio drawer.
export type StudioTab = 'theme' | 'background' | 'layout' | 'cards' | 'advanced' | 'model';

export const ui = $state({
	studioOpen: false,
	studioTab: 'theme' as StudioTab
});

export function openStudio(tab?: StudioTab): void {
	if (tab) ui.studioTab = tab;
	ui.studioOpen = true;
}

export function closeStudio(): void {
	ui.studioOpen = false;
}
