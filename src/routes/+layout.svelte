<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { loadSettings } from '$lib/state/settings.svelte';
	import '../styles/tailwind.css';
	import '../app.css';

	let { children } = $props();

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
