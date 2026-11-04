// Model discovery for the Studio Model tab. Talks to the OpenAI-compatible
// GET {baseUrl}/models endpoint through the browser, so it can fail on CORS for
// local servers. Failures come back as typed results; nothing here throws to the UI.
export type TestResult =
	| { ok: true; models: string[] }
	| { ok: false; kind: 'http'; status: number }
	| { ok: false; kind: 'network' }
	| { ok: false; kind: 'timeout' };

const TIMEOUT_MS = 8000;

// Accepts the OpenAI shape ({ data: [{ id }] }) and the variants Ollama and
// KoboldCpp return ({ models: [{ name | model }] }, or plain strings).
function parseModels(json: unknown): string[] {
	const body = (json ?? {}) as { data?: unknown; models?: unknown };
	const list: unknown[] = Array.isArray(body.data)
		? body.data
		: Array.isArray(body.models)
			? body.models
			: [];
	const names = list.map((m) => {
		if (typeof m === 'string') return m;
		const o = (m ?? {}) as { id?: unknown; name?: unknown; model?: unknown };
		return o.id ?? o.name ?? o.model;
	});
	return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

export async function testConnection(baseUrl: string, apiKey: string): Promise<TestResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: controller.signal
		});
		if (!res.ok) return { ok: false, kind: 'http', status: res.status };
		const json = await res.json().catch(() => null);
		return { ok: true, models: parseModels(json) };
	} catch {
		return controller.signal.aborted ? { ok: false, kind: 'timeout' } : { ok: false, kind: 'network' };
	} finally {
		clearTimeout(timer);
	}
}

// Silent variant for the model picker: an empty list on any failure
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
	const result = await testConnection(baseUrl, apiKey);
	return result.ok ? result.models : [];
}
