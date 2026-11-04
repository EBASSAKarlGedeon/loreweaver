<script lang="ts">
	import { db } from '$lib/db';
	import { streamChat } from '$lib/llm';
	import { buildPromptMessages } from '$lib/prompt';
	import { settings } from '$lib/state/settings.svelte';
	import type { Character, Chat, ChatMessage } from '$lib/types';

	let characters = $state<Character[]>([]);
	let selected = $state<Character | null>(null);
	let currentChat = $state<Chat | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let streamingText = $state('');
	let error = $state('');
	let controller: AbortController | null = null;

	$effect(() => {
		db.characters.orderBy('updatedAt').reverse().toArray().then((c) => (characters = c));
	});

	async function selectCharacter(c: Character) {
		if (c.id == null) return;
		selected = c;
		error = '';

		let chat = await db.chats.where('characterId').equals(c.id).first();
		if (!chat) {
			const id = await db.chats.add({
				characterId: c.id,
				title: c.name,
				createdAt: Date.now(),
				updatedAt: Date.now()
			});
			chat = (await db.chats.get(id)) ?? undefined;
			if (chat && c.firstMessage) {
				await db.messages.add({
					chatId: chat.id!,
					role: 'assistant',
					content: c.firstMessage,
					createdAt: Date.now()
				});
			}
		}
		currentChat = chat ?? null;
		if (currentChat) {
			messages = await db.messages.where('chatId').equals(currentChat.id!).toArray();
		}
	}

	async function send() {
		if (!selected || !currentChat || !input.trim() || streaming) return;

		const userMsg: ChatMessage = {
			chatId: currentChat.id!,
			role: 'user',
			content: input.trim(),
			createdAt: Date.now()
		};
		await db.messages.add(userMsg);
		messages = [...messages, userMsg];
		input = '';
		streaming = true;
		streamingText = '';
		error = '';
		controller = new AbortController();

		const prompt = buildPromptMessages(selected, messages);

		streamChat(prompt, controller.signal, {
			onDelta: (d) => (streamingText += d),
			onDone: async (full) => {
				const assistantMsg: ChatMessage = {
					chatId: currentChat!.id!,
					role: 'assistant',
					content: full,
					createdAt: Date.now()
				};
				await db.messages.add(assistantMsg);
				messages = [...messages, assistantMsg];
				await db.chats.update(currentChat!.id!, { updatedAt: Date.now() });
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
		});
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

	let canSend = $derived(!!selected && input.trim().length > 0 && !streaming);
	let needsConfig = $derived(!settings.baseUrl || !settings.model);
</script>

<div class="chat">
	<aside class="sidebar">
		<h3>Characters</h3>
		<div class="char-list">
			{#if characters.length === 0}
				<p class="hint">No characters yet. <a href="/characters">Create one →</a></p>
			{:else}
				{#each characters as c (c.id)}
					<button
						class="char-item"
						class:active={selected?.id === c.id}
						onclick={() => selectCharacter(c)}
					>
						<strong>{c.name}</strong>
						{#if c.personality}<div class="hint">{c.personality.slice(0, 60)}</div>{/if}
					</button>
				{/each}
			{/if}
		</div>
	</aside>

	<section class="conversation">
		{#if selected}
			<div class="conv-header">
				<div class="who">Chatting with <span class="name">{selected.name}</span></div>
			</div>

			<div class="messages">
				{#if needsConfig}
					<p class="hint">⚠ No model/base URL configured — set them in <a href="/settings">Settings</a>.</p>
				{/if}
				{#each messages as m (m.id)}
					<div class="msg {m.role}">
						<div class="role">{m.role === 'user' ? 'You' : selected.name}</div>
						{m.content}
					</div>
				{/each}
				{#if streaming}
					<div class="msg assistant">
						<div class="role">{selected.name}</div>
						{streamingText}<span class="hint">…</span>
					</div>
				{/if}
				{#if error}<p class="error">{error}</p>{/if}
			</div>

			<div class="composer">
				<textarea
					placeholder="Say something… (Enter to send, Shift+Enter for newline)"
					bind:value={input}
					onkeydown={onKey}
					disabled={streaming}
				></textarea>
				{#if streaming}
					<button class="danger" onclick={stop}>Stop</button>
				{:else}
					<button disabled={!canSend} onclick={send}>Send</button>
				{/if}
			</div>
		{:else}
			<div class="empty">
				<div>
					<p>Select a character on the left to begin a story.</p>
					<p><a href="/characters">Create your first character →</a></p>
				</div>
			</div>
		{/if}
	</section>
</div>
