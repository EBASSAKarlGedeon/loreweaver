<script lang="ts">
	import Icon from './Icon.svelte';
	import { descriptionSnippet, plural } from './format';
	import type { Character } from '../types';

	let {
		character,
		chatCount,
		index = 0,
		ontogglefavorite,
		onopen
	}: {
		character: Character;
		chatCount: number;
		index?: number;
		ontogglefavorite: (character: Character) => void;
		onopen: (character: Character) => void;
	} = $props();

	let initial = $derived(character.name.trim().charAt(0).toUpperCase() || '?');
</script>

<div
	class="stlp-char-card"
	style="--i: {Math.min(index, 12)}"
	role="button"
	tabindex="0"
	title={character.name}
	onclick={() => onopen(character)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onopen(character);
		}
	}}
>
	<div class="stlp-char-art">
		{#if character.image}
			<img src={character.image} alt="" loading="lazy" />
		{:else}
			<div class="stlp-char-initial">{initial}</div>
		{/if}
		<div class="stlp-char-art-fade"></div>
		<span class="stlp-char-ribbon">{plural(chatCount, 'chat')}</span>
		<button
			class="stlp-char-fav"
			class:active={character.favorite}
			type="button"
			title={character.favorite ? 'Remove from favorites' : 'Add to favorites'}
			onclick={(e) => {
				e.stopPropagation();
				ontogglefavorite(character);
			}}
		>
			<Icon name="heart" />
		</button>
		<div class="stlp-char-name">{character.name}</div>
	</div>
	<div class="stlp-char-body">
		<div class="stlp-char-desc">{descriptionSnippet(character.description || character.personality)}</div>
	</div>
</div>
