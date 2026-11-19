# Image Generation & Image Prompt Templates

Loreweaver ships the upstream SillyTavern **Image Generation** extension (`public/scripts/extensions/stable-diffusion/`, module id `sd`) unchanged. Its source is 100% upstream SillyTavern (AGPL-3.0), so all fixes flow from `upstream`. The "Image Prompt Templates" feature the extension settings is a section of this same extension — not a separate one — and is documented here together.

This doc covers **chat-side image generation** (images posted into normal chats). The **RPG engine has its own, separate image system** — see the last section.

---

## 1. What it does

Turns chat text into an image and posts the result back into the chat as a media message (or sets it as the chat background, or saves it to a character's gallery). The pipeline always has two AI stages:

```
trigger ("send a pic of a castle")
   → 1. prompt stage: an LLM turns the request into a comma-delimited keyword prompt
   → 2. image stage: an image backend renders that keyword prompt
   → image saved to a file → posted as a chat message / background / gallery item
```

Both stages are configurable independently: the prompt stage uses your **currently selected chat LLM**; the image stage uses one of **22 image sources** (below).

---

## 2. The 12 generation modes

Every request resolves to one of these modes. The mode decides which **prompt template** is used, what dimensions are forced, and whether a character prefix is applied.

| Mode | Label in the UI | Trigger words | Prompt comes from | Typical output |
|---|---|---|---|---|
| `-2` TOOL | Function Tool Prompt Description | (function tool call) | the tool description template | whatever the model asks for |
| `-1` MESSAGE | Chat Message Template | — | `{{prompt}}` outcome template | the chat message text around the image |
| `0` CHARACTER | Character ("Yourself") | `you` | character template | full-body portrait of the character |
| `1` USER | User ("Me") | `me` | user template | full-body portrait of the user |
| `2` SCENARIO | Scenario ("The Whole Story") | `scene` | scenario template | scene recap + character + surroundings |
| `3` RAW_LAST | Raw Last Message | `raw_last` | the last chat message verbatim | image of exactly what the message says |
| `4` NOW | Last Message | `last` | last-message template | keyword list of the last message's visuals |
| `5` FACE | Portrait ("Your Face") | `face` | portrait template | close-up facial portrait |
| `6` FREE | (free mode) | anything else | the raw trigger text itself | whatever you typed |
| `7` BACKGROUND | Background | `background` | background template | sets the chat background instead of posting |
| `8/9/10` *_MULTIMODAL | Character/User/Portrait (Multimodal Mode) | same as 0/1/5 | the **avatar image itself** (vision captioning) | prompt generated *from the picture* |
| `11` FREE_EXTENDED | Free Mode (LLM-Extended) | free + `free_extend` | LLM expands the free text | enriched keyword prompt |

**Mode resolution** (`getGenerationType`): the trigger is matched against trigger words; with *multimodal captioning* enabled modes 0/1/5 become their multimodal variants; with *free_extend* enabled free mode becomes FREE_EXTENDED.

### Trigger words and how to say it

- **Wand menu / command:** `/imagine you`, `/imagine face`, `/imagine me`, `/imagine scene`, `/imagine last`, `/imagine raw_last`, `/imagine background` — anything else is free mode (`/imagine apple tree`).
- **Interactive mode:** the user's own message is regex-scanned for phrasings like *"send me a picture of X"*, *"draw a X"*, *"render X"* (see `messageTrigger.activationRegex`), and X is mapped to a special case when it equals `you`, `yourself`, `me`, `myself`, `story`, `scenario`, `last message`, `face`, `portrait`, `selfie`, `background`, `scene`, `surroundings`, `environment`.

---

## 3. Image Prompt Templates

**Settings → Image Generation → Image Prompt Templates** (`#sd_prompt_templates`). Each template is a per-mode instruction that is sent to the LLM as a *quiet prompt*; the LLM's reply becomes the image prompt after processing. Templates support macros (`{{char}}`, `{{user}}`) and, in FREE mode, `{{charPrefix}}` / bare `char` to splice in a character's prompt prefix.

Defaults worth knowing (full text is in `promptTemplates` in `index.js`):

- **CHARACTER**: asks for a comma-delimited keyword list of the character — *name, species/race, gender, age, clothing, occupation, physical features* — explicitly forbidding non-visual qualities, prefixed `full body portrait,`.
- **FACE**: same idea but only above the neck, prefixed `close up facial portrait,`.
- **USER**: describes `{{user}}` *from the character's perspective*, ignoring the story.
- **NOW**: a precise ordered keyword recipe — location, character count by gender, positioning + `POV`, primary act, then each character's looks/actions — with a formatting example.
- **BACKGROUND**: location, time of day, weather, lighting; no characters.
- **MESSAGE**: not an image prompt at all — the template for the chat message that carries the image: `[{{char}} sends a picture that contains: {{prompt}}].`
- **TOOL**: the parameter description given to the model when image generation is exposed as a **function tool**.

Each template textarea has a ↺ **Restore default** button. Templates persist in `extension_settings.sd.prompts` (settings.json) and missing ones are re-seeded from defaults at load.

### Prompt processing (LLM reply → final prompt)

`processReply()` — unless **Minimal response prompt processing** is on, the LLM reply is stripped of quotes/newlines and non-`[a-zA-Z0-9.,:_(){}<>[\]/-'|#]` characters, split by commas, trimmed, and rejoined — a shape diffusion models expect.

### Prompt refinement

- **Edit prompts before generation** (`refine_mode`): a popup shows the final prompt (and negative prompt / saved-resolution checkbox for regenerate flows) before anything is sent.
- **Character prefix/negative** (`character_prompts` / `character_negative_prompts`, keyed by character avatar filename; optionally shared via the character card's `sd_character_prompt` extension field): per-character positive/negative prefixes, applied for CHARACTER/FACE-family modes. Registered macros: `{{charPrefix}}` and `{{charNegativePrefix}}`.
- **Style presets** (`sd_styles`): named bundles of prefix + negative (Default = `best quality, absurdres, aesthetic,` + the standard negative). Save/Rename/Delete in the settings; `/imagine-style <name>` switches.

---

## 4. Image sources

**Source** dropdown in settings. Request validity per source is checked by `isValidState()` (URL set / secret key present).

### Local / self-hosted
| Source | Notes |
|---|---|
| Stable Diffusion Web UI (AUTOMATIC1111) | URL + optional auth; full param set (sampler, steps, CFG, VAE, hires fix, CLIP skip, face restore, ADetailer face) |
| SD.Next (vladmandic) | same UI family |
| stable-diffusion.cpp server | lightweight local server |
| DrawThings HTTP API | macOS/iOS app; HTTP API switch must be on |
| ComfyUI | **workflow JSON** drives the render; placeholders like `"%prompt%"` are substituted from the UI / command args; visual workflow editor, multiple workflows, RunPod serverless variant |

### Cloud APIs (secret key stored server-side in Loreweaver)
NovelAI Diffusion (Anlas guard, small/multi/upscalers), OpenAI (`dall-e-2/3`, `gpt-image-1`; style/quality/duration), Stability AI, Google AI (MakerSuite/Vertex; "enhance" first runs the prompt through Gemini), xAI (Grok), Z.AI, TogetherAI, Cloudflare Workers AI (account ID in Chat settings), HuggingFace (serverless inference), AI/ML API, NanoGPT, ElectronHub, Chutes, BFL (Black Forest Labs), FAL.AI, Pollinations (free tier, optional prompt "enhance"), **OpenRouter** (`/api/openrouter/image/generate` — model from the image-models list, aspect ratio derived from width/height, returned as base64 JPG), Horde (free community cluster).

Server-side endpoints backing these live in `src/endpoints/` — `stable-diffusion.js` (local servers + Horde + several clouds), `openai.js`, `novelai.js`, `google.js`, `openrouter.js` (`/image/generate`, `/models/image`), `nanogpt.js`, etc. All keys are read server-side from `secrets.json` — never from the page.

### Dimensions & aspect handling
- **Resolution presets** dropdown + free width/height (multiples of 64).
- **Portrait modes** force height ≈ 1.5× width; **backgrounds** force width ≈ 1.8× height (`setTypeSpecificDimensions`), then restored afterwards.
- **Snap auto-adjusted resolutions**: keep total pixel count constant and snap to the nearest known preset (recommended for SDXL).
- Cloud sources with fixed aspect menus map the ratio to the closest supported (`getClosestAspectRatio`).

---

## 5. Ways to fire a generation

| Initiator | What | Visible-message toggle |
|---|---|---|
| `wand` | 🪄 wand menu → You / Face / Me / World / Last / Raw Last / Background | `wand_visible` |
| `command` | `/imagine [args] <trigger>` | `command_visible` |
| `interactive` | regex on the user's message (see §2) | `interactive_visible` |
| `tool` | LLM function tool `GenerateImage` (tool-calling capable APIs) | `tool_visible` |
| `swipe` | ➡ swipe past the last image version (needs User Settings → *Image Swipe Behavior* = Generate) | posts into the same message |
| `action` | 🖌 paintbrush icon on any message → regenerate that message's image | same message |

The message paintbrush and swipes both go through `generateMediaSwipe`: they **reuse the saved prompt + negative + resolution of the existing image**, roll a new seed (when seed is fixed), and append the result as a new media version on the same message.

### Output routing
- Default: a chat message built from the **MESSAGE template**, media attached, saved to the character's gallery.
- `quiet=true`: no message; returns the image path.
- `gallery=false`: save to the user-images root instead of the character gallery.
- BACKGROUND mode: sets the chat background (via `FORCE_SET_BACKGROUND`).

---

## 6. Slash commands

| Command | Purpose |
|---|---|
| `/imagine` (aliases `/sd`, `/img`, `/image`) | generate from a trigger word or free text |
| `/imagine-source` (aliases `/sd-source`, `/img-source`) | read/switch the image source |
| `/imagine-style` (aliases `/sd-style`, `/img-style`) | read/switch the style preset |
| `/imagine-comfy-workflow` (alias `/icw`) | switch the ComfyUI workflow |

`/imagine` named args mirror the settings one-off: `quiet`, `gallery`, `negative`, `extend`, `edit`, `multimodal`, `snap`, `processing`, `seed`, `width`, `height`, `steps`, `cfg`, `skip`, `model`, `sampler`, `scheduler`, `vae`, `upscaler`, `hires`, `scale`, `denoise`, `2ndpass`, `faces`. Overrides are applied for that call only and restored afterwards.

Example: `/imagine seed=42 width=1024 height=1024 model=juggernaut cat on a dragon`.

---

## 7. Extension points

- **`SD_PROMPT_PROCESSING` event**: other extensions can rewrite the prompt before the image request.
- **`generate_interceptor: SD_ProcessTriggers`** (manifest): the chat-generation pipeline calls it so interactive mode can hijack a normal reply when the user asks for a picture.
- **`GenerateImage` function tool**: registered/unregistered by the *Use function tool* toggle; the model decides to call it, the tool description comes from the TOOL template.
- **Multimodal captioning** reuses the shared `getMultimodalCaption` helper (`extensions/shared.js`) — same vision path as message captioning.

---

## 8. Loreweaver notes

- Source of truth is upstream: `public/scripts/extensions/stable-diffusion/` has **no Loreweaver-specific changes**; treat every file as upstream.
- All cloud keys belong in **Manage API Keys (server secrets)**, never in the browser.
- Where prompts/templates use English strings as i18n keys, translated locales fall back to the English wording (same pattern as the rest of the Phase-1 sweep).
- The extension's upstream docs link points to `docs.sillytavern.app` — still accurate, since the code is unchanged.

---

## 9. Relationship to the RPG engine's images

**Two independent systems live in Loreweaver:**

| | Chat Image Generation (this doc) | RPG engine images (`rpg-engine-port`) |
|---|---|---|
| Prompt source | Chat LLM via quiet prompts from the templates above | The engine's own prompt builder (scene/prompts and NPC portrait prompts) |
| Backends | 22 sources through Loreweaver server endpoints | Perchance plugin (standalone) or OpenAI/OpenRouter **called from the page with a page-stored key** |
| Output | Chat media message / background | Engine scene images + NPC portraits, stored in the engine's saves |

They share no code paths today. Bridging the RPG engine's image calls through the server (like the text bridge) is planned as [rpge-patch 017] — see `RPG-ENGINE-HANDOFF.md`.
