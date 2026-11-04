<script lang="ts">
	import { goto } from '$app/navigation';
	import { createChat } from '../chats';
	import Icon from './Icon.svelte';
	import type { Character } from '../types';
	import type { ChatEntry } from './library.svelte';

	let {
		character,
		latest,
		onclose
	}: {
		character: Character;
		latest: ChatEntry | undefined;
		onclose: () => void;
	} = $props();

	let initial = $derived(character.name.trim().charAt(0).toUpperCase() || '?');
	let created = $derived(
		character.createdAt
			? new Date(character.createdAt).toLocaleDateString(undefined, {
					year: 'numeric',
					month: 'long',
					day: 'numeric'
				})
			: 'Unknown'
	);
	let about = $derived(
		[
			{ label: 'Description', text: character.description },
			{ label: 'Personality', text: character.personality },
			{ label: 'Scenario', text: character.scenario }
		].filter((s) => s.text.trim())
	);

	let busy = $state(false);

	async function startNewChat() {
		if (busy || character.id == null) return;
		busy = true;
		try {
			const chatId = await createChat(character);
			await goto(`/chat/${chatId}`);
		} catch (err) {
			console.error('Failed to start new chat', err);
			busy = false;
		}
	}

	function resume() {
		if (latest?.chat.id != null) goto(`/chat/${latest.chat.id}`);
	}

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
	<div class="stlp-details" role="dialog" aria-modal="true" aria-label="Character details">
		<button class="stlp-icon-btn stlp-details-close" type="button" title="Close" onclick={onclose}>
			<Icon name="close" />
		</button>
		<div class="stlp-details-left">
			<div class="stlp-details-art">
				{#if character.image}
					<img src={character.image} alt={character.name} />
				{:else}
					<div class="stlp-char-initial">{initial}</div>
				{/if}
			</div>
			<h3 class="stlp-details-name">{character.name}</h3>
			<div class="stlp-details-date">Created: {created}</div>
			<div class="stlp-details-actions">
				{#if latest}
					<button class="stlp-details-resume" type="button" onclick={resume}>Resume latest chat</button>
				{/if}
				<button class="stlp-details-newchat" type="button" disabled={busy} onclick={startNewChat}>
					Start New Chat
				</button>
			</div>
		</div>
		<div class="stlp-details-right">
			<section class="stlp-details-section">
				<h4 class="stlp-details-section-title">Lorebooks</h4>
				<div class="stlp-details-empty">No lorebooks linked to this character.</div>
			</section>
			<section class="stlp-details-section">
				<h4 class="stlp-details-section-title">About</h4>
				<div class="stlp-details-notes">
					{#if about.length === 0}
						<p class="stlp-details-empty">No details written yet.</p>
					{:else}
						{#each about as section (section.label)}
							<p class="stlp-details-notes-text"><strong>{section.label}:</strong> {section.text}</p>
						{/each}
					{/if}
				</div>
			</section>
		</div>
	</div>
</div>
