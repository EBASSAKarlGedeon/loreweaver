<script lang="ts">
	import Icon from '../landing/Icon.svelte';
	import { openStudio, closeStudio, ui } from '../state/ui.svelte';
	import './studio.css';
	import { untrack } from 'svelte';
	import { testConnection, listModels, type TestResult } from '../models';
	import { connection } from '../state/connection.svelte';
	import { DEFAULT_APPEARANCE, settings, updateAppearance, saveSettings } from '../state/settings.svelte';
	import { THEMES, effectiveColors, randomPalette } from '../landing/appearance';
	import type { Appearance } from '../types';

	function onclose() {
		closeStudio();
	}

	type Tab = 'theme' | 'background' | 'layout' | 'cards' | 'advanced' | 'model';
	const TABS: { id: Tab; label: string }[] = [
		{ id: 'theme', label: 'Theme' },
		{ id: 'background', label: 'Background' },
		{ id: 'layout', label: 'Layout' },
		{ id: 'cards', label: 'Cards' },
		{ id: 'advanced', label: 'Advanced' },
		{ id: 'model', label: 'Model' }
	];

	let tab = $derived(ui.studioTab);
	const PROVIDERS = [
		{ id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
		{ id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1', model: 'llama3.1' },
		{ id: 'llamacpp', label: 'llama.cpp', url: 'http://localhost:8080/v1', model: 'local-model' },
		{ id: 'kobold', label: 'KoboldCpp', url: 'http://localhost:5001/v1', model: 'koboldcpp' }
	];
	// Model tab works on a draft so the API key is only written by an explicit Save
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

	// Refresh model suggestions when the Model tab opens. Silent on failure.
	$effect(() => {
		if (tab !== 'model') return;
		untrack(() => {
			const base = draft.baseUrl.trim();
			if (base) listModels(base, draft.apiKey.trim()).then((m) => m.length && (connection.models = m));
		});
	});
	let a = $derived(settings.appearance);
	let colors = $derived(effectiveColors(a));
	let themeJson = $state('');
	let notice = $state('');

	function set<K extends keyof Appearance>(key: K, value: Appearance[K]) {
		updateAppearance({ [key]: value } as Partial<Appearance>);
	}

	function pickTheme(id: string) {
		updateAppearance({ theme: id, accentColor: null, accent2Color: null, bgColor: null });
	}

	function randomize() {
		const p = randomPalette();
		updateAppearance({ accentColor: p.accent, accent2Color: p.accent2, bgColor: p.bg });
	}

	async function exportTheme() {
		const json = JSON.stringify($state.snapshot(settings.appearance), null, 2);
		themeJson = json;
		try {
			await navigator.clipboard.writeText(json);
			notice = 'Theme copied to clipboard.';
		} catch {
			notice = 'Copy the JSON from the box.';
		}
	}

	function importTheme() {
		try {
			const data = JSON.parse(themeJson);
			if (!data || typeof data !== 'object') throw new Error('not an object');
			const patch: Partial<Appearance> = {};
			for (const key of Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]) {
				if (key in data) (patch as Record<string, unknown>)[key] = data[key];
			}
			if (Object.keys(patch).length === 0) throw new Error('no known settings');
			updateAppearance(patch);
			notice = `Theme imported (${Object.keys(patch).length} settings).`;
		} catch (err) {
			notice = `Invalid theme JSON: ${(err as Error).message}`;
		}
	}

	function resetLook() {
		updateAppearance({ ...structuredClone(DEFAULT_APPEARANCE) });
		notice = 'Appearance reset.';
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<aside class="landing lw-studio" aria-label="Studio">
>
	<div class="stlp-settings" role="dialog" aria-label="Studio">
		<div class="stlp-settings-head">
			<div>
				<h3 class="stlp-settings-title">Studio</h3>
				<span class="stlp-settings-subtitle">Look, layout and model. Changes save automatically.</span>
			</div>
			<button class="stlp-icon-btn stlp-settings-close" type="button" title="Close" onclick={onclose}>
				<Icon name="close" />
			</button>
		</div>

		<div class="stlp-tabs" role="tablist">
			{#each TABS as t (t.id)}
				<button
					type="button"
					role="tab"
					class:active={tab === t.id}
					aria-selected={tab === t.id}
					onclick={() => openStudio(t.id)}
				>
					{t.label}
				</button>
			{/each}
		</div>

		<div class="stlp-settings-body">
			{#if tab === 'theme'}
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Presets</div>
					<div class="stlp-swatches">
						{#each THEMES as t (t.id)}
							<button
								type="button"
								class="stlp-swatch"
								class:active={!a.accentColor && !a.accent2Color && !a.bgColor && a.theme === t.id}
								title={t.label}
								style="--sw-a: {t.accent}; --sw-b: {t.accent2}; --sw-bg: {t.bg}"
								onclick={() => pickTheme(t.id)}
							>
								<span class="stlp-swatch-preview"><span></span></span>
								<span class="stlp-swatch-label">{t.label}</span>
							</button>
						{/each}
					</div>
				</div>

				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">
						Custom colors
						<button class="stlp-chip-btn" type="button" onclick={randomize}>Randomize</button>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Accent</span>
						<input type="color" value={colors.accent} oninput={(e) => set('accentColor', e.currentTarget.value)} />
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">
							Secondary accent
							<small>Second stop of gradients and glows</small>
						</span>
						<input type="color" value={colors.accent2} oninput={(e) => set('accent2Color', e.currentTarget.value)} />
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Base background</span>
						<input type="color" value={colors.bg} oninput={(e) => set('bgColor', e.currentTarget.value)} />
					</div>
				</div>

				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Typography</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Font</span>
						<select value={a.font} onchange={(e) => set('font', e.currentTarget.value as Appearance['font'])}>
							<option value="luxury">Luxury (Fraunces and Manrope)</option>
							<option value="system">System sans</option>
							<option value="serif">Serif</option>
							<option value="rounded">Rounded</option>
							<option value="mono">Monospace</option>
						</select>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Text size</span>
						<span class="stlp-range">
							<input type="range" min="80" max="130" step="5" value={a.fontScale} oninput={(e) => set('fontScale', Number(e.currentTarget.value))} />
							<output>{a.fontScale}%</output>
						</span>
					</div>
				</div>
			{:else if tab === 'background'}
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Source</div>
					<div class="stlp-segmented">
						{#each [['gradient', 'Aurora'], ['solid', 'Solid'], ['image', 'Image URL']] as [id, label] (id)}
							<button type="button" class:active={a.bgMode === id} onclick={() => set('bgMode', id as Appearance['bgMode'])}>{label}</button>
						{/each}
					</div>
					{#if a.bgMode === 'image'}
						<input
							class="stlp-text-input"
							type="text"
							placeholder="https://… or /images/name.jpg"
							value={a.bgImageUrl}
							oninput={(e) => set('bgImageUrl', e.currentTarget.value)}
						/>
					{/if}
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Effects</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">
							Darken overlay
							<small>Lower = more of the image shows through</small>
						</span>
						<span class="stlp-range">
							<input type="range" min="0" max="100" step="1" value={a.overlayOpacity} oninput={(e) => set('overlayOpacity', Number(e.currentTarget.value))} />
							<output>{a.overlayOpacity}%</output>
						</span>
					</div>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">
							Ambient glow orbs
							<small>Slowly drifting accent-colored light</small>
						</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.ambient} onchange={(e) => set('ambient', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Glass blur</span>
						<span class="stlp-range">
							<input type="range" min="0" max="40" step="1" value={a.blur} oninput={(e) => set('blur', Number(e.currentTarget.value))} />
							<output>{a.blur}px</output>
						</span>
					</div>
				</div>
			{:else if tab === 'layout'}
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Header</div>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Show welcome header</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.showHero} onchange={(e) => set('showHero', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Show stats</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.showStats} onchange={(e) => set('showStats', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
					<input
						class="stlp-text-input"
						type="text"
						placeholder="Custom title (empty = “Good evening”)"
						value={a.heroTitle}
						oninput={(e) => set('heroTitle', e.currentTarget.value)}
					/>
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Structure</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Section order</span>
						<div class="stlp-segmented">
							{#each [['chats-first', 'Chats first'], ['characters-first', 'Characters first']] as [id, label] (id)}
								<button type="button" class:active={a.sectionOrder === id} onclick={() => set('sectionOrder', id as Appearance['sectionOrder'])}>{label}</button>
							{/each}
						</div>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Density</span>
						<div class="stlp-segmented">
							{#each [['compact', 'Compact'], ['comfortable', 'Cozy'], ['spacious', 'Airy']] as [id, label] (id)}
								<button type="button" class:active={a.density === id} onclick={() => set('density', id as Appearance['density'])}>{label}</button>
							{/each}
						</div>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Chats shown in My Chats</span>
						<span class="stlp-range">
							<input type="range" min="1" max="50" step="1" value={a.chatsShown} oninput={(e) => set('chatsShown', Number(e.currentTarget.value))} />
							<output>{a.chatsShown}</output>
						</span>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Default sort</span>
						<select value={a.defaultSort} onchange={(e) => set('defaultSort', e.currentTarget.value as Appearance['defaultSort'])}>
							<option value="newest">Newest first</option>
							<option value="oldest">Oldest first</option>
							<option value="name">Name (A–Z)</option>
						</select>
					</div>
				</div>
			{:else if tab === 'cards'}
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Style</div>
					<div class="stlp-segmented">
						{#each [['glass', 'Glass'], ['solid', 'Solid'], ['outline', 'Outline'], ['neon', 'Neon']] as [id, label] (id)}
							<button type="button" class:active={a.cardStyle === id} onclick={() => set('cardStyle', id as Appearance['cardStyle'])}>{label}</button>
						{/each}
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Corner radius</span>
						<span class="stlp-range">
							<input type="range" min="0" max="32" step="1" value={a.radius} oninput={(e) => set('radius', Number(e.currentTarget.value))} />
							<output>{a.radius}px</output>
						</span>
					</div>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Hover glow</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.glow} onchange={(e) => set('glow', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Animations</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.animations} onchange={(e) => set('animations', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Size</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Character card width</span>
						<span class="stlp-range">
							<input type="range" min="150" max="400" step="10" value={a.cardMinWidth} oninput={(e) => set('cardMinWidth', Number(e.currentTarget.value))} />
							<output>{a.cardMinWidth}px</output>
						</span>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Character art height</span>
						<span class="stlp-range">
							<input type="range" min="140" max="520" step="10" value={a.cardHeight} oninput={(e) => set('cardHeight', Number(e.currentTarget.value))} />
							<output>{a.cardHeight}px</output>
						</span>
					</div>
					<div class="stlp-settings-row">
						<span class="stlp-settings-label">Chat card width</span>
						<span class="stlp-range">
							<input type="range" min="240" max="520" step="10" value={a.chatCardWidth} oninput={(e) => set('chatCardWidth', Number(e.currentTarget.value))} />
							<output>{a.chatCardWidth}px</output>
						</span>
					</div>
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Show on character cards</div>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Description</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.showDescription} onchange={(e) => set('showDescription', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
					<label class="stlp-settings-row">
						<span class="stlp-settings-label">Chat count badge</span>
						<span class="stlp-switch">
							<input type="checkbox" checked={a.showChatCount} onchange={(e) => set('showChatCount', e.currentTarget.checked)} />
							<span class="stlp-switch-track"><span class="stlp-switch-thumb"></span></span>
						</span>
					</label>
				</div>
			{:else if tab === 'advanced'}
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Custom CSS</div>
					<textarea
						class="stlp-textarea stlp-code"
						spellcheck="false"
						placeholder={'.landing .stlp-char-card { border-width: 2px; }'}
						value={a.customCss}
						oninput={(e) => set('customCss', e.currentTarget.value)}
					></textarea>
					<small class="stlp-settings-hint">
						Applied live. Variables: <code>--lw-accent</code>, <code>--lw-accent2</code>, <code>--lw-bg</code>, <code>--lw-radius</code>…
					</small>
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Share a theme</div>
					<textarea
						class="stlp-textarea stlp-code"
						spellcheck="false"
						placeholder="Paste a theme JSON here, then Import"
						bind:value={themeJson}
					></textarea>
					<div class="stlp-settings-actions">
						<button class="stlp-chip-btn" type="button" onclick={exportTheme}>Export (copy)</button>
						<button class="stlp-chip-btn" type="button" onclick={importTheme}>Import</button>
					</div>
				</div>
				<div class="stlp-settings-group">
					<div class="stlp-settings-group-title">Reset</div>
					<div class="stlp-settings-actions">
						<button class="stlp-chip-btn" type="button" onclick={resetLook}>Reset appearance</button>
					</div>
				</div>
				{#if notice}<small class="stlp-settings-hint">{notice}</small>{/if}
			{:else if tab === 'model'}
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
			{/if}
		</div>
	</div>
</aside>
