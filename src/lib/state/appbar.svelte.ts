// Shared top-bar state. Pages call setAppbar() from an $effect to fill their
// part of the bar. The layout calls resetAppbar() before each navigation, so a
// page never shows the previous page's title, search or actions.
export interface BarAction {
	label: string;
	onclick: () => void;
}

export const appbar = $state({
	title: '',
	subtitle: '',
	avatar: '',
	search: false,
	query: '',
	actions: [] as BarAction[]
});

export function setAppbar(patch: Partial<Omit<typeof appbar, 'query'>>): void {
	Object.assign(appbar, patch);
}

export function resetAppbar(): void {
	appbar.title = '';
	appbar.subtitle = '';
	appbar.avatar = '';
	appbar.search = false;
	appbar.query = '';
	appbar.actions = [];
}
