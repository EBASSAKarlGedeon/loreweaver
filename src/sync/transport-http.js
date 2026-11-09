// Loreweaver sync: HTTP transport implementation.
// The only file that knows how to talk to the hub over HTTP.
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @typedef {Object} TransportResult
 * @property {boolean} ok
 * @property {number} status 0 for network-level failures
 * @property {any} [json]
 * @property {Buffer} [body]
 * @property {string} [hash] Content hash (X-Content-Hash on GET /file)
 * @property {string} [error]
 */

/**
 * @typedef {Object} Transport
 * @property {(handle: string, name: string, protocol: number) => Promise<TransportResult>} hello
 * @property {(handle: string, since: number, limit?: number) => Promise<TransportResult>} changes
 * @property {(handle: string, relPath: string) => Promise<TransportResult>} getFile
 * @property {(handle: string, relPath: string, buffer: Buffer, baseRev: number) => Promise<TransportResult>} putFile
 * @property {(handle: string, relPath: string, baseRev: number) => Promise<TransportResult>} deleteFile
 */

/**
 * Build an HTTP transport for a hub client.
 * @param {{hubUrl: string, token: string, timeoutMs?: number}} options
 * @returns {Transport}
 */
export function createHttpTransport({ hubUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const base = hubUrl.replace(/\/+$/, '');

    /**
     * Fetch wrapper with timeout and Bearer token.
     * @param {string} method
     * @param {string} url
     * @param {{headers?: Record<string, string>, body?: Buffer}} [init]
     * @returns {Promise<{ok: boolean, status: number, res: Response | null, error?: string}>}
     */
    async function call(method, url, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(base + url, {
                method,
                headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
                body: init.body,
                signal: controller.signal,
            });
            return { ok: res.ok, status: res.status, res };
        } catch (err) {
            return { ok: false, status: 0, res: null, error: err?.message ?? String(err) };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Parse a JSON body when present.
     * @param {{ok: boolean, status: number, res: Response | null, error?: string}} r
     * @returns {Promise<TransportResult>}
     */
    async function unwrapJson(r) {
        if (!r.res) {
            return { ok: false, status: 0, error: r.error ?? 'network error' };
        }
        let json;
        try {
            json = await r.res.json();
        } catch {
            json = undefined;
        }
        return { ok: r.ok, status: r.status, json, error: json?.error ?? (r.ok ? undefined : `HTTP ${r.status}`) };
    }

    return {
        async hello(handle, name, protocol) {
            const r = await call('POST', `/api/sync/hello?handle=${encodeURIComponent(handle)}`, {
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(JSON.stringify({ name, protocol })),
            });
            return unwrapJson(r);
        },
        async changes(handle, since, limit = 5000) {
            const r = await call('GET', `/api/sync/changes?handle=${encodeURIComponent(handle)}&since=${since}&limit=${limit}`);
            return unwrapJson(r);
        },
        async getFile(handle, relPath) {
            const r = await call('GET', `/api/sync/file?handle=${encodeURIComponent(handle)}&path=${encodeURIComponent(relPath)}`);
            if (!r.res) {
                return { ok: false, status: 0, error: r.error ?? 'network error' };
            }
            if (!r.ok) {
                let json;
                try { json = await r.res.json(); } catch { json = undefined; }
                return { ok: false, status: r.status, json, error: json?.error ?? `HTTP ${r.status}` };
            }
            const body = Buffer.from(await r.res.arrayBuffer());
            return { ok: true, status: r.status, body, hash: r.res.headers.get('x-content-hash') ?? undefined };
        },
        async putFile(handle, relPath, buffer, baseRev) {
            const r = await call('PUT', `/api/sync/file?handle=${encodeURIComponent(handle)}&path=${encodeURIComponent(relPath)}&baseRev=${baseRev}`, {
                headers: { 'X-Content-Hash': hashBuffer(buffer), 'Content-Type': 'application/octet-stream' },
                body: buffer,
            });
            return unwrapJson(r);
        },
        async deleteFile(handle, relPath, baseRev) {
            const r = await call('DELETE', `/api/sync/file?handle=${encodeURIComponent(handle)}&path=${encodeURIComponent(relPath)}&baseRev=${baseRev}`);
            return unwrapJson(r);
        },
    };
}

/** sha256 hex of a buffer. */
function hashBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}
