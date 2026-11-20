// [rpge-patch 024] SD-follow — the RPG engine follows the user's Image Generation
// extension settings. Instead of mirroring ~25 per-source payload builders into the
// engine (upstream code, drifts on every pull), a Loreweaver-owned endpoint reads the
// user's saved `extension_settings.sd` from settings.json and replays the exact
// request the chat-side extension would send for the configured source.
//
// Contract (agreed with the user): "if it works in Loreweaver chat, it works in the
// engine." Wave 1 mirrors the ComfyUI source (the user's target — ComfyUI runs on
// their own PC, reached by the server over Tailscale). Other sources answer with a
// clear "not mirrored yet" message instead of failing silently.
//
// Prompt recipes are deliberately NOT mirrored: the engine has its own prompt stage
// (it reads live game state). Only the IMAGE stage (renderer + its config) follows.
// The user/character avatar placeholders substitute a 1×1 pixel — the same fallback
// the extension uses when an avatar fetch fails (the engine has no chat character
// context; wave 2 can pass the hero portrait through).
//
// The ComfyUI polling logic below is a faithful port of the upstream handler in
// `stable-diffusion.js` (comfy.post('/generate'), AGPL-3.0, © SillyTavern contributors),
// duplicated so upstream files stay untouched.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { delay } from '../util.js';

const SETTINGS_FILE = 'settings.json';
// Same 1×1 transparent PNG the chat-side extension uses as its avatar fallback.
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// The placeholders the extension's generateComfyImage() substitutes, in its order.
const COMFY_PLACEHOLDERS = ['model', 'vae', 'sampler', 'scheduler', 'steps', 'scale', 'width', 'height'];

/**
 * Maps the engine's aspect to concrete width/height for the workflow's
 * %width%/%height% placeholders. Base dims come from the extension settings; the
 * aspect only re-orients them (portrait = shorter side across, longer side up),
 * so the user keeps pixel control (e.g. 832×1216 for an SDXL checkpoint).
 * @param {{width?: number, height?: number}} sd
 * @param {string} aspect "portrait" | "landscape" | "square" ("" = keep settings dims)
 */
export function aspectDims(sd, aspect) {
    const w = Number(sd?.width) > 0 ? Math.round(Number(sd.width)) : 512;
    const h = Number(sd?.height) > 0 ? Math.round(Number(sd.height)) : 512;
    const lo = Math.min(w, h), hi = Math.max(w, h);
    if (aspect === 'portrait') return { width: lo, height: hi };
    if (aspect === 'landscape') return { width: hi, height: lo };
    if (aspect === 'square') return { width: hi, height: hi };
    return { width: w, height: h };
}

/**
 * Faithful server-side port of the chat extension's generateComfyImageCommon()
 * placeholder substitution: every replacement targets the value wrapped in
 * JSON.stringify'd quotes (`"%prompt%"`), so workflow JSON stays valid.
 * @param {string} workflowRaw raw workflow JSON text (as stored in the workflow file)
 * @param {any} sd extension_settings.sd
 * @param {{prompt: string, negativePrompt: string, width: number, height: number, seed: number}} job
 */
export function substituteWorkflow(workflowRaw, sd, job) {
    let workflow = String(workflowRaw ?? '');
    const wrap = (v) => JSON.stringify(v);
    workflow = workflow.replaceAll(wrap('%prompt%'), wrap(job.prompt));
    workflow = workflow.replaceAll(wrap('%negative_prompt%'), wrap(job.negativePrompt));
    workflow = workflow.replaceAll(wrap('%seed%'), wrap(job.seed));
    const denoising = sd?.denoising_strength === undefined ? 1.0 : sd.denoising_strength;
    workflow = workflow.replaceAll(wrap('%denoise%'), wrap(denoising));
    const clipSkip = isNaN(sd?.clip_skip) ? -1 : -sd.clip_skip;
    workflow = workflow.replaceAll(wrap('%clip_skip%'), wrap(clipSkip));
    for (const ph of COMFY_PLACEHOLDERS) {
        workflow = workflow.replaceAll(wrap(`%${ph}%`), wrap(sd?.[ph]));
    }
    // width/height ride the aspect mapping, overriding the settings values.
    workflow = workflow.replaceAll(wrap('%width%'), wrap(job.width));
    workflow = workflow.replaceAll(wrap('%height%'), wrap(job.height));
    // Custom placeholders: find/replace verbatim. (The extension also runs ST
    // macros here; wave 1 keeps it literal — custom placeholders with {{macros}}
    // are rare and would silently stay unsubstituted either way.)
    for (const ph of (sd?.comfy_placeholders ?? [])) {
        if (ph && ph.find) workflow = workflow.replaceAll(wrap(`%${ph.find}%`), wrap(String(ph.replace ?? '')));
    }
    // Avatar placeholders: 1×1 pixel fallback (see header note).
    if (/%user_avatar%/gi.test(workflow)) workflow = workflow.replaceAll(wrap('%user_avatar%'), wrap(PNG_PIXEL));
    if (/%char_avatar%/gi.test(workflow)) workflow = workflow.replaceAll(wrap('%char_avatar%'), wrap(PNG_PIXEL));
    return workflow;
}

/**
 * Faithful port of the upstream comfy.post('/generate') handler: enqueue the
 * workflow, poll the history until the job lands, fetch the output file.
 * @param {string} comfyUrl ComfyUI base URL
 * @param {string} workflow JSON text of the workflow object
 * @param {import('express').Request} req for the client-close interrupt
 * @returns {Promise<{format: string, data: string}>}
 */
export async function runComfyJob(comfyUrl, workflow, req) {
    const urlJoin = (base, part) => `${String(base).replace(/\/+$/, '')}/${String(part).replace(/^\/+/, '')}`;
    let item;
    const controller = new AbortController();
    if (req?.socket) {
        req.socket.removeAllListeners('close');
        req.socket.on('close', () => {
            if (!req.socket.__followDone && !item) {
                fetch(urlJoin(comfyUrl, '/interrupt'), { method: 'POST', signal: controller.signal }).catch(() => {});
            }
        });
    }
    let promptResult;
    try {
        promptResult = await fetch(urlJoin(comfyUrl, '/prompt'), {
            method: 'POST',
            body: `{
                "prompt": ${workflow}
            }`,
            signal: controller.signal,
        });
    } catch (e) {
        throw new Error(`Could not reach ComfyUI at ${comfyUrl} (${e.message || e}). ` +
            `On the ComfyUI machine it must be started with --listen 0.0.0.0 and reachable from this server.`);
    }
    if (!promptResult.ok) {
        const text = await promptResult.text();
        throw new Error('ComfyUI returned an error.', { cause: text.slice(0, 2000) });
    }
    const data = await promptResult.json();
    const id = data.prompt_id;
    if (req?.socket) req.socket.__followDone = true;
    const historyUrl = urlJoin(comfyUrl, '/history');
    for (let i = 0; i < 1500; i++) { // ~5 min ceiling (upstream polls forever; we bail out)
        const result = await fetch(historyUrl, { signal: controller.signal });
        if (!result.ok) throw new Error('ComfyUI returned an error.');
        const history = await result.json();
        item = history[id];
        if (item) break;
        await delay(100);
    }
    if (!item) throw new Error('ComfyUI job did not finish in time.');
    if (item.status?.status_str === 'error') {
        const errorMessages = item.status?.messages
            ?.filter(it => it[0] === 'execution_error')
            .map(it => it[1])
            .map(it => `${it.node_type} [${it.node_id}] ${it.exception_type}: ${it.exception_message}`)
            .join('\n') || '';
        throw new Error(`ComfyUI generation did not succeed.\n\n${errorMessages}`.trim());
    }
    const outputs = Object.keys(item.outputs).map(it => item.outputs[it]);
    const imgInfo = outputs.map(it => it.images).flat()[0] ?? outputs.map(it => it.gifs).flat()[0];
    if (!imgInfo) throw new Error('ComfyUI did not return any recognizable outputs.');
    const imgUrl = urlJoin(comfyUrl, `/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder)}&type=${encodeURIComponent(imgInfo.type)}`);
    const imgResponse = await fetch(imgUrl, { signal: controller.signal });
    if (!imgResponse.ok) throw new Error('ComfyUI returned an error.');
    const format = (path.extname(imgInfo.filename).slice(1).toLowerCase()) || 'png';
    const imgBuffer = await imgResponse.arrayBuffer();
    return { format: format, data: Buffer.from(imgBuffer).toString('base64') };
}

function readSdSettings(req) {
    try {
        const raw = fs.readFileSync(path.join(req.user.directories.root, SETTINGS_FILE), 'utf8');
        const settings = JSON.parse(raw);
        return settings?.extension_settings?.sd ?? null;
    } catch (e) {
        return null;
    }
}

function readWorkflow(req, sd) {
    const name = sanitize(String(sd?.comfy_workflow || 'Default_Comfy_Workflow.json'));
    const filePath = path.join(req.user.directories.comfyWorkflows, name);
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
}

const router = express.Router();

/**
 * Generate an image with the user's currently configured Image Generation source.
 * Body: { prompt, negative_prompt, aspect? } — aspect: "portrait"|"landscape"|"square".
 * Response: { format, data } (base64) — the same shape the /api/sd endpoints return.
 */
router.post('/generate', async (request, response) => {
    try {
        const sd = readSdSettings(request);
        if (!sd || !sd.source) {
            return response.status(400).send('No Image Generation settings found. Open Loreweaver → Image Generation once to configure them.');
        }
        if (sd.source !== 'comfy') {
            return response.status(400).send(`SD-follow: source "${sd.source}" is not mirrored yet (wave 1 = ComfyUI). Set the Image Generation source to ComfyUI.`);
        }
        const workflowRaw = readWorkflow(request, sd);
        if (workflowRaw == null) {
            return response.status(400).send(`Workflow "${sd.comfy_workflow || 'Default_Comfy_Workflow.json'}" not found. Save it in Image Generation → ComfyUI.`);
        }
        const prompt = String(request.body?.prompt || '');
        const negativePrompt = String(request.body?.negative_prompt || '');
        const dims = aspectDims(sd, String(request.body?.aspect || ''));
        const seed = Number(sd?.seed) >= 0 ? Number(sd.seed) : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
        const workflow = substituteWorkflow(workflowRaw, sd, {
            prompt, negativePrompt, seed,
            width: dims.width, height: dims.height,
        });
        const out = await runComfyJob(sd.comfy_url, workflow, request);
        return response.send(out);
    } catch (error) {
        console.error('SD-follow error:', error?.message ?? error);
        return response.status(500).send(error?.message ?? 'SD-follow failed.');
    }
});

/**
 * Free probe for the engine's Test button (no generation): reports what the
 * mirror sees and whether ComfyUI answers.
 */
router.post('/status', async (request, response) => {
    const sd = readSdSettings(request);
    const out = { ok: false, source: sd?.source ?? null, comfy_url: sd?.comfy_url ?? null, workflow: sd?.comfy_workflow ?? null, reachable: false };
    if (out.source === 'comfy' && out.comfy_url) {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(`${String(out.comfy_url).replace(/\/+$/, '')}/system_stats`, { signal: controller.signal });
            clearTimeout(t);
            out.reachable = res.ok;
        } catch (e) { /* unreachable */ }
    }
    out.ok = out.source === 'comfy' && out.reachable;
    return response.send(out);
});

export { router };
