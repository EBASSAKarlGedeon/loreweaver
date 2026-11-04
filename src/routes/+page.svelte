<script lang="ts">
	import { goto } from '$app/navigation';
	import { db } from '$lib/db';
	import Icon from '$lib/landing/Icon.svelte';
	import ChatCard from '$lib/landing/ChatCard.svelte';
	import CharacterCard from '$lib/landing/CharacterCard.svelte';
	import CharacterDetails from '$lib/landing/CharacterDetails.svelte';
	import AllChatsModal from '$lib/landing/AllChatsModal.svelte';
	import AppearancePanel from '$lib/landing/AppearancePanel.svelte';
	import { library, startLibrary, type ChatEntry } from '$lib/landing/library.svelte';
	import { rootClasses, themeStyle } from '$lib/landing/appearance';
	import { greeting, plural } from '$lib/landing/format';
	import { settings } from '$lib/state/settings.svelte';
	import type { Character } from '$lib/types';
	import '$lib/landing/landing.css';

	type Sort = 'newest' | 'oldest' | 'name';
	const PAGE_SIZE = 24;
	const SORTS: { id: Sort; label: string }[] = [
		{ id: 'newest', label: 'Newest first' },
		{ id: 'oldest', label: 'Oldest first' },
		{ id: 'name', label: 'Name (A–Z)' }
	];

	let a = $derived(settings.appearance);

	// Ephemeral UI state (not persisted)
	let query = $state('');
	let favoritesOnly = $state(false);
	let sortOverride = $state<Sort | null>(null);
	let shown = $state(PAGE_SIZE);
	let openCharacter = $state<Character | null>(null);
	let showAllChats = $state(false);
	let showAppearance = $state(false);

	$effect(() => startLibrary());

	// Custom CSS from the Appearance panel. Recreated when it changes.
	$effect(() => {
		const style = document.createElement('style');
		style.textContent = a.customCss;
		document.head.appendChild(style);
		return () => style.remove();
	});

	let sort: Sort = $derived(sortOverride ?? a.defaultSort);

	// Every entry here has a character: orphaned chats are dropped in the store
	let entries = $derived(library.entries);
	let recent = $derived(entries.slice(0, a.chatsShown));
	let latest: ChatEntry | undefined = $derived(entries[0]);

	let chatCounts = $derived.by(() => {
		const counts = new Map<number, number>();
		for (const e of entries) counts.set(e.character.id!, (counts.get(e.character.id!) ?? 0) + 1);
		return counts;
	});
	let latestByCharacter = $derived.by(() => {
		const map = new Map<number, ChatEntry>();
		for (const e of entries) if (!map.has(e.character.id!)) map.set(e.character.id!, e);
		return map;
	});

	let filtered = $derived.by(() => {
		let list = library.characters;
		if (favoritesOnly) list = list.filter((c) => c.favorite);
		const q = query.trim().toLowerCase();
		if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
		const copy = [...list];
		switch (sort) {
			case 'oldest':
				return copy.sort((x, y) => x.createdAt - y.createdAt);
			case 'name':
				return copy.sort((x, y) => x.name.localeCompare(y.name));
			default:
				return copy.sort((x, y) => y.createdAt - x.createdAt);
		}
	});
	let visibleCharacters = $derived(filtered.slice(0, shown));
	let favoriteCount = $derived(library.characters.filter((c) => c.favorite).length);

	function openChat(entry: ChatEntry) {
		if (entry.chat.id != null) goto(`/chat/${entry.chat.id}`);
	}

	async function toggleFavorite(c: Character) {
		if (c.id == null) return;
		await db.characters.update(c.id, { favorite: !c.favorite });
	}

	function setQuery(value: string) {
		query = value;
		shown = PAGE_SIZE;
	}

	function onWindowKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			// While "View all" is open, Ctrl+K targets its filter instead
			const target = showAllChats
				? document.querySelector<HTMLInputElement>('.stlp-modal-search')
				: document.querySelector<HTMLInputElement>('.stlp-search');
			target?.focus();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="landing {rootClasses(a)}" style={themeStyle(a)}>
	<div class="stlp-bg-overlay"></div>
	<div class="stlp-ambient" aria-hidden="true">
		<span class="stlp-orb stlp-orb-1"></span>
		<span class="stlp-orb stlp-orb-2"></span>
		<span class="stlp-orb stlp-orb-3"></span>
	</div>

	<div class="stlp-page">
		<header class="stlp-topbar">
			<div class="stlp-brand" title="LoreWeaver">
				<span class="stlp-brand-mark"></span>
			</div>
			<div class="stlp-search-wrap">
				<Icon name="search" class="stlp-search-icon" />
				<input
					class="stlp-search"
					type="text"
					placeholder="Search characters... (Ctrl+K)"
					autocomplete="off"
					value={query}
					oninput={(e) => setQuery(e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Escape') e.currentTarget.blur();
					}}
				/>
			</div>
			<div class="stlp-topbar-actions">
				<a class="stlp-icon-btn" href="/characters" title="Create or edit characters">
					<Icon name="userPlus" />
				</a>
				<a class="stlp-icon-btn" href="/settings" title="Connection settings">
					<Icon name="sliders" />
				</a>
				<button class="stlp-icon-btn stlp-settings-btn" type="button" title="Appearance" onclick={() => (showAppearance = true)}>
					<Icon name="gear" />
				</button>
			</div>
		</header>

		<main class="stlp-content">
			{#if a.showHero}
				<section class="stlp-section stlp-hero">
					<div class="stlp-hero-text">
						<h1 class="stlp-hero-title">{a.heroTitle.trim() || greeting()}</h1>
						<p class="stlp-hero-sub">Pick up where you left off, or meet someone new.</p>
					</div>
					<div class="stlp-hero-side">
						{#if a.showStats}
							<div class="stlp-stats">
								<div class="stlp-stat">
									<span class="stlp-stat-icon"><Icon name="users" /></span>
									<span class="stlp-stat-value">{library.characters.length}</span>
									<span class="stlp-stat-label">characters</span>
								</div>
								<div class="stlp-stat">
									<span class="stlp-stat-icon"><Icon name="chat" /></span>
									<span class="stlp-stat-value">{entries.length}</span>
									<span class="stlp-stat-label">chats</span>
								</div>
								<div class="stlp-stat">
									<span class="stlp-stat-icon"><Icon name="heart" /></span>
									<span class="stlp-stat-value">{favoriteCount}</span>
									<span class="stlp-stat-label">favorites</span>
								</div>
							</div>
						{/if}
						{#if latest}
							{@const first = latest}
							<button class="stlp-btn-primary stlp-hero-continue" type="button" onclick={() => openChat(first)}>
								<Icon name="play" />
								<span>Continue with <b>{first.character.name}</b></span>
							</button>
						{/if}
					</div>
				</section>
			{/if}

			<section class="stlp-section stlp-section-chats">
				<h2 class="stlp-section-title">
					<span class="stlp-section-icon"><Icon name="chat" /></span>
					My Chats
				</h2>
				<div class="stlp-chat-list">
					{#if !library.ready}
						<div class="stlp-placeholder">Loading chats…</div>
					{:else if entries.length === 0}
						<div class="stlp-placeholder">No chats yet. Start one from the Characters section below.</div>
					{:else}
						{#each recent as entry, i (entry.chat.id)}
							<ChatCard {entry} index={i} onopen={openChat} />
						{/each}
						{#if entries.length > a.chatsShown}
							<button class="stlp-chat-more" type="button" onclick={() => (showAllChats = true)}>
								View all ({entries.length})
							</button>
						{/if}
					{/if}
				</div>
			</section>

			<section class="stlp-section stlp-section-chars">
				<h2 class="stlp-section-title">
					<span class="stlp-section-icon"><Icon name="users" /></span>
					Characters
				</h2>
				<div class="stlp-char-filterbar">
					<div class="stlp-char-pills">
						<button type="button" class="stlp-char-pill" class:active={!favoritesOnly} onclick={() => (favoritesOnly = false)}>All</button>
						<button type="button" class="stlp-char-pill" class:active={favoritesOnly} onclick={() => (favoritesOnly = true)}>Favorites</button>
					</div>
					<select class="stlp-char-sort" title="Sort characters" value={sort} onchange={(e) => (sortOverride = e.currentTarget.value as Sort)}>
						{#each SORTS as s (s.id)}
							<option value={s.id}>{s.label}</option>
						{/each}
					</select>
					<span class="stlp-char-count">{plural(filtered.length, 'character')}</span>
				</div>

				<div class="stlp-char-grid">
					{#if library.characters.length === 0}
						<div class="stlp-placeholder">No characters yet. <a href="/characters">Create one →</a></div>
					{:else if filtered.length === 0}
						<div class="stlp-placeholder">No characters match your filters.</div>
					{:else}
						{#each visibleCharacters as c, i (c.id)}
							<CharacterCard
								character={c}
								chatCount={chatCounts.get(c.id!) ?? 0}
								index={i}
								ontogglefavorite={toggleFavorite}
								onopen={(ch) => (openCharacter = ch)}
							/>
						{/each}
						{#if filtered.length > shown}
							<button class="stlp-load-more" type="button" onclick={() => (shown += PAGE_SIZE)}>
								Load more ({filtered.length - shown} left)
							</button>
						{/if}
					{/if}
				</div>
			</section>
		</main>
	</div>

	{#if showAllChats}
		<AllChatsModal {entries} onopen={(e) => { showAllChats = false; openChat(e); }} onclose={() => (showAllChats = false)} />
	{/if}

	{#if openCharacter}
		{@const current = openCharacter}
		<CharacterDetails
			character={current}
			latest={latestByCharacter.get(current.id!)}
			onclose={() => (openCharacter = null)}
		/>
	{/if}

	{#if showAppearance}
		<AppearancePanel onclose={() => (showAppearance = false)} />
	{/if}
</div>
