<script lang="ts">
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { connection } from '$lib/state/connection.svelte';
	import { db } from '$lib/db';
	import type { Character } from '$lib/types';

	let characters = $state<Character[]>([]);
	let editing = $state<Character | null>(null);
	let form = $state<Character>(blank());
	// On small screens the editor is a sheet; on md+ it always sits beside the grid
	let sheetOpen = $state(false);
	let gridEl = $state<HTMLElement>();
	let imageError = $state('');

	$effect(() => {
		setAppbar({ title: '', subtitle: '', avatar: '', search: false, actions: [{ label: 'New character', onclick: openNew }] });
	});

	function blank(): Character {
		return {
			name: '',
			description: '',
			personality: '',
			scenario: '',
			firstMessage: '',
			createdAt: 0,
			updatedAt: 0
		};
	}

	async function refresh() {
		characters = await db.characters.orderBy('updatedAt').reverse().toArray();
	}
	$effect(() => {
		refresh();
	});

	function initial(name: string): string {
		return name.trim().charAt(0).toUpperCase() || '?';
	}

	function select(c: Character) {
		editing = c;
		form = { ...c };
		imageError = '';
		sheetOpen = true;
	}

	function startNew() {
		editing = null;
		form = blank();
		imageError = '';
	}

	function openNew() {
		startNew();
		sheetOpen = true;
	}

	async function save() {
		if (!form.name.trim()) return;
		const now = Date.now();
		if (editing && editing.id != null) {
			await db.characters.update(editing.id, { ...form, updatedAt: now });
		} else {
			await db.characters.add({ ...form, createdAt: now, updatedAt: now });
		}
		startNew();
		sheetOpen = false;
		await refresh();
	}

	async function remove(c: Character) {
		if (c.id == null) return;
		if (!confirm(`Delete "${c.name}"? This also deletes its chats and messages.`)) return;
		const chats = await db.chats.where('characterId').equals(c.id).toArray();
		for (const ch of chats) {
			await db.messages.where('chatId').equals(ch.id!).delete();
			await db.chats.delete(ch.id!);
		}
		await db.characters.delete(c.id);
		if (editing?.id === c.id) startNew();
		sheetOpen = false;
		await refresh();
	}

	// Portrait from a file, stored as a data URL so it travels with the card in IndexedDB
	function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2_000_000) {
			imageError = 'Choose an image under 2 MB, or paste an image URL instead.';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			form.image = String(reader.result);
			imageError = '';
		};
		reader.readAsDataURL(file);
	}

	// Arrow keys move between tiles; Enter on a focused tile selects it (native click)
	function onGridKey(e: KeyboardEvent) {
		const tiles = [...(gridEl?.querySelectorAll<HTMLButtonElement>('[data-tile]') ?? [])];
		const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
		if (i < 0) return;
		const top = tiles[0].offsetTop;
		let cols = 0;
		while (cols < tiles.length && tiles[cols].offsetTop === top) cols++;
		const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
		const step = moves[e.key];
		if (step === undefined) return;
		const next = i + step;
		if (next >= 0 && next < tiles.length) {
			e.preventDefault();
			tiles[next].focus();
		}
	}
</script>

<div class="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:p-6">
	<section class="min-w-0">
		<h1 class="font-display text-3xl">Characters</h1>
		<p class="mt-2 max-w-prose text-sm text-dim">
			A character card is the seed of every story. The description, personality, and scenario feed the system prompt; the first message opens the scene.
		</p>

		{#if characters.length === 0}
			<div class="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-dim">
				No characters yet. <button type="button" class="ghost" onclick={openNew}>Create one</button>
			</div>
		{:else}
			<div
				bind:this={gridEl}
				role="group"
				aria-label="Characters"
				class="mt-6 grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4"
			>
				{#each characters as c (c.id)}
					<button
						type="button"
						data-tile
						onclick={() => select(c)}
						onkeydown={onGridKey}
						aria-pressed={editing?.id === c.id}
						class="flex flex-col overflow-hidden rounded-lg border bg-surface text-left transition-transform duration-lw ease-lw hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transform-none {editing?.id === c.id ? 'border-accent' : 'border-border'}"
					>
						<span class="grid aspect-[4/5] w-full place-items-center overflow-hidden bg-surface-2">
							{#if c.image}
								<img src={c.image} alt="" loading="lazy" class="size-full object-cover" />
							{:else}
								<span class="font-display text-4xl text-dim">{initial(c.name)}</span>
							{/if}
						</span>
						<span class="flex min-w-0 flex-col gap-1 p-3">
							<span class="truncate font-display text-base">{c.name}</span>
							{#if c.description}<span class="line-clamp-2 text-xs text-dim">{c.description}</span>{/if}
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<aside
		class="{sheetOpen
			? 'fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-xl border-t border-border bg-surface p-4 shadow-lw-3'
			: 'hidden'} md:sticky md:top-6 md:block md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto md:rounded-lg md:border md:border-border md:bg-surface md:p-5 md:shadow-none"
		aria-label="Character editor"
	>
		<div class="mb-4 flex items-center justify-between gap-2">
			<h2 class="font-display text-xl">{editing ? 'Edit character' : 'New character'}</h2>
			<button type="button" class="ghost md:hidden" onclick={() => (sheetOpen = false)}>Close</button>
		</div>

		<!-- Live preview mirrors the card as it is typed -->
		<div class="mb-5 flex gap-3 rounded-lg border border-border bg-surface-2 p-3">
			<span class="grid size-20 shrink-0 place-items-center overflow-hidden rounded-md bg-surface">
				{#if form.image}
					<img src={form.image} alt="" class="size-full object-cover" />
				{:else}
					<span class="font-display text-2xl text-dim">{initial(form.name)}</span>
				{/if}
			</span>
			<span class="min-w-0">
				<span class="block truncate font-display text-lg">{form.name.trim() || 'Untitled character'}</span>
				<span class="mt-1 line-clamp-3 block text-sm text-dim">
					{form.description.trim() || 'The description appears here as you type.'}
				</span>
			</span>
		</div>

		<form
			class="flex flex-col gap-4"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Name
				<input bind:value={form.name} placeholder="e.g. Mira the Cartographer" />
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Portrait (image URL)
				<input bind:value={form.image} placeholder="https://… or choose a file below" autocomplete="off" />
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Or choose a file (under 2 MB)
				<input type="file" accept="image/*" onchange={onFile} />
			</label>
			{#if imageError}<p class="text-sm text-danger">{imageError}</p>{/if}
			<label class="flex flex-col gap-1 text-sm text-dim">
				Description
				<textarea bind:value={form.description} placeholder="Who they are: appearance, history, role. Fed into the system prompt."></textarea>
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Personality
				<textarea bind:value={form.personality} placeholder="How they speak and behave: terse, warm, curious…"></textarea>
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Scenario
				<textarea bind:value={form.scenario} placeholder="The starting situation / setting."></textarea>
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				First message
				<textarea bind:value={form.firstMessage} placeholder="The opening line the character says to begin the roleplay."></textarea>
			</label>
			<label class="flex flex-col gap-1 text-sm text-dim">
				Model (leave empty to use the default)
				<input list="lw-models-characters" bind:value={form.model} placeholder={settings.model} autocomplete="off" />
				<datalist id="lw-models-characters">
					{#each connection.models as m (m)}<option value={m}></option>{/each}
				</datalist>
			</label>
			<div class="flex flex-wrap items-center gap-2">
				<button type="submit">{editing ? 'Update' : 'Create'}</button>
				{#if editing}
					<button type="button" class="ghost" onclick={startNew}>Cancel edit</button>
					<button type="button" class="danger" onclick={() => editing && remove(editing)}>Delete</button>
				{/if}
			</div>
		</form>
	</aside>
</div>
