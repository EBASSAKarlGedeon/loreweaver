<script lang="ts">
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { db } from '$lib/db';
	import type { Persona } from '$lib/types';

	let personas = $state<Persona[]>([]);
	let editing = $state<Persona | null>(null);
	let form = $state<Persona>(blank());
	let sheetOpen = $state(false);
	let imageError = $state('');

	// A persona with no description still tells the model what to call the
	// user, so the name alone makes it usable.
	const tokens = (p: Persona) => Math.ceil((p.name + p.description).length / 4);

	$effect(() => {
		setAppbar({ title: '', subtitle: '', avatar: '', search: false, actions: [] });
	});

	function blank(): Persona {
		return { name: '', description: '', createdAt: 0, updatedAt: 0 };
	}

	async function refresh() {
		personas = await db.personas.orderBy('updatedAt').reverse().toArray();
	}
	$effect(() => {
		refresh();
	});

	function initial(name: string): string {
		return name.trim().charAt(0).toUpperCase() || '?';
	}

	function select(p: Persona) {
		editing = p;
		form = { ...p };
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
		const data = $state.snapshot(form);
		if (editing && editing.id != null) {
			await db.personas.update(editing.id, { ...data, updatedAt: now });
		} else {
			await db.personas.add({ ...data, createdAt: now, updatedAt: now });
		}
		startNew();
		sheetOpen = false;
		await refresh();
	}

	async function remove(p: Persona) {
		if (p.id == null) return;
		if (!confirm(`Delete "${p.name}"? Chats that used it keep their messages; new prompts just drop it.`)) return;
		await db.personas.delete(p.id);
		// Detach from chats still pointing at it; empty personaId = none.
		await db.chats.where('personaId').equals(p.id).modify({ personaId: undefined });
		if (editing?.id === p.id) startNew();
		sheetOpen = false;
		await refresh();
	}

	// Avatar from a file, stored as a data URL (same limit as character portraits)
	function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2_000_000) {
			imageError = 'Choose an image under 2 MB, or paste an image URL instead.';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			form.avatar = String(reader.result);
			imageError = '';
		};
		reader.readAsDataURL(file);
	}
</script>

<div class="pd-page">
	<section class="min-w-0">
		<header class="pd-head">
			<h1 class="pd-title">My Personas <span class="pd-count">({personas.length})</span></h1>
			<button type="button" class="pd-new" onclick={openNew}>New persona</button>
		</header>

		<p class="pd-intro">
			A persona is <em>you</em> in the story — your name, who you are, how you want to be addressed. The one you
			pick in a chat is fed to the model alongside the character card.
		</p>

		{#if personas.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center text-dim">
				No personas yet. <button type="button" class="ghost" onclick={openNew}>Create one</button>
			</div>
		{:else}
			<div class="pd-grid" role="list" aria-label="Personas">
				{#each personas as p (p.id)}
					<article class="pd-card" role="listitem" data-active={editing?.id === p.id}>
						<div class="pd-cover">
							{#if p.avatar}
								<img src={p.avatar} alt="" loading="lazy" />
							{:else}
								<span class="pd-initial">{initial(p.name)}</span>
							{/if}
						</div>
						<h2 class="pd-name" title={p.name}>{p.name}</h2>
						<p class="pd-desc">{p.description || 'No description.'}</p>
						<footer class="pd-foot">
							<span class="pd-mono">{tokens(p).toLocaleString()} tok</span>
							<span class="pd-foot-actions">
								<button type="button" class="pd-edit" onclick={() => select(p)}>Edit</button>
								<button type="button" class="pd-trash" aria-label="Delete {p.name}" onclick={() => remove(p)}>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>
								</button>
							</span>
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
			aria-label="Persona editor"
		>
			<div class="mb-4 flex items-center justify-between gap-2">
				<h2 class="font-display text-xl">{editing ? 'Edit persona' : 'New persona'}</h2>
				<button type="button" class="ghost" onclick={() => (sheetOpen = false)}>Close</button>
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
					<input bind:value={form.name} placeholder="e.g. Alex, a wandering courier" />
				</label>
				<label class="flex flex-col gap-1 text-sm text-dim">
					Avatar (image URL)
					<input bind:value={form.avatar} placeholder="https://… or choose a file below" autocomplete="off" />
				</label>
				<label class="flex flex-col gap-1 text-sm text-dim">
					Or choose a file (under 2 MB)
					<input type="file" accept="image/*" onchange={onFile} />
				</label>
				{#if imageError}<p class="text-sm text-danger">{imageError}</p>{/if}
				<label class="flex flex-col gap-1 text-sm text-dim">
					Description
					<textarea bind:value={form.description} placeholder="Who you are in the fiction: appearance, history, speech style. Fed into the prompt as the user's identity."></textarea>
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
	.pd-page { display: grid; gap: 28px; padding: 24px; max-width: 1800px; margin: 0 auto; }
	.pd-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
	.pd-title { font: 500 44px/1.1 var(--lw-font-display); }
	.pd-count { font-size: 32px; color: var(--lw-text-dim); }
	.pd-intro { max-width: 60ch; color: var(--lw-text-dim); font-size: 14px; margin: 0 0 20px; }
	.pd-new { display: inline-flex; align-items: center; gap: 8px; background: var(--lw-accent); color: var(--lw-on-accent); border: 0; border-radius: 8px; padding: 10px 16px; font: 600 14px var(--lw-font); cursor: pointer; box-shadow: 0 0 22px color-mix(in oklab, var(--lw-accent) 45%, transparent); }
	.pd-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
	@media (min-width: 1300px) { .pd-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
	.pd-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid color-mix(in oklab, var(--lw-accent) 28%, var(--lw-border)); background: linear-gradient(180deg, var(--lw-surface-2), var(--lw-surface)); box-shadow: 0 0 24px color-mix(in oklab, var(--lw-accent) 14%, transparent); backdrop-filter: blur(var(--lw-blur)); min-width: 0; }
	.pd-card[data-active='true'] { border-color: var(--lw-accent); }
	.pd-cover { position: relative; aspect-ratio: 1; margin: 0 -12px; overflow: hidden; background: var(--lw-bg); display: grid; place-items: center; }
	.pd-cover img { width: 100%; height: 100%; object-fit: cover; }
	.pd-initial { font: 500 56px var(--lw-font-display); color: var(--lw-text-dim); }
	.pd-name { font: 500 15px/1.3 Inter, var(--lw-font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pd-desc { font-size: 12px; color: var(--lw-text-dim); margin: 0; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
	.pd-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--lw-border); padding-top: 10px; }
	.pd-foot-actions { display: flex; align-items: center; gap: 4px; }
	.pd-mono { font: 12px/1 'JetBrains Mono', ui-monospace, Consolas, monospace; color: var(--lw-text-dim); }
	.pd-edit { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--lw-border); background: transparent; color: var(--lw-text); border-radius: 8px; padding: 6px 14px; font: 700 16px Inter, var(--lw-font); cursor: pointer; }
	.pd-edit:hover { border-color: var(--lw-accent); }
	.pd-trash { background: transparent; border: 0; color: var(--lw-danger); cursor: pointer; padding: 6px; border-radius: 8px; }
	.pd-trash:hover { background: color-mix(in oklab, var(--lw-danger) 15%, transparent); }
	@media (max-width: 600px) { .pd-title { font-size: 34px; } .pd-count { font-size: 24px; } }
</style>