<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { loadSettings, settings } from '$lib/state/settings.svelte';
	import { rootClasses, themeVars } from '$lib/landing/appearance';
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

	// The landing page (/) draws its own full-screen top bar, so the app nav is
	// only shown on the other routes.
	let isHome = $derived($page.url.pathname === '/');

	// IndexedDB only exists in the browser. onMount never runs during SSR, so
	// the Dexie call here can't reject inside Node.
	onMount(() => {
		loadSettings().catch((err) => console.error('Failed to load settings', err));
	});
</script>

{#if isHome}
	{@render children()}
{:else}
	<div class="app">
		<nav class="nav">
			<div class="brand">Lore<span class="dot">Weaver</span></div>
			<a href="/" class:active={$page.url.pathname === '/'}>Home</a>
			<a href="/characters" class:active={$page.url.pathname.startsWith('/characters')}>Characters</a>
			<a href="/settings" class:active={$page.url.pathname.startsWith('/settings')}>Settings</a>
		</nav>
		<div class="main">
			{@render children()}
		</div>
	</div>
{/if}
