<script lang="ts">
	import { page } from '$app/stores';
	import { loadSettings } from '$lib/state/settings.svelte';
	import '../app.css';

	let { children } = $props();

	loadSettings();
</script>

<div class="app">
	<nav class="nav">
		<div class="brand">Lore<span class="dot">Weaver</span></div>
		<a href="/" class:active={$page.url.pathname === '/'}>Chat</a>
		<a href="/characters" class:active={$page.url.pathname.startsWith('/characters')}>Characters</a>
		<a href="/settings" class:active={$page.url.pathname.startsWith('/settings')}>Settings</a>
	</nav>
	<div class="main">
		{@render children()}
	</div>
</div>
