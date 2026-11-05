<script lang="ts">
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { connection } from '$lib/state/connection.svelte';
	import { db } from '$lib/db';
	import type { Character } from '$lib/types';

	let characters = $state<Character[]>([]);
	let editing = $state<Character | null>(null);
	let form = $state<Character>(blank());
	let sheetOpen = $state(false);
	let imageError = $state('');
	let tagsText = $state('');

	// Filters
	let query = $state('');
	let sort = $state<'recent' | 'name' | 'tokens'>('recent');
	let privacy = $state<'all' | 'private' | 'public'>('all');
	let activeTags = $state<string[]>([]);

	// Rough estimate (about 4 characters per token) of what the card adds to the prompt
	const tokens = (c: Character) =>
		Math.ceil((c.description + c.personality + c.scenario + c.firstMessage).length / 4);
	const allTags = $derived([...new Set(characters.flatMap((c) => c.tags ?? []))].sort());
	const visible = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = characters.filter(
			(c) =>
				(!q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) &&
				(privacy === 'all' || (privacy === 'private') === !!c.private) &&
				activeTags.every((t) => c.tags?.includes(t))
		);
		if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
		else if (sort === 'tokens') list.sort((a, b) => tokens(b) - tokens(a));
		return list;
	});
	function toggleTag(t: string) {
		activeTags = activeTags.includes(t) ? activeTags.filter((x) => x !== t) : [...activeTags, t];
	}

	$effect(() => {
		setAppbar({ title: '', subtitle: '', avatar: '', search: false, actions: [] });
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
		tagsText = (c.tags ?? []).join(', ');
		imageError = '';
		sheetOpen = true;
	}

	function startNew() {
		editing = null;
		form = blank();
		tagsText = '';
		imageError = '';
	}

	function openNew() {
		startNew();
		sheetOpen = true;
	}

	async function save() {
		if (!form.name.trim()) return;
		const now = Date.now();
		form.tags = [...new Set(tagsText.split(',').map((t) => t.trim()).filter(Boolean))];
		const data = $state.snapshot(form);
		if (editing && editing.id != null) {
			await db.characters.update(editing.id, { ...data, updatedAt: now });
		} else {
			await db.characters.add({ ...data, createdAt: now, updatedAt: now });
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
</script>

<div class="cd-page">
	<aside class="cd-side" aria-label="Filters">
		<label class="cd-label" for="cd-search">Search</label>
		<input id="cd-search" class="cd-field" type="search" bind:value={query} placeholder="Name or description" />

		<label class="cd-label" for="cd-sort">Sort by</label>
		<select id="cd-sort" class="cd-field" bind:value={sort}>
			<option value="recent">Recently updated</option>
			<option value="name">Name</option>
			<option value="tokens">Token count</option>
		</select>

		<label class="cd-label" for="cd-privacy">Privacy</label>
		<select id="cd-privacy" class="cd-field" bind:value={privacy}>
			<option value="all">All</option>
			<option value="private">Private</option>
			<option value="public">Public</option>
		</select>

		<span class="cd-label">Tags</span>
		<div class="flex flex-wrap gap-1.5">
			{#each allTags as t (t)}
				<button type="button" class="cd-pill" aria-pressed={activeTags.includes(t)} onclick={() => toggleTag(t)}>{t}</button>
			{:else}
				<span class="text-xs text-dim">No tags yet. Add some when editing a card.</span>
			{/each}
		</div>
	</aside>

	<section class="min-w-0">
		<header class="cd-head">
			<h1 class="cd-title">My Characters <span class="cd-count">({visible.length})</span></h1>
			<button type="button" class="cd-new" onclick={openNew}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				New character
			</button>
		</header>

		{#if characters.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">
				No characters yet. <button type="button" class="ghost" onclick={openNew}>Create one</button>
			</div>
		{:else if visible.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">No characters match these filters.</div>
		{:else}
			<div class="cd-grid" role="list" aria-label="Characters">
				{#each visible as c (c.id)}
					<article class="cd-card" role="listitem" data-active={editing?.id === c.id}>
						<div class="cd-top">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label={c.private ? 'Private' : 'Public'}>
								<rect x="4" y="11" width="16" height="10" rx="2" />
								<path d={c.private ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} />
							</svg>
							<span class="cd-mono">{tokens(c).toLocaleString()} tok</span>
						</div>
						<h2 class="cd-name" title={c.name}>{c.name}</h2>
						<div class="cd-cover">
							{#if c.image}
								<img src={c.image} alt="" loading="lazy" />
							{:else}
								<span class="cd-initial">{initial(c.name)}</span>
							{/if}
							{#if c.model}<span class="cd-badge">{c.model}</span>{/if}
						</div>
						<div class="cd-divider" aria-hidden="true">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" /></svg>
						</div>
						<div class="cd-tags">
							{#each c.tags ?? [] as t (t)}<span class="cd-tag">{t}</span>{/each}
						</div>
						<footer class="cd-foot">
							<button type="button" class="cd-edit" onclick={() => select(c)}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
								Edit
							</button>
							<button type="button" class="cd-trash" aria-label="Delete {c.name}" onclick={() => remove(c)}>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>
							</button>
						</footer>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if sheetOpen}
		<button type="button" aria-label="Close editor" class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick={() => (sheetOpen = false)}></button>
		<aside
			class="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-border bg-surface p-5 shadow-lw-3"
			aria-label="Character editor"
		>
			<div class="mb-4 flex items-center justify-between gap-2">
				<h2 class="font-display text-xl">{editing ? 'Edit character' : 'New character'}</h2>
				<button type="button" class="ghost" onclick={() => (sheetOpen = false)}>Close</button>
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
					Tags (comma separated)
					<input bind:value={tagsText} placeholder="fantasy, noir, slow-burn" autocomplete="off" />
				</label>
				<label class="flex items-center gap-2 text-sm text-dim">
					<input type="checkbox" bind:checked={form.private} style="width:auto" />
					Private (shows a closed lock on the card)
				</label>
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
	{/if}
</div>

<style>
	.cd-page { display: grid; gap: 28px; padding: 24px; max-width: 1800px; margin: 0 auto; }
	@media (min-width: 900px) { .cd-page { grid-template-columns: 300px minmax(0, 1fr); } }
	.cd-side { display: flex; flex-direction: column; gap: 8px; align-self: start; }
	.cd-label { font: 500 12px/1 var(--lw-font); text-transform: uppercase; letter-spacing: 0.14em; color: var(--lw-text-dim); margin-top: 14px; }
	.cd-side > .cd-label:first-child { margin-top: 0; }
	.cd-field { width: 100%; background: var(--lw-surface-2); border: 1px solid var(--lw-border); border-radius: 8px; padding: 9px 12px; color: var(--lw-text); font-family: var(--lw-font); }
	.cd-field:focus-visible { outline: 2px solid var(--lw-accent); outline-offset: 1px; }
	.cd-pill, .cd-tag { border-radius: 999px; border: 1px solid var(--lw-accent); background: color-mix(in oklab, var(--lw-accent) 14%, transparent); color: var(--lw-text); font: 13px/1 var(--lw-font); padding: 5px 11px; }
	.cd-pill { cursor: pointer; opacity: 0.7; }
	.cd-pill[aria-pressed='true'] { opacity: 1; background: color-mix(in oklab, var(--lw-accent) 40%, transparent); }
	.cd-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
	.cd-title { font: 500 44px/1.1 var(--lw-font-display); }
	.cd-count { font-size: 32px; color: var(--lw-text-dim); }
	.cd-new { display: inline-flex; align-items: center; gap: 8px; background: var(--lw-accent); color: var(--lw-on-accent); border: 0; border-radius: 8px; padding: 10px 16px; font: 600 14px var(--lw-font); cursor: pointer; box-shadow: 0 0 22px color-mix(in oklab, var(--lw-accent) 45%, transparent); }
	.cd-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
	@media (min-width: 1300px) { .cd-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
	.cd-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid color-mix(in oklab, var(--lw-accent) 28%, var(--lw-border)); background: linear-gradient(180deg, var(--lw-surface-2), var(--lw-surface)); box-shadow: 0 0 24px color-mix(in oklab, var(--lw-accent) 14%, transparent); backdrop-filter: blur(var(--lw-blur)); min-width: 0; }
	.cd-card[data-active='true'] { border-color: var(--lw-accent); }
	.cd-top { display: flex; align-items: center; gap: 8px; color: var(--lw-text-dim); }
	.cd-mono { font: 12px/1 'JetBrains Mono', ui-monospace, Consolas, monospace; color: var(--lw-text-dim); }
	.cd-name { font: 500 15px/1.3 Inter, var(--lw-font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.cd-cover { position: relative; aspect-ratio: 1; margin: 0 -12px; overflow: hidden; background: var(--lw-bg); display: grid; place-items: center; }
	.cd-cover img { width: 100%; height: 100%; object-fit: cover; }
	.cd-initial { font: 500 56px var(--lw-font-display); color: var(--lw-text-dim); }
	.cd-badge { position: absolute; top: 8px; right: 8px; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--lw-accent); color: var(--lw-on-accent); font: 600 11px/1 var(--lw-font); padding: 4px 8px; border-radius: 6px; box-shadow: 0 0 12px color-mix(in oklab, var(--lw-accent) 50%, transparent); }
	.cd-divider { display: flex; align-items: center; gap: 8px; color: var(--lw-accent2); }
	.cd-divider::before, .cd-divider::after { content: ''; flex: 1; height: 1px; background: var(--lw-border); }
	.cd-tags { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; }
	.cd-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--lw-border); padding-top: 10px; }
	.cd-edit { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--lw-border); background: transparent; color: var(--lw-text); border-radius: 8px; padding: 6px 14px; font: 700 16px Inter, var(--lw-font); cursor: pointer; }
	.cd-edit:hover { border-color: var(--lw-accent); }
	.cd-trash { background: transparent; border: 0; color: var(--lw-danger); cursor: pointer; padding: 6px; border-radius: 8px; }
	.cd-trash:hover { background: color-mix(in oklab, var(--lw-danger) 15%, transparent); }
	@media (max-width: 600px) { .cd-title { font-size: 34px; } .cd-count { font-size: 24px; } }
</style>
