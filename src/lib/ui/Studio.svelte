<script lang="ts">
	import Icon from '../landing/Icon.svelte';
	import { openStudio, closeStudio, ui } from '../state/ui.svelte';
	import './studio.css';
	import { DEFAULT_APPEARANCE, settings, updateAppearance } from '../state/settings.svelte';
	import { THEMES, effectiveColors, randomPalette } from '../landing/appearance';
	import type { Appearance } from '../types';

	function onclose() {
		closeStudio();
	}

	type Tab = 'theme' | 'background' | 'layout' | 'cards' | 'advanced';
	const TABS: { id: Tab; label: string }[] = [
		{ id: 'theme', label: 'Theme' },
		{ id: 'background', label: 'Background' },
		{ id: 'layout', label: 'Layout' },
		{ id: 'cards', label: 'Cards' },
		{ id: 'advanced', label: 'Advanced' }
	];

	let tab = $derived(ui.studioTab);
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
	const BACKGROUNDS = ['_black.jpg','_white.jpg','bedroom clean.jpg','bedroom cyberpunk.jpg','bedroom red.jpg','bedroom tatami.jpg','cityscape medieval market.jpg','cityscape medieval night.jpg','cityscape postapoc.jpg','forest treehouse fireworks air baloons (by kallmeflocc).jpg','japan classroom side.jpg','japan classroom.jpg','japan path cherry blossom.jpg','japan university.jpg','landscape autumn great tree.jpg','landscape beach day.png','landscape beach night.jpg','landscape mountain lake.jpg','landscape postapoc.jpg','landscape winter lake house.jpg','royal.jpg','tavern day.jpg'];
	let bgQuery = $state('');
	let bgSort = $state<'az' | 'za'>('az');
	const bgName = (f: string) => f.replace(/\.[^.]+$/, '');
	const bgUrl = (f: string) => '/backgrounds/' + encodeURIComponent(f);
	const bgList = $derived.by(() => {
		const q = bgQuery.trim().toLowerCase();
		const list = BACKGROUNDS.filter((f) => !q || bgName(f).toLowerCase().includes(q));
		return bgSort === 'za' ? [...list].reverse() : list;
	});

</script>

<svelte:window onkeydown={onWindowKey} />

<aside class="landing lw-studio" aria-label="Studio">
>
	<div class="stlp-settings" role="dialog" aria-label="Studio">
		<div class="stlp-settings-head">
			<div>
				<h3 class="stlp-settings-title">Studio</h3>
				<span class="stlp-settings-subtitle">Look and layout. Changes save automatically.</span>
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
						{#each [['gradient', 'Aurora'], ['solid', 'Solid'], ['image', 'Image']] as [id, label] (id)}
							<button type="button" class:active={a.bgMode === id} onclick={() => set('bgMode', id as Appearance['bgMode'])}>{label}</button>
						{/each}
					</div>
					{#if a.bgMode === 'image'}
						<div class="stlp-settings-row">
							<span class="stlp-settings-label">Fitting</span>
							<select value={a.bgFit} onchange={(e) => set('bgFit', e.currentTarget.value as Appearance['bgFit'])}>
								<option value="cover">Cover</option>
								<option value="contain">Contain</option>
								<option value="fill">Stretch</option>
								<option value="center">Center</option>
							</select>
						</div>
						<div class="stlp-bg-picker-tools">
							<input class="stlp-text-input" type="search" placeholder="Search…" bind:value={bgQuery} />
							<select value={bgSort} onchange={(e) => (bgSort = e.currentTarget.value as 'az' | 'za')} title="Sort backgrounds" aria-label="Sort backgrounds">
								<option value="az">A-Z</option>
								<option value="za">Z-A</option>
							</select>
						</div>
						<div class="stlp-bg-grid" role="list">
							{#each bgList as f (f)}
								{@const url = bgUrl(f)}
								<button
									type="button"
									title={bgName(f)}
																		onclick={() => set('bgImageUrl', url)}
									class="stlp-bg-thumb"
									class:active={a.bgImageUrl === url}
									style="background-image:url('{url}')"
								>
									<span class="stlp-bg-thumb-name">{bgName(f)}</span>
								</button>
							{:else}
								<p class="text-xs text-dim">No backgrounds match.</p>
							{/each}
						</div>
						<input
							class="stlp-text-input"
							type="text"
							placeholder="…or paste an image URL"
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

			{/if}
		</div>
	</div>
</aside>
