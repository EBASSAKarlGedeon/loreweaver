<script lang="ts">
	import Icon from './Icon.svelte';
	import ChatCard from './ChatCard.svelte';
	import { plural } from './format';
	import type { ChatEntry } from './library.svelte';

	let {
		entries,
		onopen,
		onclose
	}: {
		entries: ChatEntry[];
		onopen: (entry: ChatEntry) => void;
		onclose: () => void;
	} = $props();

	let query = $state('');

	let shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(
			(e) =>
				e.character.name.toLowerCase().includes(q) ||
				e.chat.title.toLowerCase().includes(q)
		);
	});

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<div
	class="stlp-modal-overlay"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) onclose();
	}}
>
	<div class="stlp-modal" role="dialog" aria-modal="true" aria-label="All chats">
		<div class="stlp-modal-header">
			<div class="stlp-modal-title-group">
				<h3 class="stlp-modal-title">All Chats</h3>
				<span class="stlp-modal-count">
					{shown.length === entries.length
						? plural(entries.length, 'chat')
						: `${shown.length} of ${plural(entries.length, 'chat')}`}
				</span>
			</div>
			<div class="stlp-modal-tools">
				<div class="stlp-modal-search-wrap">
					<Icon name="search" />
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="stlp-modal-search"
						type="text"
						placeholder="Filter by character or chat name..."
						autocomplete="off"
						autofocus
						bind:value={query}
					/>
				</div>
				<button class="stlp-icon-btn stlp-modal-close" type="button" title="Close" onclick={onclose}>
					<Icon name="close" />
				</button>
			</div>
		</div>
		<div class="stlp-modal-body">
			{#if shown.length === 0}
				<div class="stlp-placeholder">No chats match your search.</div>
			{:else}
				{#each shown as entry (entry.chat.id)}
					<ChatCard {entry} {onopen} />
				{/each}
			{/if}
		</div>
	</div>
</div>
