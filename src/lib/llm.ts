import { settings } from './state/settings.svelte';
import type { Role } from './types';

export interface ApiMessage {
	role: Role | 'user' | 'assistant';
	content: string;
}

export interface StreamCallbacks {
	onDelta: (text: string) => void;
	onDone: (full: string) => void;
	onError: (err: Error) => void;
}

// Streams a chat completion from any OpenAI-compatible endpoint:
//   - OpenAI:           https://api.openai.com/v1
//   - Ollama:           http://localhost:11434/v1
//   - llama.cpp server: http://localhost:8080/v1
//   - KoboldCpp:        http://localhost:5001/v1
// Just change baseUrl + model in Settings — no code changes.
export async function streamChat(
	messages: ApiMessage[],
	signal: AbortSignal,
	cb: StreamCallbacks
): Promise<void> {
	const base = settings.baseUrl.replace(/\/+$/, '');
	const url = `${base}/chat/completions`;

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
			},
			body: JSON.stringify({
				model: settings.model,
				messages,
				stream: true
			}),
			signal
		});

		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let full = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) continue;
				const data = trimmed.slice(5).trim();
				if (data === '[DONE]') {
					cb.onDone(full);
					return;
				}
				try {
					const json = JSON.parse(data);
					const delta: string = json.choices?.[0]?.delta?.content ?? '';
					if (delta) {
						full += delta;
						cb.onDelta(delta);
					}
				} catch {
					// partial JSON across chunks — ignore, the next read fills it in
				}
			}
		}
		cb.onDone(full);
	} catch (err) {
		if ((err as Error).name === 'AbortError') return;
		cb.onError(err as Error);
	}
}
