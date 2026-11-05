<script lang="ts">
	// SillyTavern's Persona Management panel (reference/SillyTavern-1.18.0
	// public/index.html #persona_management), adapted as a centered overlay
	// the way ST's .drawer-content floats below the top bar — not a side
	// drawer. Structure and labels follow ST; colors are LoreWeaver's --lw-*
	// tokens. Left: avatar grid with search, sort, pagination, grid toggle.
	// Right: current-persona controls, description, the persona-exclusive
	// Position/depth/role editor, connections, and the three global checkboxes.
	import { db } from '$lib/db';
	import type { Chat, Persona, PersonaPosition } from '$lib/types';
	import Icon from '$lib/landing/Icon.svelte';
	import { settings, saveSettings } from '$lib/state/settings.svelte';
	import { fade, scale } from 'svelte/transition';

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
	// Editor fields — position/depth/depthRole live on the persona itself
	// (persona-exclusive, like ST), with settings as the fallback for old rows.
	let name = $state('');
	let description = $state('');
	let avatar = $state('');
	let position = $state<PersonaPosition>('system');
	let depth = $state(4);
	let depthRole = $state<'system' | 'user' | 'assistant'>('system');
	let imageError = $state('');
	let search = $state('');
	let sortOrder = $state<'asc' | 'desc'>('asc');
	let gridView = $state(false);
	let page = $state(1);
	let perPage = $state(5);
	let connectedChats = $state<Chat[]>([]);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let restoreInput = $state<HTMLInputElement>();
	let avatarInput = $state<HTMLInputElement>();
	let uploadInput = $state<HTMLInputElement>();

	// ST standoutHeader: a small bordered banner above each section.
	// mt-0: Tailwind preflight is off, so the UA h4 top margin would leak.
	const standout = 'mt-0 mb-1.5 rounded-md border border-hairline bg-surface-2 px-2 py-0.5 text-sm font-semibold';

	let wasOpen = false;

	$effect(() => {
		// Initialize only on the closed→open edge: re-reading activeId here
		// would reset the editor and pagination on every mid-edit persona switch.
		if (open && !wasOpen) {
			wasOpen = true;
			selectedId = activeId;
			page = 1;
			load();
		} else if (!open) {
			wasOpen = false;
		}
	});

	// Keep the page in range when the list shrinks (search, delete).
	$effect(() => {
		if (page > totalPages) page = totalPages;
		if (page < 1) page = 1;
	});

	async function load() {
		personas = await db.personas.orderBy('updatedAt').reverse().toArray();
		if (selectedId == null) selectedId = personas[0]?.id;
		await loadForm();
	}

	async function loadForm() {
		const p = personas.find((x) => x.id === selectedId);
		name = p?.name ?? '';
		description = p?.description ?? '';
		avatar = p?.avatar ?? '';
		position = p?.position ?? settings.personaPosition ?? 'system';
		depth = p?.depth ?? settings.personaDepth ?? 4;
		depthRole = p?.depthRole ?? settings.personaDepthRole ?? 'system';
		imageError = '';
		connectedChats =
			selectedId == null ? [] : await db.chats.where('personaId').equals(selectedId).toArray();
	}

	const selected = $derived(personas.find((p) => p.id === selectedId));
	const tokens = $derived(Math.ceil(((name || 'User') + description).length / 4));
	const safeSelected = $derived(selected?.id != null ? selected : undefined);

	// ST sort: persona names A-Z / Z-A; a search term pins the select to a
	// hidden "Search" option so the current filter is visible.
	const sorted = $derived.by(() => {
		const list = [...personas];
		list.sort((a, b) => a.name.localeCompare(b.name) * (sortOrder === 'asc' ? 1 : -1));
		return list;
	});
	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter(
			(p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
		);
	});
	const totalPages = $derived(Math.max(1, Math.ceil(visible.length / perPage)));
	const pageItems = $derived(visible.slice((page - 1) * perPage, page * perPage));
	const pageRange = $derived(
		`${visible.length === 0 ? 0 : (page - 1) * perPage + 1}-${Math.min(page * perPage, visible.length)} .. ${visible.length}`
	);

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
			position,
			depth,
			depthRole,
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
		await loadForm();
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

	async function create(fields?: {
		name: string;
		description: string;
		avatar?: string;
		position?: PersonaPosition;
		depth?: number;
		depthRole?: 'system' | 'user' | 'assistant';
	}) {
		await saveNow();
		const now = Date.now();
		const id = await db.personas.add({
			name: fields?.name || 'New persona',
			description: fields?.description ?? '',
			avatar: fields?.avatar ?? '',
			// New personas start on the current defaults, then stay editable per persona.
			position: fields?.position ?? settings.personaPosition,
			depth: fields?.depth ?? settings.personaDepth,
			depthRole: fields?.depthRole ?? settings.personaDepthRole,
			createdAt: now,
			updatedAt: now
		});
		await load();
		selectedId = id;
		await loadForm();
	}

	// ST createDummyPersona: a name popup first; empty/cancel aborts.
	async function createDummy(avatarUrl = '') {
		const n = prompt('New persona name', 'New persona');
		if (n == null || !n.trim()) return;
		await create({ name: n.trim(), description: '', avatar: avatarUrl });
	}

	// Shared by both avatar paths: data-URL read with the same 2 MB guard.
	function readImageFile(file: File): Promise<string> {
		if (file.size > 2_000_000) {
			return Promise.reject(new Error('Choose an image under 2 MB, or paste an image URL instead.'));
		}
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'));
			reader.readAsDataURL(file);
		});
	}

	// The avatar grid's "+" tile: pick an image, then name the new persona.
	async function onUploadCreate(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const dataUrl = await readImageFile(file);
			await createDummy(dataUrl);
		} catch (err) {
			imageError = (err as Error).message;
		}
	}

	async function duplicate() {
		const id = safeSelected?.id;
		if (id == null) return;
		// Flush pending edits first so the copy matches what's on screen.
		await saveNow();
		const p = await db.personas.get(id);
		if (!p) return;
		await create({
			name: `${p.name} (copy)`,
			description: p.description,
			avatar: p.avatar,
			position: p.position,
			depth: p.depth,
			depthRole: p.depthRole
		});
	}

	// ST rename button: a name popup over the selected persona.
	function rename() {
		if (!safeSelected) return;
		const n = prompt('Rename persona', name);
		if (n == null || !n.trim()) return;
		name = n.trim();
		saveNow();
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

	// Connections ▸ Chat: lock the persona to the open chat (or unlock it).
	async function toggleChatLock() {
		if (safeSelected == null) return;
		await applyPersona(activeId === safeSelected.id ? undefined : safeSelected.id);
	}

	function onSort(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v === 'asc' || v === 'desc') {
			sortOrder = v;
			page = 1;
		}
	}

	function onPosition(e: Event) {
		position = (e.currentTarget as HTMLSelectElement).value as PersonaPosition;
		scheduleSave();
	}

	function onDepth(e: Event) {
		depth = Math.max(0, Math.min(9999, Number((e.currentTarget as HTMLInputElement).value) || 0));
		scheduleSave();
	}

	function onDepthRole(e: Event) {
		depthRole = (e.currentTarget as HTMLSelectElement).value as 'system' | 'user' | 'assistant';
		scheduleSave();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			// Commit whatever is mid-typing (e.g. the Depth number input) —
			// blur fires the pending change event before the panel closes.
			(document.activeElement as HTMLElement | null)?.blur();
			onclose();
		}
	}

	function initial(n: string): string {
		return n.trim().charAt(0).toUpperCase() || '?';
	}

	// Avatar from a file, stored as a data URL (same limit as portraits)
	async function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			avatar = await readImageFile(file);
			imageError = '';
			scheduleSave();
		} catch (err) {
			imageError = (err as Error).message;
		}
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
			// Backups can be hand-edited or from another version — an invalid
			// placement would drop the persona from every prompt or break the send.
			const validPositions = ['none', 'system', 'top', 'bottom', 'depth'];
			const validRoles = ['system', 'user', 'assistant'];
			await db.personas.bulkAdd(
				list.map((p) => ({
					name: p.name || 'Imported persona',
					description: p.description ?? '',
					avatar: p.avatar ?? '',
					position: validPositions.includes(p.position ?? '') ? p.position : undefined,
					depth:
						typeof p.depth === 'number' && Number.isFinite(p.depth)
							? Math.max(0, Math.min(9999, Math.round(p.depth)))
							: undefined,
					depthRole: validRoles.includes(p.depthRole ?? '') ? p.depthRole : undefined,
					lockToCharacterId: p.lockToCharacterId,
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
	<!-- Click-catcher: ST closes the drawer on any outside click. -->
	<button
		type="button"
		aria-label="Close persona management"
		class="fixed inset-0 z-40 bg-black/40"
		transition:fade={{ duration: 150 }}
		onclick={() => onclose()}
	></button>
	<!-- ST .drawer-content geometry: centered, floating below the top bar
	     (the AppBar is h-14), blurred tile with a viewport-bound height. -->
	<div class="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center px-3">
		<div
			class="pointer-events-auto max-h-[calc(100dvh-4rem)] w-[min(768px,100%)] origin-top overflow-y-auto rounded-lg border border-border bg-surface/95 p-3 shadow-lw-3 backdrop-blur-xl"
			transition:scale={{ start: 0.97, duration: 160 }}
			role="dialog"
			aria-label="Persona Management"
		>
			<header class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h3 class="m-0 text-lg">Persona Management</h3>
				<div class="flex items-center gap-2">
					<button type="button" class="ghost px-3 py-1.5" onclick={backup} title="Backup your personas to a file">Backup</button>
					<button type="button" class="ghost px-3 py-1.5" onclick={() => restoreInput?.click()} title="Restore your personas from a file">Restore</button>
					<input bind:this={restoreInput} type="file" accept=".json" class="hidden" onchange={restore} />
					<button type="button" class="ghost px-3 py-1.5" onclick={() => onclose()}>Close</button>
				</div>
			</header>

			<div class="grid gap-4 md:grid-cols-2">
				<!-- Left column (ST persona_management_left_column) -->
				<div class="flex min-w-0 flex-col gap-2 md:border-r border-hairline md:pr-4">
					<div class="flex flex-wrap items-center gap-2">
						<button type="button" class="px-3 py-1.5" onclick={() => createDummy()} title="Create a dummy persona">Create</button>
						<button
							type="button"
							class="ghost px-3 py-1.5"
							onclick={() => applyPersona(undefined)}
							aria-pressed={activeId == null}
							title="Speak without a persona in this chat"
						>
							No persona
						</button>
					</div>
					<input
						type="search"
						bind:value={search}
						oninput={() => (page = 1)}
						placeholder="Search..."
						class="w-full"
					/>
					<div class="flex items-center gap-2">
						<select
							aria-label="Sort personas"
							value={search.trim() ? 'search' : sortOrder}
							onchange={onSort}
							class="w-auto px-2 py-1.5"
						>
							{#if search.trim()}<option value="search">Search</option>{/if}
							<option value="asc">A-Z</option>
							<option value="desc">Z-A</option>
						</select>
					</div>

					<!-- ST pagination: `< 1-5 .. 12 >` with a page-size changer -->
					<div class="flex items-center justify-between gap-2" id="persona_pagination_container">
						<div class="flex items-center gap-1">
							<button type="button" class="ghost px-2.5 py-1" onclick={() => (page -= 1)} disabled={page <= 1} aria-label="Previous page">&lt;</button>
							<span class="text-sm text-dim">{pageRange}</span>
							<button type="button" class="ghost px-2.5 py-1" onclick={() => (page += 1)} disabled={page >= totalPages} aria-label="Next page">&gt;</button>
						</div>
						<div class="flex items-center gap-2">
							<select
								aria-label="Personas per page"
								value={perPage}
								onchange={(e) => {
									perPage = Number((e.currentTarget as HTMLSelectElement).value);
									page = 1;
								}}
								class="w-auto px-1.5 py-1"
							>
								{#each [5, 10, 25, 50, 100, 250, 500, 1000] as n}
									<option value={n}>{n}</option>
								{/each}
							</select>
							<button
								type="button"
								class="ghost grid size-8 place-items-center p-0"
								onclick={() => (gridView = !gridView)}
								aria-pressed={gridView}
								aria-label="Toggle grid view"
								title="Toggle grid view"
							>
								<Icon name="grid" class="size-4" />
							</button>
						</div>
					</div>

					<!-- Avatar block: "+" tile first (ST avatar_upload), then one tile per persona -->
					<div class="min-h-0 {gridView ? 'grid grid-cols-3 gap-2' : 'flex flex-col gap-1.5'}">
						<button
							type="button"
							class="grid size-14 shrink-0 place-items-center rounded-full border border-dashed border-border bg-transparent text-dim hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent {gridView ? 'self-center justify-self-center' : ''}"
							onclick={() => uploadInput?.click()}
							title="Create a persona from an image"
							aria-label="Create a persona from an image"
						>
							<Icon name="plus" class="size-6" />
						</button>
						<input bind:this={uploadInput} type="file" accept="image/*" class="hidden" onchange={onUploadCreate} />

						{#each pageItems as p (p.id)}
							{@const isActive = p.id === activeId}
							{@const isDefault = settings.defaultPersonaId === p.id}
							{@const isCharLocked = characterId != null && p.lockToCharacterId === characterId}
							<button
								type="button"
								onclick={() => pick(p)}
								aria-pressed={isActive}
								class="flex w-full items-center gap-3 rounded-lg border px-2 py-1.5 text-left transition-colors duration-lw-fast focus-visible:outline-2 focus-visible:outline-accent {gridView ? 'flex-col text-center' : ''} {selectedId === p.id
									? 'border-text/70 bg-surface-2'
									: 'border-transparent bg-transparent hover:bg-surface-2'}"
							>
								<span
									class="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-dim {isDefault
										? 'outline-2 outline-offset-2 outline-accent'
										: ''}"
								>
									{#if p.avatar}
										<img src={p.avatar} alt="" class="size-full object-cover" />
									{:else}
										<span class="font-display">{initial(p.name)}</span>
									{/if}
								</span>
								<span class="min-w-0 flex-1 {gridView ? 'w-full' : ''}">
									<span class="block truncate text-text">{p.name}</span>
									{#if !gridView}
										<span class="block truncate text-sm text-dim">{p.description || '[No description]'}</span>
									{/if}
									{#if isCharLocked || isActive}
										<span class="mt-0.5 flex gap-1 text-sm">
											{#if isCharLocked}<span class="rounded border border-hairline px-1 text-dim" title="Locked to this character">Character</span>{/if}
											{#if isActive}<span class="rounded border border-hairline px-1 text-accent" title="Active in this chat">Chat</span>{/if}
										</span>
									{/if}
								</span>
							</button>
						{/each}

						{#if visible.length === 0}
							<p class="m-0 text-sm text-dim {gridView ? 'col-span-full' : ''}">No personas match. Create one to speak as someone in your chats.</p>
						{/if}
					</div>
				</div>

				<!-- Right column: the current persona (ST persona_management_right) -->
				<div class="min-w-0">
					{#if safeSelected}
						<h4 class={standout}>Current Persona</h4>
						<div class="mb-2 flex items-center gap-2">
							<h5 class="m-0 min-w-0 flex-1 truncate text-lg font-semibold text-dim" id="your_name">{name.trim() || 'Unnamed persona'}</h5>
							<div class="flex shrink-0 items-center gap-1" id="persona_controls">
								<button type="button" class="ghost grid size-8 place-items-center p-0" onclick={rename} title="Rename Persona" aria-label="Rename Persona"><Icon name="pencil" class="size-4" /></button>
								<button type="button" class="ghost grid size-8 place-items-center p-0" onclick={() => avatarInput?.click()} title="Change Persona Image" aria-label="Change Persona Image"><Icon name="image" class="size-4" /></button>
								<button type="button" class="ghost grid size-8 place-items-center p-0" onclick={duplicate} title="Duplicate Persona" aria-label="Duplicate Persona"><Icon name="copy" class="size-4" /></button>
								<button type="button" class="danger grid size-8 place-items-center p-0" onclick={remove} title="Delete Persona" aria-label="Delete Persona"><Icon name="skull" class="size-4" /></button>
							</div>
							<input bind:this={avatarInput} type="file" accept="image/*" class="hidden" onchange={onFile} />
						</div>

						<label class="mb-2 flex flex-col gap-1 text-sm text-dim">
							Avatar (image URL)
							<input bind:value={avatar} oninput={scheduleSave} placeholder="https://… or use the image button" autocomplete="off" />
						</label>

						<form class="grid gap-3" onsubmit={(e) => { e.preventDefault(); saveNow(); onclose(); }}>
							<label class="flex flex-col gap-1 text-sm text-dim">
								Persona Description
								<textarea
									bind:value={description}
									oninput={scheduleSave}
									rows="8"
									autocomplete="off"
									placeholder={"Example:\n[{{user}} is a 28-year-old Romanian cat girl.]"}
								></textarea>
							</label>

							<div class="flex items-center justify-between gap-2">
								<h4 class="m-0 mb-0 text-sm font-semibold">Position</h4>
								<span class="text-sm text-dim">Tokens: {tokens.toLocaleString()}</span>
							</div>
							<label class="flex flex-col gap-1 text-sm text-dim">
								Where this persona's description goes in the prompt
								<select value={position} onchange={onPosition}>
									<option value="none">None (disabled)</option>
									<option value="system">In Story String / Prompt Manager</option>
									<option value="top">Top of Author's Note</option>
									<option value="bottom">Bottom of Author's Note</option>
									<option value="depth">In-chat @ Depth</option>
								</select>
							</label>
							{#if position === 'depth'}
								<div class="flex items-end gap-2">
									<label class="min-w-0 flex-1 text-sm text-dim">
										Depth
										<input type="number" min="0" max="9999" step="1" value={depth} onchange={onDepth} />
									</label>
									<label class="min-w-0 flex-1 text-sm text-dim">
										Role
										<select value={depthRole} onchange={onDepthRole}>
											<option value="system">System</option>
											<option value="user">User</option>
											<option value="assistant">Assistant</option>
										</select>
									</label>
								</div>
							{/if}

							<div>
								<h4 class={standout}>Connections</h4>
								<div class="flex flex-wrap items-center gap-2" id="persona_connections_buttons">
									<button
										type="button"
										class="ghost inline-flex items-center gap-1.5 px-3 py-1.5 {settings.defaultPersonaId === safeSelected.id ? 'border-accent text-accent' : ''}"
										onclick={toggleDefault}
										aria-pressed={settings.defaultPersonaId === safeSelected.id}
										title="Click to select this as default persona for the new chats. Click again to remove it."
									>
										<Icon name="crown" class="size-4" />Default
									</button>
									{#if characterId != null}
										<button
											type="button"
											class="ghost inline-flex items-center gap-1.5 px-3 py-1.5 {safeSelected.lockToCharacterId === characterId ? 'border-accent text-accent' : ''}"
											onclick={toggleCharacterLock}
											aria-pressed={safeSelected.lockToCharacterId === characterId}
											title="Click to lock your selected persona to the current character. Click again to remove the lock."
										>
											<Icon name="lock" class="size-4" />Character
										</button>
									{/if}
									<button
										type="button"
										class="ghost inline-flex items-center gap-1.5 px-3 py-1.5 {activeId === safeSelected.id ? 'border-accent text-accent' : ''}"
										onclick={toggleChatLock}
										aria-pressed={activeId === safeSelected.id}
										title="Click to lock your selected persona to the current chat. Click again to remove the lock."
									>
										<Icon name="chat" class="size-4" />Chat
									</button>
								</div>
								{#if settings.defaultPersonaId === safeSelected.id || (characterId != null && safeSelected.lockToCharacterId === characterId) || activeId === safeSelected.id || connectedChats.length > 0}
									<div class="mt-1.5 flex flex-col gap-0.5 text-sm text-dim" id="persona_connections_info_block">
										{#if settings.defaultPersonaId === safeSelected.id}<span>Default persona for new chats.</span>{/if}
										{#if characterId != null && safeSelected.lockToCharacterId === characterId}<span>Locked to this character.</span>{/if}
										{#if activeId === safeSelected.id}<span>Active in this chat.</span>{/if}
										{#each connectedChats as c (c.id)}<span class="truncate">Used in: {c.title}</span>{/each}
									</div>
								{/if}
							</div>
						</form>
					{:else}
						<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">
							Select a persona to edit it, or create one.
						</div>
					{/if}

					<!-- Always visible: the "+" tile reports oversize uploads even
					     with nothing selected. -->
					{#if imageError}<p class="m-0 mb-2 text-sm text-danger">{imageError}</p>{/if}

					<!-- Global Settings (ST: exactly these three checkboxes) -->
					<div class="mt-5">
						<h4 class={standout}>Global Settings</h4>
						<div class="flex flex-col gap-1.5 text-sm text-dim">
							<label class="flex items-center gap-2">
								<input type="checkbox" class="w-auto p-0" checked={settings.personaNotifications} onchange={(e) => saveSettings({ personaNotifications: e.currentTarget.checked })} />
								Show notifications on switching personas
							</label>
							<label class="flex items-center gap-2" title="When multiple personas are connected to a character, a popup will appear to select which one to use.">
								<input type="checkbox" class="w-auto p-0" checked={settings.personaAllowMulti} onchange={(e) => saveSettings({ personaAllowMulti: e.currentTarget.checked })} />
								Allow multiple persona connections per character
							</label>
							<label class="flex items-center gap-2" title="Whenever a persona is selected, it will be locked to the current chat and automatically selected when the chat is opened.">
								<input type="checkbox" class="w-auto p-0" checked={settings.personaAutoLock} onchange={(e) => saveSettings({ personaAutoLock: e.currentTarget.checked })} />
								Auto-lock a chosen persona to the chat
							</label>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}
