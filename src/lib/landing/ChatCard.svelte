<script lang="ts">
	import Icon from './Icon.svelte';
	import { timeAgo, messageSnippet, plural } from './format';
	import type { ChatEntry } from './library.svelte';

	let {
		entry,
		index = 0,
		onopen
	}: { entry: ChatEntry; index?: number; onopen: (entry: ChatEntry) => void } = $props();

	let name = $derived(entry.character.name);
	let initial = $derived(name.trim().charAt(0).toUpperCase() || '?');
</script>

<div
	class="stlp-chat-card"
	style="--i: {Math.min(index, 12)}"
	role="button"
	tabindex="0"
	title={entry.chat.title}
	onclick={() => onopen(entry)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onopen(entry);
		}
	}}
>
	<div class="stlp-chat-header">
		<div class="stlp-chat-name">{name}</div>
	</div>
	<div class="stlp-chat-content-row">
		<div class="stlp-chat-avatar-wrap">
			{#if entry.character.image}
				<img class="stlp-chat-avatar" src={entry.character.image} alt="" loading="lazy" />
			{:else}
				<div class="stlp-chat-avatar-fallback">{initial}</div>
			{/if}
		</div>
		<div class="stlp-chat-desc-wrap">
			<div class="stlp-chat-desc">{messageSnippet(entry.lastMessage?.content)}</div>
		</div>
	</div>
	<div class="stlp-chat-footer">
		<div class="stlp-chat-stats">
			<span class="stlp-chat-stat">
				<Icon name="clock" />
				<span class="stlp-chat-time">{timeAgo(entry.chat.updatedAt)}</span>
			</span>
			<span class="stlp-chat-stat">
				<Icon name="chat" />
				<span>{plural(entry.messageCount, 'message')}</span>
			</span>
		</div>
		<button class="stlp-chat-continue" type="button" tabindex="-1">Continue</button>
	</div>
</div>
