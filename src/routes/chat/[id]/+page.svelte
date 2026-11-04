<script lang="ts">
	import { setAppbar } from '$lib/state/appbar.svelte';
	import { db } from '$lib/db';
	import { streamChat } from '$lib/llm';
	import { buildPromptMessages } from '$lib/prompt';
	import { settings } from '$lib/state/settings.svelte';
	import type { Character, Chat, ChatMessage } from '$lib/types';

	let { data } = $props();

	let chat = $state<Chat | null>(null);
	let character = $state<Character | null>(null);

	$effect(() => {
		if (character) setAppbar({ title: character.name, subtitle: character.model || settings.model, avatar: character.image ?? '', search: false, actions: [] });
	});
	let messages = $state<ChatMessage[]>([]);
	let loadError = $state('');
	let input = $state('');
	let streaming = $state(false);
	let streamingText = $state('');
	let error = $state('');
	let controller: AbortController | null = null;

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
		streaming = true;
		streamingText = '';
		error = '';
		controller = new AbortController();

		const prompt = buildPromptMessages(character, messages);

		streamChat(prompt, controller.signal, {
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
		}, character.model || undefined);
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

	let canSend = $derived(!!character && input.trim().length > 0 && !streaming);
	let needsConfig = $derived(!settings.baseUrl || !settings.model);
</script>

<div class="chat">
	<section class="conversation">
		{#if loadError}
			<div class="empty">
				<div>
					<p>{loadError}</p>
					<p><a href="/">← Back to the landing page</a></p>
				</div>
			</div>
		{:else if character}
			<div class="conv-header">
				<div class="who">Chatting with <span class="name">{character.name}</span></div>
			</div>

			<div class="messages">
				{#if needsConfig}
					<p class="hint">⚠ No model/base URL configured — set them in <a href="/settings">Settings</a>.</p>
				{/if}
				{#each messages as m (m.id)}
					<div class="msg {m.role}">
						<div class="role">{m.role === 'user' ? 'You' : character.name}</div>
						{m.content}
					</div>
				{/each}
				{#if streaming}
					<div class="msg assistant">
						<div class="role">{character.name}</div>
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
			<div class="empty"><p>Loading chat…</p></div>
		{/if}
	</section>
</div>
