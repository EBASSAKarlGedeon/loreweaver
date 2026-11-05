<script lang="ts">
	// SillyTavern-style Persona Management drawer, opened from the chat
	// composer's persona trigger. Left: the persona list (click = speak as
	// that persona in this chat). Right: the editor for the selected one.
	import { db } from '$lib/db';
	import type { Persona } from '$lib/types';
	import Icon from '$lib/landing/Icon.svelte';
	import { settings, saveSettings } from '$lib/state/settings.svelte';

	let {
		open = false,
		activeId = undefined,
		characterId = undefined,
		onselect,
		onclose
	}: {
		open?: boolean;
		activeId?: number | undefined;
		characterId?: number | undefined; // for character locks
		onselect: (id: number | undefined) => void;
		onclose: () => void;
	} = $props();

	let personas = $state<Persona[]>([]);
	let selectedId = $state<number | undefined>();
	let name = $state('');
	let description = $state('');
	let avatar = $state('');
	let imageError = $state('');
	let search = $state('');
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let restoreInput = $state<HTMLInputElement>();

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

	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return personas;
		return personas.filter(
			(p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
		);
	});

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
		await refreshList();
	}

	async function refreshList() {
		const id = selectedId;
		personas = await db.personas.orderBy('updatedAt').reverse().toArray();
		selectedId = id;
	}

	async function pick(p: Persona) {
		await saveNow();
		selectedId = p.id;
		loadForm();
		await applyPersona(p.id);
	}

	// Selecting a persona stamps it on the chat. Auto-lock (default on)
	// also pins it for this character's next chats.
	async function applyPersona(id: number | undefined) {
		onselect(id);
		if (id == null) return;
		if (settings.personaAutoLock && characterId != null) {
			await saveSettings({});
			await db.personas.update(id, { lockToCharacterId: characterId });
			await refreshList();
		}
	}

	async function create(fields?: { name: string; description: string; avatar?: string }) {
		await saveNow();
		const now = Date.now();
		const id = await db.personas.add({
			name: fields?.name || 'New persona',
			description: fields?.description ?? '',
			avatar: fields?.avatar ?? '',
			createdAt: now,
			updatedAt: now
		});
		await load();
		selectedId = id;
		loadForm();
	}

	async function duplicate() {
		if (!safeSelected) return;
		const p = safeSelected;
		await create({
			name: `${p.name} (copy)`,
			description: p.description,
			avatar: p.avatar
		});
	}

	async function remove() {
		const id = selected?.id;
		if (id == null) return;
		if (!confirm(`Delete "${selected?.name}"? Chats keep their messages; prompts just drop it.`)) return;
		await db.personas.delete(id);
		// Detach from chats still pointing at it; empty personaId = none.
		await db.chats.where('personaId').equals(id).modify({ personaId: undefined });
		if (settings.defaultPersonaId === id) await saveSettings({ defaultPersonaId: undefined });
		if (activeId === id) onselect(undefined);
		selectedId = undefined;
		await load();
	}

	function toggleDefault() {
		if (safeSelected == null) return;
		const id = safeSelected.id!;
		saveSettings({ defaultPersonaId: settings.defaultPersonaId === id ? undefined : id });
	}

	async function toggleCharacterLock() {
		if (safeSelected == null || characterId == null) return;
		const id = safeSelected.id!;
		const locked = safeSelected.lockToCharacterId === characterId;
		await db.personas.update(id, { lockToCharacterId: locked ? undefined : characterId });
		await refreshList();
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

	// ---------- Backup / restore (SillyTavern personas_backup/personas_restore) ----------

	function backup() {
		const dump = JSON.stringify({ format: 'loreweaver-personas', version: 1, personas }, null, 2);
		const blob = new Blob([dump], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `loreweaver-personas-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function restore(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			const parsed = JSON.parse(text) as { personas?: Persona[] };
			const list = Array.isArray(parsed.personas) ? parsed.personas : [];
			if (list.length === 0) {
				alert('No personas found in that file.');
				return;
			}
			const now = Date.now();
			await db.personas.bulkAdd(
				list.map((p) => ({
					name: p.name || 'Imported persona',
					description: p.description ?? '',
					avatar: p.avatar ?? '',
					createdAt: p.createdAt ?? now,
					updatedAt: now
				}))
			);
			await load();
		} catch (err) {
			alert(`Could not read that file: ${(err as Error).message}`);
		}
		input.value = '';
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
			<div class="flex items-center gap-2">
				<button type="button" class="ghost" onclick={backup} title="Backup your personas to a file">Backup</button>
				<button type="button" class="ghost" onclick={() => restoreInput?.click()} title="Restore your personas from a file">Restore</button>
				<input bind:this={restoreInput} type="file" accept=".json" class="hidden" onchange={restore} />
				<button type="button" class="ghost" onclick={() => onclose()}>Close</button>
			</div>
		</header>

		<div class="grid min-h-0 flex-1 md:grid-cols-2">
			<!-- Left: the persona list -->
			<div class="flex min-h-0 flex-col border-b border-hairline md:border-r md:border-b-0">
				<div class="flex flex-wrap items-center gap-2 px-4 pt-3">
					<button type="button" onclick={() => create()} class="flex items-center gap-1.5 rounded-md border border-accent px-2.5 py-1.5 text-xs text-accent focus-visible:outline-2 focus-visible:outline-accent">
						<Icon name="plus" />
						New persona
					</button>
					<button
						type="button"
						onclick={() => applyPersona(undefined)}
						class="rounded-md border border-border px-2.5 py-1.5 text-xs {activeId == null ? 'text-accent' : 'text-dim'} focus-visible:outline-2 focus-visible:outline-accent"
						aria-pressed={activeId == null}
					>
						No persona
					</button>
					<input type="search" bind:value={search} placeholder="Search personas…" class="min-w-24 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text placeholder:text-dim focus-visible:outline-2 focus-visible:outline-accent" />
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto p-4">
					{#if visible.length === 0}
						<p class="m-0 text-sm text-dim">No personas match. Create one to speak as someone in your chats.</p>
					{:else}
						<ul class="m-0 flex list-none flex-col gap-2 p-0">
							{#each visible as p (p.id)}
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
										{#if settings.defaultPersonaId === p.id}<span class="text-xs text-accent" title="Default for new chats">★</span>{/if}
										{#if characterId != null && p.lockToCharacterId === characterId}<span class="text-xs text-dim" title="Locked to this character">🔒</span>{/if}
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
							<button type="button" onclick={() => applyPersona(safeSelected?.id)}>Use in this chat</button>
							<button type="button" class="ghost" onclick={duplicate}>Duplicate</button>
							<button type="button" class="danger" onclick={remove}>Delete</button>
						</div>

						<div class="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
							<button
								type="button"
								onclick={toggleDefault}
								class="rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-accent {settings.defaultPersonaId === safeSelected.id ? 'border-accent text-accent' : 'border-border text-dim'}"
								aria-pressed={settings.defaultPersonaId === safeSelected.id}
								title="Use this persona for every new chat"
							>
								★ Default
							</button>
							{#if characterId != null}
								<button
									type="button"
									onclick={toggleCharacterLock}
									class="rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-accent {safeSelected.lockToCharacterId === characterId ? 'border-accent text-accent' : 'border-border text-dim'}"
									aria-pressed={safeSelected.lockToCharacterId === characterId}
									title="Pin this persona for every new chat with this character"
								>
									🔒 Character
								</button>
							{/if}
						</div>
					</form>
				{:else}
					<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">
						Select a persona to edit it, or create one.
					</div>
				{/if}

				<!-- Global settings (SillyTavern persona global settings) -->
				<div class="mt-6 border-t border-hairline pt-4">
					<h3 class="m-0 mb-2 text-sm text-dim">Global Settings</h3>
					<label class="flex items-center gap-2 text-xs text-dim">
						<input type="checkbox" checked={settings.personaAutoLock} onchange={(e) => saveSettings({ personaAutoLock: e.currentTarget.checked })} />
						Auto-lock a chosen persona to the chat
					</label>
					<label class="mt-2 flex items-center gap-2 text-xs text-dim">
						<input type="checkbox" checked={settings.personaNotifications} onchange={(e) => saveSettings({ personaNotifications: e.currentTarget.checked })} />
						Show notifications on switching personas
					</label>
					<label class="mt-2 flex items-center gap-2 text-xs text-dim" title="When multiple personas are locked to a character, the trigger lets you pick any of them">
						<input type="checkbox" checked={settings.personaAllowMulti} onchange={(e) => saveSettings({ personaAllowMulti: e.currentTarget.checked })} />
						Allow multiple persona connections per character
					</label>

					<h3 class="m-0 mb-2 mt-4 text-sm text-dim">Position</h3>
					<label class="flex flex-col gap-1 text-xs text-dim">
						Where the persona description goes in the prompt
						<select
							value={settings.personaPosition}
							onchange={(e) => saveSettings({ personaPosition: e.currentTarget.value as 'system' | 'top' | 'bottom' | 'depth' })}
							class="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-accent"
						>
							<option value="system">System message (after the character card)</option>
							<option value="top">Top of Author's Note</option>
							<option value="bottom">Bottom of Author's Note</option>
							<option value="depth">In-chat @ Depth</option>
						</select>
					</label>
					{#if settings.personaPosition === 'depth'}
						<div class="mt-2 flex gap-2">
							<label class="flex flex-1 flex-col gap-1 text-xs text-dim">
								Depth
								<input type="number" min="0" max="9999" value={settings.personaDepth} onchange={(e) => saveSettings({ personaDepth: Number(e.currentTarget.value) })} class="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-accent" />
							</label>
							<label class="flex flex-1 flex-col gap-1 text-xs text-dim">
								Role
								<select value={settings.personaDepthRole} onchange={(e) => saveSettings({ personaDepthRole: e.currentTarget.value as 'system' | 'user' | 'assistant' })} class="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-accent">
									<option value="system">System</option>
									<option value="user">User</option>
									<option value="assistant">Assistant</option>
								</select>
							</label>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}