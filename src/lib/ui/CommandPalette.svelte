<script lang="ts">
	import { goto } from '$app/navigation';
	import { db } from '$lib/db';
	import { createChat } from '$lib/chats';
	import { THEMES } from '$lib/landing/appearance';
	import { updateAppearance } from '$lib/state/settings.svelte';
	import { closePalette, openModel, openPalette, openStudio, ui } from '$lib/state/ui.svelte';
	import type { Character, Chat } from '$lib/types';

	type Item = { key: string; group: string; label: string; hint?: string; run: () => void | Promise<void> };

	let query = $state('');
	let active = $state(0);
	let input = $state<HTMLInputElement>();
	let characters = $state<Character[]>([]);
	let chats = $state<Chat[]>([]);

	// Data is read only when the palette opens, never at import time
	$effect(() => {
		if (!ui.paletteOpen) return;
		query = '';
		active = 0;
		Promise.all([db.characters.toArray(), db.chats.toArray()])
			.then(([c, ch]) => {
				characters = c;
				chats = [...ch].sort((a, b) => b.updatedAt - a.updatedAt);
			})
			.catch((err) => console.error('Palette data failed to load', err));
		input?.focus();
	});

	let items = $derived.by<Item[]>(() => {
		const byId = new Map(characters.map((c) => [c.id, c.name]));
		return [
			{ key: 'studio', group: 'Action', label: 'Open Studio', run: () => openStudio() },
			{ key: 'model', group: 'Action', label: 'Open Model settings', run: () => openModel() },
			{ key: 'new-character', group: 'Action', label: 'New character', run: () => goto('/characters') },
			...THEMES.map((t) => ({
				key: `theme-${t.id}`,
				group: 'Theme',
				label: `Use ${t.label}`,
				run: () => updateAppearance({ theme: t.id, accentColor: null, accent2Color: null, bgColor: null })
			})),
			...chats.map((ch) => ({
				key: `chat-${ch.id}`,
				group: 'Chat',
				label: ch.title || `Chat with ${byId.get(ch.characterId) ?? 'a character'}`,
				hint: byId.get(ch.characterId),
				run: () => goto(`/chat/${ch.id}`)
			})),
			...characters.map((c) => ({
				key: `character-${c.id}`,
				group: 'Character',
				label: c.name,
				hint: c.description.slice(0, 60),
				run: async () => {
					if (c.id === undefined) return;
					goto(`/chat/${await createChat(c)}`);
				}
			}))
		];
	});

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q));
	});

	function run(item: Item) {
		closePalette();
		Promise.resolve(item.run()).catch((err) => console.error('Palette action failed', err));
	}

	function onKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			if (ui.paletteOpen) closePalette();
			else openPalette();
		}
	}

	function onDialogKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closePalette();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filtered[active];
			if (item) run(item);
		} else if (e.key === 'Tab') {
			// Focus trap: the palette has one input and a list driven by arrow keys
			e.preventDefault();
		}
	}

	$effect(() => {
		// Keep the highlighted row inside the filtered list as the query changes
		if (active >= filtered.length) active = Math.max(filtered.length - 1, 0);
	});
</script>

<svelte:window onkeydown={onKey} />

{#if ui.paletteOpen}
	<div
		class="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) closePalette();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			tabindex="-1"
			onkeydown={onDialogKey}
			class="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-lw-3"
		>
			<input
				bind:this={input}
				bind:value={query}
				type="text"
				role="combobox"
				aria-expanded="true"
				aria-controls="lw-palette-list"
				aria-autocomplete="list"
				aria-activedescendant={filtered[active] ? `lw-opt-${active}` : undefined}
				placeholder="Type a command, character or chat"
				autocomplete="off"
				class="w-full border-0 border-b border-hairline bg-transparent px-4 py-3 text-text placeholder:text-dim focus:outline-none"
			/>
			<ul id="lw-palette-list" role="listbox" aria-label="Results" class="max-h-[55vh] overflow-y-auto p-2">
				{#each filtered as item, i (item.key)}
					<li
						id="lw-opt-{i}"
						role="option"
						aria-selected={i === active}
						class="flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2 text-sm {i === active ? 'bg-surface-2 text-text' : 'text-dim'}"
						onmouseenter={() => (active = i)}
						onclick={() => run(item)}
						onkeydown={() => {}}
					>
						<span class="min-w-0 truncate">{item.label}</span>
						<span class="shrink-0 text-xs text-dim">{item.group}</span>
					</li>
				{:else}
					<li class="px-3 py-2 text-sm text-dim">No matches.</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
