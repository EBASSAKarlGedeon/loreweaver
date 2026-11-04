<script lang="ts">
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { db } from '$lib/db';
	import type { Character } from '$lib/types';

	let characters = $state<Character[]>([]);
	let editing = $state<Character | null>(null);
	let form = $state<Character>(blank());

	$effect(() => {
		setAppbar({ title: '', subtitle: '', avatar: '', search: false, actions: [{ label: 'New character', onclick: startNew }] });
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

	function edit(c: Character) {
		editing = c;
		form = { ...c };
	}

	function startNew() {
		editing = null;
		form = blank();
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
		await refresh();
	}
</script>

<div class="panel">
	<h1>Characters</h1>
	<p class="hint">A character card is the seed of every story. The description, personality, and scenario feed the system prompt; the first message opens the scene.</p>

	<h2>{editing ? 'Edit' : 'New'} character</h2>
	<form onsubmit={(e) => { e.preventDefault(); save(); }}>
		<label>
			Name
			<input bind:value={form.name} placeholder="e.g. Mira the Cartographer" />
		</label>
		<label>
			Description
			<textarea bind:value={form.description} placeholder="Who they are — appearance, history, role. Fed into the system prompt."></textarea>
		</label>
		<label>
			Personality
			<textarea bind:value={form.personality} placeholder="How they speak and behave — terse, warm, curious…"></textarea>
		</label>
		<label>
			Scenario
			<textarea bind:value={form.scenario} placeholder="The starting situation / setting."></textarea>
		</label>
		<label>
			First message
			<textarea bind:value={form.firstMessage} placeholder="The opening line the character says to begin the roleplay."></textarea>
		</label>
		<div class="row">
			<button type="submit">{editing ? 'Update' : 'Create'}</button>
			{#if editing}<button type="button" class="ghost" onclick={startNew}>Cancel edit</button>{/if}
		</div>
	</form>

	<h2>Your characters</h2>
	{#if characters.length === 0}
		<p class="hint">None yet — create one above.</p>
	{:else}
		{#each characters as c (c.id)}
			<div style="display:flex; gap:.6rem; align-items:flex-start; padding:.6rem 0; border-bottom:1px solid var(--border);">
				<div style="flex:1;">
					<strong>{c.name}</strong>
					{#if c.description}<div class="hint">{c.description.slice(0, 100)}</div>{/if}
				</div>
				<button class="ghost" onclick={() => edit(c)}>Edit</button>
				<button class="danger" onclick={() => remove(c)}>Delete</button>
			</div>
		{/each}
	{/if}
</div>
