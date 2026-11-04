<script lang="ts">
	import { tick } from 'svelte';
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { openStudio } from '$lib/state/ui.svelte';
	import { db } from '$lib/db';
	import { streamChat } from '$lib/llm';
	import { buildPromptMessages } from '$lib/prompt';
	import { settings } from '$lib/state/settings.svelte';
	import type { Character, Chat, ChatMessage } from '$lib/types';

	let { data } = $props();

	let chat = $state<Chat | null>(null);
	let character = $state<Character | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let loadError = $state('');
	let input = $state('');
	let streaming = $state(false);
	let streamingText = $state('');
	let error = $state('');
	let controller: AbortController | null = null;

	// Scroll state: auto-follow only while the reader is at the bottom
	let scroller = $state<HTMLElement>();
	let atBottom = $state(true);

	$effect(() => {
		if (character) {
			setAppbar({
				title: character.name,
				subtitle: character.model || settings.model,
				avatar: character.image ?? '',
				search: false,
				actions: []
			});
		}
	});

	$effect(() => {
		loadChat(data.chatId);
	});

	async function loadChat(id: number) {
		loadError = '';
		if (!Number.isInteger(id)) {
			loadError = 'That chat link is not valid.';
			return;
		}
		const c = await db.chats.get(id);
		if (!c) {
			loadError = 'This chat no longer exists.';
			return;
		}
		const ch = await db.characters.get(c.characterId);
		if (!ch) {
			loadError = 'The character for this chat was deleted.';
			return;
		}
		chat = c;
		character = ch;
		messages = await db.messages.where('chatId').equals(id).toArray();
	}

	function scrollToBottom() {
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
		atBottom = true;
	}

	function onScroll() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	}

	// Follow the stream while the reader is at the bottom
	$effect(() => {
		streamingText;
		messages.length;
		if (atBottom) tick().then(() => scrollToBottom());
	});

	async function send() {
		if (!character || !chat || !input.trim() || streaming) return;
		const chatId = chat.id!;

		const userMsg: ChatMessage = {
			chatId,
			role: 'user',
			content: input.trim(),
			createdAt: Date.now()
		};
		await db.messages.add(userMsg);
		await db.chats.update(chatId, { updatedAt: Date.now() });
		messages = [...messages, userMsg];
		input = '';
		resizeInput();
		streaming = true;
		streamingText = '';
		error = '';
		controller = new AbortController();
		scrollToBottom();

		const prompt = buildPromptMessages(character, messages);

		streamChat(
			prompt,
			controller.signal,
			{
				onDelta: (d) => (streamingText += d),
				onDone: async (full) => {
					const assistantMsg: ChatMessage = {
						chatId,
						role: 'assistant',
						content: full,
						createdAt: Date.now()
					};
					await db.messages.add(assistantMsg);
					messages = [...messages, assistantMsg];
					await db.chats.update(chatId, { updatedAt: Date.now() });
					streaming = false;
					streamingText = '';
					controller = null;
				},
				onError: (e) => {
					error = e.message;
					streaming = false;
					streamingText = '';
					controller = null;
				}
			},
			character.model || undefined
		);
	}

	function stop() {
		controller?.abort();
		streaming = false;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	// The composer grows with its text, up to about ten lines
	let composerEl = $state<HTMLTextAreaElement>();
	function resizeInput() {
		if (!composerEl) return;
		composerEl.style.height = 'auto';
		composerEl.style.height = `${Math.min(composerEl.scrollHeight, 240)}px`;
	}

	let canSend = $derived(!!character && input.trim().length > 0 && !streaming);
	let needsConfig = $derived(!settings.baseUrl || !settings.model);
</script>

{#if loadError}
	<div class="empty">
		<div>
			<p>{loadError}</p>
			<p><a href="/">← Back to the landing page</a></p>
		</div>
	</div>
{:else if character}
	<div class="relative flex h-full min-h-0 flex-col">
		<div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto flex max-w-[70ch] flex-col gap-6 px-4 pt-6 pb-8 md:px-0">
				{#if needsConfig && messages.length === 0}
					<p class="text-sm text-dim">
						Add a model to start chatting.
						<button type="button" class="ghost" onclick={() => openStudio('model')}>Set up model</button>
					</p>
				{/if}

				{#each messages as m (m.id)}
					{#if m.role === 'user'}
						<div class="ml-auto max-w-[85%] rounded-2xl px-4 py-2.5 leading-relaxed whitespace-pre-wrap" style="background: color-mix(in oklab, var(--lw-accent) 14%, transparent);">
							{m.content}
						</div>
					{:else}
						<div class="flex flex-col gap-1 border-b border-hairline pb-6 last:border-0">
							<p class="font-display text-base text-accent">{character.name}</p>
							<div class="leading-relaxed whitespace-pre-wrap">{m.content}</div>
						</div>
					{/if}
				{/each}

				{#if streaming}
					<div class="flex flex-col gap-1">
						<p class="font-display text-base text-accent">{character.name}</p>
						<div class="leading-relaxed whitespace-pre-wrap">{streamingText}<span class="lw-caret" aria-hidden="true"></span></div>
					</div>
				{/if}

				{#if error}
					<p class="text-sm text-danger">
						{error}
						<button type="button" class="ghost" onclick={() => openStudio('model')}>Check connection</button>
					</p>
				{/if}
			</div>
		</div>

		{#if streaming && !atBottom}
			<button
				type="button"
				onclick={scrollToBottom}
				class="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface/90 px-3 py-1.5 text-xs text-text shadow-lw-2 focus-visible:outline-2 focus-visible:outline-accent"
				style="backdrop-filter: blur(var(--lw-blur));"
			>
				Jump to latest
			</button>
		{/if}

		<div class="sticky bottom-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
			<div
				class="mx-auto flex max-w-[70ch] items-end gap-2 rounded-2xl border border-border bg-surface/80 p-2 shadow-lw-2"
				style="backdrop-filter: blur(var(--lw-blur)); -webkit-backdrop-filter: blur(var(--lw-blur));"
			>
				<textarea
					bind:this={composerEl}
					bind:value={input}
					oninput={resizeInput}
					onkeydown={onKey}
					disabled={streaming}
					rows="1"
					placeholder="Say something… (Enter to send, Shift+Enter for a new line)"
					aria-label="Message"
					class="max-h-60 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 leading-relaxed text-text placeholder:text-dim focus:outline-none"
				></textarea>
				{#if streaming}
					<button type="button" class="danger shrink-0" onclick={stop}>Stop</button>
				{:else}
					<button type="button" class="shrink-0" disabled={!canSend} onclick={send}>Send</button>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="empty"><p>Loading chat…</p></div>
{/if}
