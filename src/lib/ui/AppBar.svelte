<script lang="ts">
	import { page } from '$app/stores';
	import Icon from '../landing/Icon.svelte';
	import { appbar } from '../state/appbar.svelte';
	import { openStudio } from '../state/ui.svelte';

	// Chats links to the chats section on the landing page
	const NAV = [
		{ href: '/', label: 'Home' },
		{ href: '/#chats', label: 'Chats' },
		{ href: '/characters', label: 'Characters' }
	];

	let path = $derived($page.url.pathname);
	let isActive = (href: string) =>
		href === '/characters' ? path.startsWith('/characters') : href === '/' ? path === '/' : false;
</script>

<header
	class="relative z-40 flex h-14 shrink-0 items-center gap-4 border-b border-hairline bg-bg/80 px-4 text-text md:px-6"
	style="backdrop-filter: blur(var(--lw-blur)); -webkit-backdrop-filter: blur(var(--lw-blur));"
>
	<a href="/" class="shrink-0 font-display text-lg tracking-wide" aria-label="LoreWeaver home">
		Lore<span class="text-accent">Weaver</span>
	</a>

	<nav aria-label="Main" class="hidden items-center gap-1 md:flex">
		{#each NAV as item (item.href)}
			<a
				href={item.href}
				aria-current={isActive(item.href) ? 'page' : undefined}
				class="rounded-md px-2.5 py-1.5 text-sm transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent {isActive(item.href) ? 'text-text' : 'text-dim'}"
			>
				{item.label}
			</a>
		{/each}
	</nav>

	<div class="flex min-w-0 flex-1 items-center gap-3">
		{#if appbar.title}
			{#if appbar.avatar}
				<img src={appbar.avatar} alt="" class="size-8 shrink-0 rounded-full object-cover" />
			{/if}
			<div class="min-w-0">
				<p class="truncate font-display text-base leading-tight">{appbar.title}</p>
				{#if appbar.subtitle}<p class="truncate text-xs text-dim">{appbar.subtitle}</p>{/if}
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
		{#each appbar.actions as action (action.label)}
			<button
				type="button"
				onclick={action.onclick}
				class="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text transition-colors duration-lw-fast hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			>
				{action.label}
			</button>
		{/each}
		<button
			type="button"
			onclick={() => openStudio()}
			title="Studio"
			aria-label="Open Studio"
			class="grid size-10 place-items-center rounded-md border-0 bg-transparent text-dim [&_svg]:size-5 transition-colors duration-lw-fast hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
		>
			<Icon name="gear" />
		</button>
	</div>
</header>
