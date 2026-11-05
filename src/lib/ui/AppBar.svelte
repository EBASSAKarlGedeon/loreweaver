<script lang="ts">
	import { page } from '$app/stores';
	import Icon from '../landing/Icon.svelte';
	import { appbar } from '../state/appbar.svelte';
	import { settings } from '../state/settings.svelte';
	import { connection } from '../state/connection.svelte';
	import { openModel, openPersona, openStudio } from '../state/ui.svelte';

	// Chats links to the chats section on the landing page
	const NAV = [
		{ href: '/', label: 'Home', icon: 'home' },
		{ href: '/#chats', label: 'Chats', icon: 'chat' },
		{ href: '/characters', label: 'Characters', icon: 'users' }
	] as const;

	let path = $derived($page.url.pathname);
	let isActive = (href: string) =>
		href === '/characters' ? path.startsWith('/characters') : href === '/' ? path === '/' : false;
	let activeIndex = $derived(NAV.findIndex((n) => isActive(n.href)));

	// Sliding brass underline under the active link (desktop nav)
	let links: HTMLAnchorElement[] = $state([]);
	let indicator = $state({ left: 0, width: 0, on: false });
	function measure() {
		const el = activeIndex >= 0 ? links[activeIndex] : undefined;
		indicator = el
			? { left: el.offsetLeft, width: el.offsetWidth, on: true }
			: { ...indicator, on: false };
	}
	// Re-measure when the active route changes, the window resizes, and after the
	// webfonts load (they change link widths, so a measure before that is stale).
	$effect(() => {
		activeIndex;
		links.length;
		measure();
	});
	$effect(() => {
		document.fonts?.ready.then(measure);
	});
</script>

<svelte:window onresize={measure} />

<header
	class="relative z-40 flex h-14 shrink-0 items-center gap-2 border-b md:gap-4 border-hairline bg-bg/80 px-4 text-text md:px-6"
	style="backdrop-filter: blur(var(--lw-blur)); -webkit-backdrop-filter: blur(var(--lw-blur));"
>
	<a href="/" class="shrink-0 font-display text-lg tracking-wide" aria-label="LoreWeaver home">
		Lore<span class="text-accent">Weaver</span>
	</a>

	<nav aria-label="Main" class="relative hidden items-center gap-1 md:flex">
		{#each NAV as item, i (item.href)}
			<a
				bind:this={links[i]}
				href={item.href}
				aria-current={isActive(item.href) ? 'page' : undefined}
				class="rounded-md px-2.5 py-1.5 text-sm transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent {isActive(item.href) ? 'text-text' : 'text-dim'}"
			>
				{item.label}
			</a>
		{/each}
		<span
			aria-hidden="true"
			class="pointer-events-none absolute -bottom-[7px] left-0 h-0.5 rounded-full bg-accent transition-[transform,width,opacity] duration-lw ease-lw motion-reduce:transition-none {settings.appearance.animations ? '' : '!transition-none'}"
			style="transform: translateX({indicator.left}px); width: {indicator.width}px; opacity: {indicator.on ? 1 : 0};"
		></span>
	</nav>

	<div class="flex min-w-0 flex-1 items-center gap-3 md:ml-2 md:border-l md:border-hairline md:pl-4">
		{#if appbar.title}
			{#if appbar.avatar}
				<img src={appbar.avatar} alt="" class="size-8 shrink-0 rounded-full object-cover" />
			{/if}
			<div class="min-w-0">
				<p class="m-0 truncate font-display text-base leading-tight">{appbar.title}</p>
				{#if appbar.subtitle}<p class="m-0 truncate text-xs text-dim">{appbar.subtitle}</p>{/if}
			</div>
		{/if}

		{#if appbar.search}
			<label class="relative ml-auto w-full max-w-sm">
				<span class="sr-only">Search characters</span>
				<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-dim">
					<Icon name="search" />
				</span>
				<input
					id="lw-search"
					type="search"
					autocomplete="off"
					placeholder="Search characters  ( / )"
					bind:value={appbar.query}
					onkeydown={(e) => {
						if (e.key === 'Escape') e.currentTarget.blur();
					}}
					class="w-full rounded-md border border-border bg-surface py-1.5 pr-3 pl-9 text-sm text-text placeholder:text-dim focus-visible:outline-2 focus-visible:outline-accent"
				/>
			</label>
		{/if}
	</div>

	<div class="flex shrink-0 items-center gap-1">
		{#if settings.model}
			<button
				type="button"
				onclick={() => openModel()}
				title="Model: {settings.model}"
				class="flex min-w-0 max-w-28 items-center gap-2 rounded-md sm:max-w-40 border border-border bg-surface px-2.5 py-1.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-accent"
			>
				<span
					aria-hidden="true"
					class="size-2 shrink-0 rounded-full {connection.status === 'ok' ? 'bg-ok' : connection.status === 'error' ? 'bg-danger' : 'bg-dim'}"
				></span>
				<span class="truncate">{settings.model}</span>
			</button>
		{:else}
			<button
				type="button"
				onclick={() => openModel()}
				class="rounded-md border border-accent px-2.5 py-1.5 text-xs text-accent focus-visible:outline-2 focus-visible:outline-accent"
			>
				Set up model
			</button>
		{/if}
		{#each appbar.actions as action (action.label)}
			<button
				type="button"
				onclick={action.onclick}
				aria-label={action.label}
				class="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-text sm:px-3 transition-colors duration-lw-fast hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			>
				<span class="sm:hidden" aria-hidden="true">+</span>
				<span class="hidden sm:inline">{action.label}</span>
			</button>
		{/each}
		<button
			type="button"
			onclick={() => openPersona()}
			title="Personas"
			aria-label="Persona Management"
			class="grid size-10 place-items-center rounded-md border-0 bg-transparent text-dim transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-5"
		>
			<Icon name="user" />
		</button>
		<button
			type="button"
			onclick={() => openModel()}
			title="Model connection"
			aria-label="Model connection"
			class="grid size-10 place-items-center rounded-md border-0 bg-transparent text-dim transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-5"
		>
			<Icon name="plug" />
		</button>
		<button
			type="button"
			onclick={() => openStudio()}
			title="Studio"
			aria-label="Open Studio"
			class="grid size-10 place-items-center rounded-md border-0 bg-transparent text-dim transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-5"
		>
			<Icon name="gear" />
		</button>
	</div>
</header>

<!-- Mobile: bottom tab bar. Respects the iOS home indicator. -->
<nav
	aria-label="Main"
	class="fixed inset-x-0 bottom-0 z-40 flex border-t border-hairline bg-bg/90 pb-[env(safe-area-inset-bottom)] md:hidden"
	style="backdrop-filter: blur(var(--lw-blur)); -webkit-backdrop-filter: blur(var(--lw-blur));"
>
	{#each NAV as item (item.href)}
		<a
			href={item.href}
			aria-current={isActive(item.href) ? 'page' : undefined}
			class="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs [&_svg]:size-5 focus-visible:outline-2 focus-visible:outline-accent {isActive(item.href) ? 'text-accent' : 'text-dim'}"
		>
			<Icon name={item.icon} />
			{item.label}
		</a>
	{/each}
	<button
		type="button"
		onclick={() => openStudio()}
		class="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 border-0 bg-transparent text-xs [&_svg]:size-5 text-dim focus-visible:outline-2 focus-visible:outline-accent"
	>
		<Icon name="gear" />
		Studio
	</button>
</nav>
