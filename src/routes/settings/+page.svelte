<script lang="ts">
	import { settings, saveSettings } from '$lib/state/settings.svelte';
	import type { Settings } from '$lib/types';

	let form = $state<Settings>({ ...settings });
	let saved = $state(false);

	$effect(() => {
		// keep form in sync once settings load from IndexedDB
		form = { ...settings };
	});

	async function save() {
		await saveSettings(form);
		saved = true;
		setTimeout(() => (saved = false), 1500);
	}
</script>

<div class="panel">
	<h1>Settings</h1>
	<p class="hint">
		Connect LoreWeaver to any OpenAI-compatible endpoint. Change the base URL to point at a
		local model server (Ollama, llama.cpp, KoboldCpp) instead of OpenAI.
	</p>

	<form onsubmit={(e) => { e.preventDefault(); save(); }}>
		<label>
			API key
			<input type="password" bind:value={form.apiKey} placeholder="sk-… (leave blank for local servers)" />
		</label>
		<label>
			Base URL
			<input bind:value={form.baseUrl} placeholder="https://api.openai.com/v1" />
		</label>
		<label>
			Model
			<input bind:value={form.model} placeholder="gpt-4o-mini" />
		</label>
		<div class="row">
			<button type="submit">Save</button>
			{#if saved}<span class="hint" style="color: var(--ok)">Saved.</span>{/if}
		</div>
	</form>

	<h2>Common base URLs</h2>
	<ul class="hint">
		<li><strong>OpenAI</strong> — https://api.openai.com/v1</li>
		<li><strong>Ollama</strong> — http://localhost:11434/v1</li>
		<li><strong>llama.cpp server</strong> — http://localhost:8080/v1</li>
		<li><strong>KoboldCpp</strong> — http://localhost:5001/v1</li>
	</ul>
</div>
