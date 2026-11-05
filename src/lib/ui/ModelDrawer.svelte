<script lang="ts">
	import Icon from '../landing/Icon.svelte';
	import { closeModel, ui } from '../state/ui.svelte';
	import './studio.css';
	import { untrack } from 'svelte';
	import { testConnection, listModels, type TestResult } from '../models';
	import { connection } from '../state/connection.svelte';
	import { settings, saveSettings } from '../state/settings.svelte';

	const PROVIDERS = [
		{ id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
		{ id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1', model: 'llama3.1' },
		{ id: 'llamacpp', label: 'llama.cpp', url: 'http://localhost:8080/v1', model: 'local-model' },
		{ id: 'kobold', label: 'KoboldCpp', url: 'http://localhost:5001/v1', model: 'koboldcpp' }
	];
	// Works on a draft so the API key is only written by an explicit Save
	let draft = $state({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model });
	let showKey = $state(false);
	let saved = $state(false);
	let testing = $state(false);
	let testMessage = $state('');
	let testOk = $state(false);
	let normalized = $derived(draft.baseUrl.trim().replace(/\/+$/, ''));
	let modelPlaceholder = $derived(PROVIDERS.find((p) => p.url === normalized)?.model ?? 'model name');

	function pickProvider(url: string) {
		draft.baseUrl = url;
	}

	async function saveModel() {
		await saveSettings({
			apiKey: draft.apiKey.trim(),
			baseUrl: draft.baseUrl.trim(),
			model: draft.model.trim()
		});
		saved = true;
		setTimeout(() => (saved = false), 2000);
	}

	function describeFailure(r: Exclude<TestResult, { ok: true }>): string {
		if (r.kind === 'http') return `The server answered with HTTP ${r.status}. Check the API key and base URL.`;
		if (r.kind === 'timeout') return 'No answer after 8 seconds. Check that the server is running.';
		return "The browser couldn't reach this URL. For local servers this is usually CORS. For Ollama, set OLLAMA_ORIGINS.";
	}

	async function testModel() {
		testing = true;
		testMessage = '';
		const r = await testConnection(draft.baseUrl.trim(), draft.apiKey.trim());
		testing = false;
		if (r.ok) {
			testOk = true;
			connection.status = 'ok';
			connection.models = r.models;
			testMessage = `Reachable. ${r.models.length} model${r.models.length === 1 ? '' : 's'} found.`;
		} else {
			testOk = false;
			connection.status = 'error';
			testMessage = describeFailure(r);
		}
	}

	// Refresh model suggestions when the drawer opens. Silent on failure.
	$effect(() => {
		if (!ui.modelOpen) return;
		untrack(() => {
			const base = draft.baseUrl.trim();
			if (base) listModels(base, draft.apiKey.trim()).then((m) => m.length && (connection.models = m));
		});
	});

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeModel();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<aside class="landing lw-studio" aria-label="Model">
	<div class="stlp-settings" role="dialog" aria-label="Model">
		<div class="stlp-settings-head">
			<div>
				<h3 class="stlp-settings-title">Model</h3>
				<span class="stlp-settings-subtitle">Provider and connection. The API key saves only when you press Save.</span>
			</div>
			<button class="stlp-icon-btn stlp-settings-close" type="button" title="Close" onclick={closeModel}>
				<Icon name="close" />
			</button>
		</div>

		<div class="stlp-settings-body">
			<div class="stlp-settings-group">
				<div class="stlp-settings-group-title">Provider</div>
				<div class="grid grid-cols-2 gap-2">
					{#each PROVIDERS as p (p.id)}
						<button
							type="button"
							aria-pressed={normalized === p.url}
							onclick={() => pickProvider(p.url)}
							class="flex flex-col items-start gap-0.5 rounded-md border bg-surface px-3 py-2.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent {normalized === p.url ? 'border-accent text-text' : 'border-border text-dim'}"
						>
							<span class="font-medium text-text">{p.label}</span>
							<span class="max-w-full truncate text-xs">{p.url}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="stlp-settings-group flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-sm">
					API key
					<span class="flex gap-2">
						<input
							class="min-w-0 flex-1"
							type={showKey ? 'text' : 'password'}
							bind:value={draft.apiKey}
							autocomplete="off"
							spellcheck="false"
						/>
						<button type="button" class="ghost" onclick={() => (showKey = !showKey)} aria-pressed={showKey}>
							{showKey ? 'Hide' : 'Show'} key
						</button>
					</span>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					Base URL
					<input bind:value={draft.baseUrl} placeholder="https://api.openai.com/v1" autocomplete="off" />
				</label>
				<label class="flex flex-col gap-1 text-sm">
					Model
					<input list="lw-models" bind:value={draft.model} placeholder={modelPlaceholder} autocomplete="off" />
					<datalist id="lw-models">
						{#each connection.models as m (m)}<option value={m}></option>{/each}
					</datalist>
				</label>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<button type="button" onclick={saveModel}>Save</button>
				<button type="button" class="ghost" onclick={testModel} disabled={testing}>
					{testing ? 'Testing…' : 'Test connection'}
				</button>
				{#if saved}<small class="stlp-settings-hint" role="status">Saved</small>{/if}
			</div>
			{#if testMessage}
				<p role="status" class="text-sm {testOk ? 'text-ok' : 'text-danger'}">{testMessage}</p>
			{/if}
		</div>
	</div>
</aside>
