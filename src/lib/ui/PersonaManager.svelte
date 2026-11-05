<script lang="ts">
	// SillyTavern-style Persona Management drawer, opened from the chat
	// composer's persona trigger. Left: the persona list (click = speak as
	// that persona in this chat). Right: the editor for the selected one.
	import { db } from '$lib/db';
	import type { Persona } from '$lib/types';
	import Icon from '$lib/landing/Icon.svelte';

	let {
		open = false,
		activeId = undefined,
		onselect,
		onclose
	}: {
		open?: boolean;
		activeId?: number | undefined;
		onselect: (id: number | undefined) => void;
		onclose: () => void;
	} = $props();

	let personas = $state<Persona[]>([]);
	let selectedId = $state<number | undefined>();
	let name = $state('');
	let description = $state('');
	let avatar = $state('');
	let imageError = $state('');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (open) {
			selectedId = activeId;
			load();
		}
	});

	async function load() {
		personas = await db.personas.orderBy('updatedAt').reverse().toArray();
		if (selectedId == null) selectedId = personas[0]?.id;
		loadForm();
	}

	function loadForm() {
		const p = personas.find((x) => x.id === selectedId);
		name = p?.name ?? '';
		description = p?.description ?? '';
		avatar = p?.avatar ?? '';
		imageError = '';
	}

	const selected = $derived(personas.find((p) => p.id === selectedId));
	const tokens = $derived(Math.ceil(((name || 'User') + description).length / 4));
	const safeSelected = $derived(selected?.id != null ? selected : undefined);

	// Edits persist live (debounced), like the Studio sliders.
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(saveNow, 300);
	}

	async function saveNow() {
		clearTimeout(saveTimer);
		const id = selected?.id;
		if (id == null || !name.trim()) return;
		await db.personas.update(id, {
			name: name.trim(),
			description,
			avatar,
			updatedAt: Date.now()
		});
		const i = personas.findIndex((p) => p.id === id);
		if (i >= 0) personas[i] = { ...personas[i], name: name.trim(), description, avatar };
		if (activeId === id) onselect(id); // refresh the trigger label
	}

	async function pick(p: Persona) {
		await saveNow();
		selectedId = p.id;
		loadForm();
		onselect(p.id);
	}

	async function create() {
		await saveNow();
		const now = Date.now();
		const id = await db.personas.add({ name: 'New persona', description: '', createdAt: now, updatedAt: now });
		await load();
		selectedId = id;
		loadForm();
		onselect(id);
	}

	async function remove() {
		const id = selected?.id;
		if (id == null) return;
		if (!confirm(`Delete "${selected?.name}"? Chats keep their messages; prompts just drop it.`)) return;
		await db.personas.delete(id);
		// Detach from chats still pointing at it; empty personaId = none.
		await db.chats.where('personaId').equals(id).modify({ personaId: undefined });
		if (activeId === id) onselect(undefined);
		selectedId = undefined;
		await load();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			onclose();
		}
	}

	function initial(n: string): string {
		return n.trim().charAt(0).toUpperCase() || '?';
	}

	// Avatar from a file, stored as a data URL (same limit as portraits)
	function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2_000_000) {
			imageError = 'Choose an image under 2 MB, or paste an image URL instead.';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			avatar = String(reader.result);
			imageError = '';
			scheduleSave();
		};
		reader.readAsDataURL(file);
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<button type="button" aria-label="Close persona management" class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onclick={() => onclose()}></button>
	<div
		class="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-border bg-surface shadow-lw-3"
		role="dialog"
		aria-label="Persona Management"
	>
		<header class="flex items-center justify-between gap-2 border-b border-hairline px-5 py-4">
			<h2 class="m-0 font-display text-xl">Persona Management</h2>
			<button type="button" class="ghost" onclick={() => onclose()}>Close</button>
		</header>

		<div class="grid min-h-0 flex-1 md:grid-cols-2">
			<!-- Left: the persona list -->
			<div class="flex min-h-0 flex-col border-b border-hairline md:border-r md:border-b-0">
				<div class="flex items-center gap-2 px-4 pt-3">
					<button type="button" onclick={create} class="flex items-center gap-1.5 rounded-md border border-accent px-2.5 py-1.5 text-xs text-accent focus-visible:outline-2 focus-visible:outline-accent">
						<Icon name="plus" />
						New persona
					</button>
					<button
						type="button"
						onclick={() => onselect(undefined)}
						class="rounded-md border border-border px-2.5 py-1.5 text-xs {activeId == null ? 'text-accent' : 'text-dim'} focus-visible:outline-2 focus-visible:outline-accent"
						aria-pressed={activeId == null}
					>
						No persona
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto p-4">
					{#if personas.length === 0}
						<p class="m-0 text-sm text-dim">No personas yet. Create one to speak as someone in your chats.</p>
					{:else}
						<ul class="m-0 flex list-none flex-col gap-2 p-0">
							{#each personas as p (p.id)}
								{@const isActive = p.id === activeId}
								<li>
									<button
										type="button"
										onclick={() => pick(p)}
										class="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-lw-fast focus-visible:outline-2 focus-visible:outline-accent {selectedId === p.id ? 'border-border bg-surface-2' : 'border-transparent hover:bg-surface-2'} {isActive ? 'border-accent' : ''}"
										aria-pressed={isActive}
									>
										<span class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-surface text-dim">
											{#if p.avatar}
												<img src={p.avatar} alt="" class="size-full object-cover" />
											{:else}
												<span class="font-display">{initial(p.name)}</span>
											{/if}
										</span>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-text">{p.name}</span>
											<span class="block truncate text-xs text-dim">{p.description || 'No description'}</span>
										</span>
										{#if isActive}<span class="text-xs text-accent">Active</span>{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>

			<!-- Right: the selected persona's editor -->
			<div class="min-h-0 overflow-y-auto px-5 py-4">
				{#if safeSelected}
					<div class="mb-4 flex items-center gap-3">
						<span class="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-dim">
							{#if avatar}
								<img src={avatar} alt="" class="size-full object-cover" />
							{:else}
								<span class="text-xl font-display">{initial(name)}</span>
							{/if}
						</span>
						<div class="min-w-0">
							<p class="m-0 truncate font-display text-lg">{name.trim() || 'Unnamed persona'}</p>
							<p class="m-0 text-xs text-dim">{tokens.toLocaleString()} tok</p>
						</div>
					</div>

					<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); saveNow(); onclose(); }}>
						<label class="flex flex-col gap-1 text-sm text-dim">
							Name
							<input bind:value={name} oninput={scheduleSave} placeholder="e.g. Alex, a wandering courier" />
						</label>
						<label class="flex flex-col gap-1 text-sm text-dim">
							Avatar (image URL)
							<input bind:value={avatar} oninput={scheduleSave} placeholder="https://… or choose a file below" autocomplete="off" />
						</label>
						<label class="flex flex-col gap-1 text-sm text-dim">
							Or choose a file (under 2 MB)
							<input type="file" accept="image/*" onchange={onFile} />
						</label>
						{#if imageError}<p class="m-0 text-sm text-danger">{imageError}</p>{/if}
						<label class="flex flex-col gap-1 text-sm text-dim">
							Description
							<textarea bind:value={description} oninput={scheduleSave} rows="6" placeholder="Who you are in the fiction: appearance, history, speech style. Fed into the prompt as your identity."></textarea>
						</label>
						<div class="flex flex-wrap items-center gap-2">
							<button type="button" onclick={() => pick(safeSelected!)}>Use in this chat</button>
							<button type="button" class="ghost" onclick={create}>Duplicate fields to new</button>
							<button type="button" class="danger" onclick={remove}>Delete</button>
						</div>
					</form>
				{:else}
					<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">
						Select a persona to edit it, or create one.
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}