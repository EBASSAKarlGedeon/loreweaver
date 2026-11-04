<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { loadSettings, settings } from '$lib/state/settings.svelte';
	import { resetAppbar } from '$lib/state/appbar.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { rootClasses, themeVars } from '$lib/landing/appearance';
	import AppBar from '$lib/ui/AppBar.svelte';
	import Studio from '$lib/ui/Studio.svelte';
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/manrope';
	import '../styles/tailwind.css';
	import '../app.css';

	let { children } = $props();

	// Theme variables and root classes live on <html> so every route shares them.
	// The resolved values are cached in localStorage so app.html can apply them
	// before first paint (see the inline script there). The cache is optional.
	$effect(() => {
		const a = settings.appearance;
		const vars = themeVars(a);
		const classes = rootClasses(a).split(' ').filter(Boolean);
		const root = document.documentElement;
		for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
		for (const c of [...root.classList]) if (c.startsWith('stlp-')) root.classList.remove(c);
		root.classList.add(...classes);
		try {
			localStorage.setItem('lw-theme', JSON.stringify({ vars, classes }));
		} catch {
			// Storage can be full or blocked. The app works without the cache.
		}
	});

	// Each page fills the bar in its own $effect, so clear the previous page's
	// contribution before navigating.
	beforeNavigate(() => resetAppbar());

	// IndexedDB only exists in the browser. onMount never runs during SSR, so
	// the Dexie call here can't reject inside Node.
	onMount(() => {
		loadSettings().catch((err) => console.error('Failed to load settings', err));
	});
</script>

<div class="flex h-dvh flex-col">
	<AppBar />
	<main class="min-h-0 flex-1 overflow-y-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
		{@render children()}
	</main>
</div>

{#if ui.studioOpen}
	<Studio />
{/if}
