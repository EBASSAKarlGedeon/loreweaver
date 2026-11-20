// [rpge-patch 024] SD-follow — the RPG engine follows the user's Image Generation
// extension settings. Instead of mirroring ~25 per-source payload builders into the
// engine (upstream code, drifts on every pull), a Loreweaver-owned endpoint reads the
// user's saved `extension_settings.sd` from settings.json and replays the exact
// request the chat-side extension would send for the configured source.
//
// Contract (agreed with the user): "if it works in Loreweaver chat, it works in the
// engine." Wave 1 mirrored ComfyUI; wave 2 (this file) mirrors EVERY remaining source:
// each entry below is a faithful port of the extension client's generateXxxImage()
// payload builder + response mapper, dispatched internally through the SAME upstream
// server routers the extension uses — so key handling, auth and quirks stay upstream.
//
// Prompt recipes are deliberately NOT mirrored: the engine has its own prompt stage
// (it reads live game state). Only the IMAGE stage (renderer + its config) follows.
// Video-capable models (sora-2, veo-*, CogVideoX, Vidu) answer with an explicit
// error: the engine renders images only.
//
// The ComfyUI logic is a faithful port of the upstream handler in
// `stable-diffusion.js` (AGPL-3.0, © SillyTavern contributors), duplicated so
// upstream files stay untouched.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import sanitize from 'sanitize-filename';

import { delay } from '../util.js';
import { router as sdRouter } from './stable-diffusion.js';
import { router as hordeRouter } from './horde.js';
import { router as novelaiRouter } from './novelai.js';
import { router as openaiRouter } from './openai.js';
import { router as googleRouter } from './google.js';
import { router as openrouterRouter } from './openrouter.js';

const SETTINGS_FILE = 'settings.json';
// Same 1×1 transparent PNG the chat-side extension uses as its avatar fallback.
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// The placeholders the extension's generateComfyImage() substitutes, in its order.
const COMFY_PLACEHOLDERS = ['model', 'vae', 'sampler', 'scheduler', 'steps', 'scale', 'width', 'height'];

// ---------------------------------------------------------------------------
// Aspect mapping (engine aspect → workflow/payload dims)
// ---------------------------------------------------------------------------

/**
 * Maps the engine's aspect to concrete width/height. Base dims come from the
 * extension settings; the aspect only re-orients them (portrait = shorter side
 * across, longer side up), so the user keeps pixel control (e.g. 832×1216 for an
 * SDXL checkpoint).
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
 * Faithful port of the chat extension's getClosestAspectRatio() for the sources
 * that need a named ratio (stability / google / zai / xai).
 */
export function closestAspectRatio(sd, source) {
    const tables = {
        stability: { '16:9': 16 / 9, '1:1': 1, '21:9': 21 / 9, '2:3': 2 / 3, '3:2': 3 / 2, '4:5': 4 / 5, '5:4': 5 / 4, '9:16': 9 / 16, '9:21': 9 / 21 },
        google: { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4 },
        zai: { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 },
        xai: { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3, '9:16': 9 / 16, '16:9': 16 / 9, '2:3': 2 / 3, '3:2': 3 / 2, '9:19.5': 9 / 19.5, '19.5:9': 19.5 / 9, '9:20': 9 / 20, '20:9': 20 / 9, '1:2': 1 / 2, '2:1': 2 / 1 },
    };
    const table = tables[source] || { '1:1': 1 };
    const ratio = (Number(sd?.width) || 512) / (Number(sd?.height) || 512);
    let best = Object.keys(table)[0];
    let minDiff = Math.abs(ratio - table[best]);
    for (const key of Object.keys(table)) {
        const diff = Math.abs(ratio - table[key]);
        if (diff < minDiff) { minDiff = diff; best = key; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// ComfyUI (wave 1) — unchanged
// ---------------------------------------------------------------------------

/**
 * Faithful server-side port of the chat extension's generateComfyImageCommon()
 * placeholder substitution: every replacement targets the value wrapped in
 * JSON.stringify'd quotes (`"%prompt%"`), so workflow JSON stays valid.
 * @param {string} workflowRaw raw workflow JSON text (as stored in the workflow file)
 * @param {any} sd extension_settings.sd
 * @param {{prompt: string, negativePrompt: string, width: number, height: number, seed: number, placeholders?: string[]}} job
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
    for (const ph of (job.placeholders || COMFY_PLACEHOLDERS)) {
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

// ---------------------------------------------------------------------------
// Wave 2 — per-source mirrors (faithful ports of the extension client builders)
// ---------------------------------------------------------------------------

// Faithful port of the extension's getSdRequestBody() (url + auth per source).
function sdUrlBody(sd) {
    switch (sd.source) {
        case 'vlad': return { url: sd.vlad_url, auth: sd.vlad_auth };
        case 'auto': return { url: sd.auto_url, auth: sd.auto_auth };
        case 'drawthings': return { url: sd.drawthings_url, auth: sd.drawthings_auth };
        default: throw new Error('Invalid SD source.');
    }
}

const fixedSeed = (sd) => (Number(sd?.seed) >= 0 ? Number(sd.seed) : undefined);

/**
 * Faithful port of the extension's getNovelParams() incl. the Anlas guard.
 */
export function novelParams(sd) {
    let steps = Math.min(Number(sd?.steps) || 0, 50);
    let width = Number(sd?.width) || 512;
    let height = Number(sd?.height) || 512;
    let sm = !!sd?.novel_sm;
    let sm_dyn = !!sd?.novel_sm_dyn;
    if (sd?.sampler === 'ddim' || ['nai-diffusion-4-curated-preview', 'nai-diffusion-4-full'].includes(sd?.model)) {
        sm = false; sm_dyn = false;
    }
    if (!sd?.novel_anlas_guard) return { steps, width, height, sm, sm_dyn };
    const MAX_STEPS = 28;
    const MAX_PIXELS = 1024 * 1024;
    if (width * height > MAX_PIXELS) {
        const ratio = Math.sqrt(MAX_PIXELS / (width * height));
        let newWidth = Math.round(width * ratio);
        let newHeight = Math.round(height * ratio);
        if (newWidth % 64 !== 0) newWidth -= newWidth % 64;
        if (newHeight % 64 !== 0) newHeight -= newHeight % 64;
        while (newWidth * newHeight > MAX_PIXELS) {
            if (newWidth > newHeight) newWidth -= 64; else newHeight -= 64;
        }
        width = newWidth; height = newHeight;
    }
    if (steps > MAX_STEPS) steps = MAX_STEPS;
    return { steps, width, height, sm, sm_dyn };
}

/**
 * Faithful port of the extension's getClosestSize() for ElectronHub. `sizes`
 * comes from the /sizes probe (fetched first via the same dispatch mechanism).
 */
export function closestSize(sd, sizes) {
    const list = Array.isArray(sizes) ? sizes : [];
    const w = Number(sd?.width), h = Number(sd?.height);
    if (isNaN(w) || isNaN(h) || !list.length) return null;
    const targetAspect = w / h;
    const targetRes = w * h;
    let best = { size: null, diff: Infinity };
    for (const size of list) {
        if (!size || typeof size !== 'string') continue;
        const parts = size.split('x');
        if (parts.length !== 2) continue;
        const sw = Number(parts[0]), sh = Number(parts[1]);
        if (isNaN(sw) || isNaN(sh)) continue;
        const diff = Math.abs((sw / sh) - targetAspect) / targetAspect
            + Math.abs(sw * sh - targetRes) / targetRes;
        if (diff < best.diff) best = { size, diff };
    }
    return best.size;
}

// Sources that can return video instead of an image — the engine renders images only.
const VIDEO_MODEL_GUARDS = [
    { test: (sd) => /sora-2/.test(sd?.model || ''), label: 'sora-2' },
    { test: (sd) => /^veo-/.test(sd?.model || ''), label: 'veo' },
    { test: (sd) => /(cogvideox|vidu)/.test(sd?.model || ''), label: 'CogVideoX/Vidu' },
];

/**
 * Builds the request the chat extension would send for the configured source.
 * @param {any} sd extension_settings.sd
 * @param {{prompt: string, negativePrompt: string, width: number, height: number}} job
 * @param {any} oai settings.oai_settings (workersai/vertexai fields)
 * @returns {Promise<{router: any, path: string, body: object}> | {special:'extras'} | {special:'comfy'} | {special:'comfyrunpod'}}
 */
export async function buildSourceRequest(sd, job, oai, user) {
    for (const g of VIDEO_MODEL_GUARDS) {
        if (g.test(sd)) throw new Error(`RPG engine renders images only — "${sd.model}" (${g.label}) generates video.`);
    }
    switch (sd.source) {
        case 'extras':
            return { special: 'extras' };
        case 'horde':
            return { router: hordeRouter, path: '/generate-image', body: {
                prompt: job.prompt, sampler: sd.sampler, steps: sd.steps, scale: sd.scale,
                width: job.width, height: job.height, negative_prompt: job.negativePrompt,
                model: sd.model, nsfw: sd.horde_nsfw, restore_faces: !!sd.restore_faces,
                enable_hr: !!sd.enable_hr, sanitize: !!sd.horde_sanitize,
                clip_skip: sd.clip_skip, seed: fixedSeed(sd),
            } };
        case 'auto':
        case 'vlad': {
            const body = { ...sdUrlBody(sd), prompt: job.prompt, negative_prompt: job.negativePrompt,
                sampler_name: sd.sampler, scheduler: sd.scheduler, steps: sd.steps,
                cfg_scale: sd.scale, width: job.width, height: job.height,
                restore_faces: !!sd.restore_faces, enable_hr: !!sd.enable_hr,
                hr_upscaler: sd.hr_upscaler, hr_scale: sd.hr_scale, hr_additional_modules: [],
                denoising_strength: sd.denoising_strength, hr_second_pass_steps: sd.hr_second_pass_steps,
                seed: fixedSeed(sd),
                override_settings: {
                    CLIP_stop_at_last_layers: sd.clip_skip,
                    sd_vae: (sd.vae && !['N/A'].includes(sd.vae)) ? sd.vae : undefined,
                    forge_additional_modules: (sd.vae && !['N/A'].includes(sd.vae)) ? [sd.vae] : undefined,
                },
                override_settings_restore_afterwards: true, clip_skip: sd.clip_skip,
                save_images: true, send_images: true,
                do_not_save_grid: false, do_not_save_samples: false,
            };
            if (sd.adetailer_face) {
                body.alwayson_scripts = { ADetailer: { args: [true, true, { 'ad_model': 'face_yolov8n.pt' }] } };
            }
            return { router: sdRouter, path: '/generate', body };
        }
        case 'drawthings':
            return { router: sdRouter, path: '/drawthings/generate', body: { ...sdUrlBody(sd),
                prompt: job.prompt, negative_prompt: job.negativePrompt, sampler_name: sd.sampler,
                steps: sd.steps, cfg_scale: sd.scale, width: job.width, height: job.height,
                restore_faces: !!sd.restore_faces, enable_hr: !!sd.enable_hr,
                denoising_strength: sd.denoising_strength, clip_skip: sd.clip_skip,
                upscaler_scale: sd.hr_scale, seed: fixedSeed(sd),
            } };
        case 'sdcpp': {
            const body = { url: sd.sdcpp_url, model: sd.model || undefined,
                prompt: job.prompt, negative_prompt: job.negativePrompt,
                steps: sd.steps, cfg_scale: sd.scale, width: job.width, height: job.height,
                batch_size: 1, seed: fixedSeed(sd) };
            if (sd.sampler && sd.sampler !== 'N/A') body.sampler_name = sd.sampler;
            if (sd.scheduler && sd.scheduler !== 'N/A') body.scheduler = sd.scheduler;
            if (Number.isFinite(sd.clip_skip)) body.clip_skip = sd.clip_skip;
            return { router: sdRouter, path: '/sdcpp/generate', body };
        }
        case 'novel': {
            const p = novelParams(sd);
            // Wave-2 aspect: re-orient the NAI dims like the engine does elsewhere.
            const dims = aspectDims({ width: p.width, height: p.height }, (job.width > job.height) === (p.width > p.height) ? (job.width < job.height ? 'portrait' : 'landscape') : (job.width < job.height ? 'landscape' : 'portrait'));
            p.width = dims.width; p.height = dims.height;
            return { router: novelaiRouter, path: '/generate-image', body: {
                prompt: job.prompt, model: sd.model, sampler: sd.sampler, scheduler: sd.scheduler,
                steps: p.steps, scale: sd.scale, width: p.width, height: p.height,
                negative_prompt: job.negativePrompt, upscale_ratio: sd.hr_scale,
                decrisper: sd.novel_decrisper, variety_boost: sd.novel_variety_boost,
                sm: p.sm, sm_dyn: p.sm_dyn, seed: fixedSeed(sd),
            } };
        }
        case 'openai': {
            const model = String(sd.model || '');
            const isDalle2 = /dall-e-2/.test(model);
            const isDalle3 = /dall-e-3/.test(model);
            const isGptImg = /gpt-image-(1|2|latest)/.test(model);
            let width = 1024, height = 1024;
            const aspectRatio = job.width / job.height;
            if (isDalle3 && aspectRatio < 1) height = 1792;
            if (isDalle3 && aspectRatio > 1) width = 1792;
            if (isGptImg && aspectRatio < 1) height = 1536;
            if (isGptImg && aspectRatio > 1) width = 1536;
            if (isDalle2 && job.width <= 512 && job.height <= 512) { width = 512; height = 512; }
            return { router: openaiRouter, path: '/generate-image', body: {
                prompt: job.prompt, model, size: `${width}x${height}`, n: 1,
                quality: isDalle3 ? sd.openai_quality : (isGptImg ? sd.openai_quality_gpt : undefined),
                style: isDalle3 ? sd.openai_style : undefined,
                response_format: isDalle2 || isDalle3 ? 'b64_json' : undefined,
                moderation: isGptImg ? 'low' : undefined,
            } };
        }
        case 'aimlapi': {
            const model = String(sd.model || '').toLowerCase();
            const isSdLike = model.startsWith('flux/') || model.startsWith('stable') || model === 'recraft-v3' || model === 'triposr';
            const body = { prompt: job.prompt, model: sd.model };
            if (isSdLike) {
                body.steps = clamp(Number(sd.steps) || 0, 1, 50);
                body.guidance = clamp(Number(sd.scale) || 0, 1.5, 5);
                body.width = clamp(Number(job.width) || 0, 256, 1440);
                body.height = clamp(Number(job.height) || 0, 256, 1440);
                if (Number(sd.seed) >= 0) body.seed = Number(sd.seed);
            } else {
                body.n = 1;
                body.size = `${job.width}x${job.height}`;
                body.quality = sd.openai_quality;
                body.style = sd.openai_style;
            }
            return { router: sdRouter, path: '/aimlapi/generate-image', body };
        }
        case 'comfy':
            return { special: 'comfy' };
        case 'comfyrunpod':
            return { special: 'comfyrunpod' };
        case 'togetherai':
            return { router: sdRouter, path: '/together/generate', body: {
                prompt: job.prompt, negative_prompt: job.negativePrompt, model: sd.model,
                steps: sd.steps, width: job.width, height: job.height, seed: fixedSeed(sd),
            } };
        case 'pollinations':
            return { router: sdRouter, path: '/pollinations/generate', body: {
                prompt: job.prompt, negative_prompt: job.negativePrompt, model: sd.model,
                width: job.width, height: job.height, enhance: sd.pollinations_enhance,
                seed: fixedSeed(sd),
            } };
        case 'stability':
            return { router: sdRouter, path: '/stability/generate', body: {
                model: sd.model,
                payload: {
                    prompt: job.prompt.slice(0, 10000),
                    negative_prompt: job.negativePrompt.slice(0, 10000),
                    aspect_ratio: closestAspectRatio({ width: job.width, height: job.height }, 'stability'),
                    seed: fixedSeed(sd),
                    style_preset: sd.stability_style_preset,
                    output_format: 'png',
                },
            } };
        case 'huggingface':
            return { router: sdRouter, path: '/huggingface/generate', body: {
                model: sd.huggingface_model_id, prompt: job.prompt,
            } };
        case 'chutes':
            return { router: sdRouter, path: '/chutes/generate', body: {
                model: sd.model, prompt: job.prompt, negative_prompt: job.negativePrompt,
                width: job.width, height: job.height, steps: sd.steps, guidance_scale: sd.scale,
            } };
        case 'electronhub': {
            // The extension first asks the server for the model's available sizes.
            const probed = await callRoute(sdRouter, '/electronhub/sizes', { model: sd.model }, user);
            let sizes = [];
            try { sizes = JSON.parse(probed.text)?.sizes ?? []; } catch { sizes = []; }
            return { router: sdRouter, path: '/electronhub/generate', body: {
                model: sd.model, prompt: job.prompt,
                size: closestSize({ width: job.width, height: job.height }, sizes),
                quality: String(sd.electronhub_quality || '').trim() || undefined,
            } };
        }
        case 'nanogpt':
            return { router: sdRouter, path: '/nanogpt/generate', body: {
                model: sd.model, prompt: job.prompt, negative_prompt: job.negativePrompt,
                num_steps: parseInt(sd.steps), scale: parseFloat(sd.scale),
                width: parseInt(job.width), height: parseInt(job.height),
                resolution: `${job.width}x${job.height}`,
                showExplicitContent: true, nImages: 1,
            } };
        case 'bfl':
            return { router: sdRouter, path: '/bfl/generate', body: {
                prompt: job.prompt, model: sd.model,
                steps: clamp(Number(sd.steps) || 0, 1, 50),
                guidance: clamp(Number(sd.scale) || 0, 1.5, 5),
                width: clamp(Number(job.width) || 0, 256, 1440),
                height: clamp(Number(job.height) || 0, 256, 1440),
                prompt_upsampling: !!sd.bfl_upsampling, seed: fixedSeed(sd),
            } };
        case 'falai':
            return { router: sdRouter, path: '/falai/generate', body: {
                prompt: job.prompt, negative_prompt: job.negativePrompt, model: sd.model,
                steps: clamp(Number(sd.steps) || 0, 1, 50),
                guidance: clamp(Number(sd.scale) || 0, 1.5, 5),
                width: clamp(Number(job.width) || 0, 256, 1440),
                height: clamp(Number(job.height) || 0, 256, 1440),
                seed: fixedSeed(sd),
            } };
        case 'xai': {
            let aspectRatio, resolution;
            if (/grok-imagine/.test(sd.model || '')) {
                const use2k = (job.width * job.height) > (1296 * 864);
                aspectRatio = closestAspectRatio({ width: job.width, height: job.height }, 'xai');
                resolution = use2k ? '2k' : '1k';
            }
            return { router: sdRouter, path: '/xai/generate', body: {
                prompt: job.prompt, model: sd.model, aspect_ratio: aspectRatio, resolution,
            } };
        }
        case 'google':
            return { router: googleRouter, path: '/generate-image', body: {
                prompt: job.prompt,
                aspect_ratio: closestAspectRatio({ width: job.width, height: job.height }, 'google'),
                negative_prompt: job.negativePrompt, model: sd.model,
                enhance: sd.google_enhance, api: sd.google_api || 'makersuite',
                seed: fixedSeed(sd),
                vertexai_auth_mode: oai?.vertexai_auth_mode,
                vertexai_region: oai?.vertexai_region,
                vertexai_express_project_id: oai?.vertexai_express_project_id,
            } };
        case 'zai': {
            const isGlmImage = /glm-image/.test(sd.model || '');
            const multiple = isGlmImage ? 32 : 16;
            let width = clamp(Math.round(job.width / multiple) * multiple, 512, 2048);
            let height = clamp(Math.round(job.height / multiple) * multiple, 512, 2048);
            if (!isGlmImage) {
                while ((width * height) > Math.pow(2, 21)) {
                    if (width >= height) width -= multiple; else height -= multiple;
                }
            }
            return { router: sdRouter, path: '/zai/generate', body: {
                prompt: job.prompt, model: sd.model, quality: sd.openai_quality,
                size: `${width}x${height}`,
            } };
        }
        case 'openrouter':
            return { router: openrouterRouter, path: '/image/generate', body: {
                model: sd.model, prompt: job.prompt,
                aspect_ratio: closestAspectRatio({ width: job.width, height: job.height }, 'stability'),
            } };
        case 'workersai':
            return { router: sdRouter, path: '/workersai/generate', body: {
                prompt: job.prompt, negative_prompt: job.negativePrompt, model: sd.model,
                width: job.width, height: job.height, steps: sd.steps, scale: sd.scale,
                seed: fixedSeed(sd), account_id: oai?.workers_ai_account_id,
            } };
        default:
            throw new Error(`SD-follow: source "${sd.source}" is not supported.`);
    }
}

/**
 * How each router's response maps to {format, data} — the exact mapping the
 * extension client performs on the same response.
 */
export function mapSourceResponse(source, text) {
    const parse = () => { try { return JSON.parse(text); } catch { return null; } };
    switch (source) {
        case 'extras': return { format: 'jpg', data: parse()?.image };
        case 'horde': return { format: 'webp', data: text };
        case 'auto': case 'vlad': return { format: 'png', data: parse()?.images?.[0] };
        case 'drawthings': return { format: 'png', data: parse()?.images?.[0] };
        case 'sdcpp': return { format: 'png', data: parse()?.images?.[0] };
        case 'novel': return { format: 'png', data: text };
        case 'openai': return { format: 'png', data: parse()?.data?.[0]?.b64_json };
        case 'aimlapi': { const j = parse(); return { format: j?.format, data: j?.data }; }
        case 'togetherai': { const j = parse(); return { format: j?.format, data: j?.data }; }
        case 'pollinations': { const j = parse(); return { format: j?.format, data: j?.image }; }
        case 'stability': return { format: 'png', data: text };
        case 'huggingface': return { format: 'jpg', data: parse()?.image };
        case 'chutes': return { format: 'jpg', data: parse()?.image };
        case 'electronhub': return { format: 'jpg', data: parse()?.image };
        case 'nanogpt': return { format: 'jpg', data: parse()?.image };
        case 'bfl': return { format: 'jpg', data: parse()?.image };
        case 'falai': return { format: 'jpg', data: parse()?.image };
        case 'xai': { const j = parse(); return { format: j?.format, data: j?.image }; }
        case 'google': return { format: 'jpg', data: parse()?.image };
        case 'zai': { const j = parse(); return { format: j?.format, data: j?.image }; }
        case 'openrouter': return { format: 'jpg', data: parse()?.image };
        case 'workersai': { const j = parse(); return { format: j?.format, data: j?.image }; }
        default: throw new Error(`SD-follow: no response mapping for source "${source}".`);
    }
}

// ---------------------------------------------------------------------------
// Internal dispatch — drive the upstream express routers with a minimal req/res
// ---------------------------------------------------------------------------

function makeInternalRes(onFinish) {
    const chunks = [];
    const res = new Writable({
        write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    res.__chunks = chunks;
    res.statusCode = 200;
    res.headers = {};
    res.headersSent = false;
    res.status = function (c) { this.statusCode = c; return this; };
    res.sendStatus = function (c) { this.statusCode = c; this.end(String(c)); return this; };
    res.send = function (x) {
        this.headersSent = true;
        if (x !== undefined && x !== null) {
            chunks.push(typeof x === 'object' && !(x instanceof Buffer) ? Buffer.from(JSON.stringify(x)) : Buffer.from(x));
        }
        this.end();
        return this;
    };
    res.json = function (x) { this.headersSent = true; chunks.push(Buffer.from(JSON.stringify(x ?? null))); this.end(); return this; };
    res.set = res.setHeader = function (k, v) { if (k && typeof k === 'object') { for (const [key, val] of Object.entries(k)) res.headers[String(key).toLowerCase()] = val; } else res.headers[String(k).toLowerCase()] = v; return this; };
    res.append = function () { return this; };
    res.type = res.contentType = function () { return this; };
    res.location = function () { return this; };
    res.cookie = res.clearCookie = function () { return this; };
    res.getHeader = function (k) { return res.headers[String(k).toLowerCase()]; };
    res.removeHeader = function () { return this; };
    res.end = function (c) {
        if (c) chunks.push(Buffer.from(c));
        if (!res.__ended) {
            res.__ended = true;
            onFinish({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        }
        return this;
    };
    res.on('finish', () => { if (!res.__ended) { res.__ended = true; onFinish({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); } });
    return res;
}

/**
 * Calls a path on one of the upstream routers with a synthesized request that
 * carries the real user (secrets/directories) and the follow job's body.
 */
export function callRoute(router, routePath, body, user) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const res = makeInternalRes((out) => finish(resolve, out));
        const req = {
            url: routePath,
            originalUrl: '/api/sd-follow' + routePath,
            method: 'POST',
            body,
            headers: {},
            user,
            socket: { on() {}, removeAllListeners() {} },
            get(header) { return req.headers[String(header).toLowerCase()]; },
        };
        try {
            router(req, res, (err) => {
                if (err) finish(reject, err);
                else finish(resolve, { status: res.statusCode, text: Buffer.concat(res.__chunks).toString('utf8') });
            });
        } catch (e) {
            finish(reject, e);
        }
    });
}

// ---------------------------------------------------------------------------
// Settings + workflow file access
// ---------------------------------------------------------------------------

function readSdSettings(req) {
    try {
        const raw = fs.readFileSync(path.join(req.user.directories.root, SETTINGS_FILE), 'utf8');
        const settings = JSON.parse(raw);
        return {
            sd: settings?.extension_settings?.sd ?? null,
            oai: settings?.oai_settings ?? null,
            extrasUrl: settings?.extension_settings?.apiUrl ?? null,
        };
    } catch (e) {
        return { sd: null, oai: null, extrasUrl: null };
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = express.Router();

/**
 * Generate an image with the user's currently configured Image Generation source.
 * Body: { prompt, negative_prompt, aspect? } — aspect: "portrait"|"landscape"|"square".
 * Response: { format, data } (base64).
 */
router.post('/generate', async (request, response) => {
    try {
        const { sd, oai, extrasUrl } = readSdSettings(request);
        if (!sd || !sd.source) {
            return response.status(400).send('No Image Generation settings found. Open Loreweaver → Image Generation once to configure them.');
        }
        const dims = aspectDims(sd, String(request.body?.aspect || ''));
        const job = {
            prompt: String(request.body?.prompt || ''),
            negativePrompt: String(request.body?.negative_prompt || ''),
            width: dims.width,
            height: dims.height,
        };
        const built = await buildSourceRequest(sd, job, oai, request.user);

        if (built.special === 'comfy' || built.special === 'comfyrunpod') {
            const isRunpod = built.special === 'comfyrunpod';
            const workflowRaw = readWorkflow(request, sd);
            if (workflowRaw == null) {
                return response.status(400).send(`Workflow "${sd.comfy_workflow || 'Default_Comfy_Workflow.json'}" not found. Save it in Image Generation → ComfyUI.`);
            }
            const seed = Number(sd?.seed) >= 0 ? Number(sd.seed) : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
            const workflow = substituteWorkflow(workflowRaw, sd, {
                prompt: job.prompt, negativePrompt: job.negativePrompt, seed,
                width: job.width, height: job.height,
                placeholders: isRunpod ? ['steps', 'scale', 'width', 'height'] : COMFY_PLACEHOLDERS,
            });
            if (isRunpod) {
                // The runpod router reads its own secret; body matches the extension
                // (wrapped {"prompt": <workflow>} JSON, the router unwraps + wraps for runpod).
                const out = await callRoute(sdRouter, '/comfyrunpod/generate',
                    { url: sd.comfy_runpod_url, prompt: `{
                    "prompt": ${workflow}
                }` }, request.user);
                if (out.status >= 400) throw new Error(`ComfyUI RunPod returned ${out.status}: ${out.text.slice(0, 500)}`);
                const j = JSON.parse(out.text);
                if (!j.data) throw new Error('ComfyUI RunPod did not return image data.');
                return response.send(j);
            }
            const out = await runComfyJob(sd.comfy_url, workflow, request);
            return response.send(out);
        }

        if (built.special === 'extras') {
            // Direct call to the extras server, like the extension's doExtrasFetch.
            const url = new URL(extrasUrl || '');
            url.pathname = '/api/image';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: job.prompt, sampler: sd.sampler, steps: sd.steps, scale: sd.scale,
                    width: job.width, height: job.height, negative_prompt: job.negativePrompt,
                    restore_faces: !!sd.restore_faces, enable_hr: !!sd.enable_hr,
                    karras: !!sd.horde_karras, hr_upscaler: sd.hr_upscaler, hr_scale: sd.hr_scale,
                    denoising_strength: sd.denoising_strength, hr_second_pass_steps: sd.hr_second_pass_steps,
                    seed: fixedSeed(sd),
                }),
            });
            if (!res.ok) throw new Error(`Extras server error: ${await res.text()}`);
            const mapped = mapSourceResponse('extras', await res.text());
            if (!mapped.data) throw new Error('Extras server did not return image data.');
            return response.send(mapped);
        }

        const probe = await callRoute(built.router, built.path, built.body, request.user);
        if (probe.status >= 400) throw new Error(`Image endpoint returned ${probe.status}: ${probe.text.slice(0, 500)}`);
        const mapped = mapSourceResponse(sd.source, probe.text);
        if (!mapped.data) throw new Error('Endpoint did not return image data.');
        return response.send(mapped);
    } catch (error) {
        console.error('SD-follow error:', error?.message ?? error);
        return response.status(500).send(error?.message ?? 'SD-follow failed.');
    }
});

/**
 * Free probe for the engine's Test button (no generation): reports what the
 * mirror sees and — for local sources — whether the backend answers.
 */
router.post('/status', async (request, response) => {
    const { sd } = readSdSettings(request);
    const out = { ok: false, source: sd?.source ?? null, comfy_url: sd?.comfy_url ?? null, workflow: sd?.comfy_workflow ?? null, reachable: null };
    if (out.source === 'comfy' && out.comfy_url) {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(`${String(out.comfy_url).replace(/\/+$/, '')}/system_stats`, { signal: controller.signal });
            clearTimeout(t);
            out.reachable = res.ok;
        } catch (e) { /* unreachable */ }
        out.ok = out.reachable === true;
    } else if (out.source) {
        // Cloud/local-HTTP sources: configured is all we can probe for free.
        out.ok = true;
    }
    return response.send(out);
});

export { router };
