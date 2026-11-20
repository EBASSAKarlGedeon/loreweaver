# Presets in Loreweaver

> Status: BRAINSTORM DOCUMENT (pre-[rpge-patch 020] scope-setting). Not shipped code — read before
> designing the preset pipeline for the RPG Engine. — what they are, how the code builds an API call from one, and a walk through `Freaky Frankenstein 5.4 Internal States vers. Fiction Styles + Ground Prose Rules.json`

> Purpose: brain-dump groundwork for "presets should affect the RPG Engine the same way they affect
> Loreweaver proper" (currently the RPG Engine only has its `prose pack` in `narrator-prompt.md`).
> Keep this doc honest — file/function anchors refer to current code as of 2026-11.

## What a preset is

A preset is one `.json` file in `data/default-user/OpenAI Settings/` that captures the complete flavor
of *how* the LLM should answer before a single world or character even exists:

1. **Samplers** — `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `frequency_penalty`,
   `presence_penalty`, `seed`, `openai_max_tokens`, `openai_max_context`, streaming toggle…
2. **Model selection** — a family of `*_model` keys (`openrouter_model`, `claude_model`, `google_model`,
   `custom_model`/`custom_url`, …) so switching providers doesn't silently change the prompt stack.
3. **A prompt stack** — the ordered `prompts` list (roles, text, injection prefs) plus `prompt_order`,
   the "play order" per chat. Names of *what* is included; the *content* of world, characters, persona
   lives elsewhere and is slotted in at generation time.
4. **Formatting config** — `wi_format`, `scenario_format`, `personality_format`, `assistant_prefill`,
   `new_chat_prompt`, `impersonation_prompt`, `bias_preset_selected`, `names_behavior`…
5. A few global-and-extension toggles (`stream_openai`, `squash_system_messages`, `function_calling`,
   `reasoning_effort`, `request_images`, `extensions`…).

Analogy: a preset is a **director's marked-up script outline + camera settings**. The outline says
which blocks of direction exist and in what order; the story (character, world, chat history) is the
raw footage that gets spliced into the outline when you press send.

## How presets work in code

### Storage & load
* Saved as JSON blobs in `data/default-user/OpenAI Settings/<name>.json`.
* `public/scripts/preset-manager.js` (`getPresetManager('chat_completion')` etc.) loads a chosen file
  and fans the values out into mutable globals — `oai_settings` (chat-completion side,
  `public/scripts/openai.js`), `textgenerationwebui_settings`, `power_user` (user-level stuff like
  persona positions). Saved back with `saveSettingsDebounced()`.
* The special component is `public/scripts/PromptManager.js`. It wraps the raw `prompts` array as a
  `PromptCollection` of `Prompt` objects with fields: `identifier`, `role`, `content`, `system_prompt`,
  `marker`, `position`, `injection_position`, `injection_depth`, `injection_order`, `injection_trigger`,
  `forbid_overrides`. `promptOrder` config: `strategy: 'global'`, `dummyId: 100001` — the
  `prompt_order[0].character_id = 100001` group is THE global order; per-character overrides are
  appended (`getPromptOrderForCharacter`).

### The building blocks inside `prompts`
* **`marker: true` prompts** — empty *placeholders* (`main`, `worldInfoBefore`, `charDescription`,
  `charPersonality`, `scenario`, `worldInfoAfter`, `personaDescription`, `dialogueExamples`,
  `chatHistory`, `nsfw`, `jailbreak`, `enhanceDefinitions`…). The preset decides *where* these
  sit in the flow; the actual text is generated fresh every call from current chat state.
* **Named blocks** — free text chunks labeled `main`, `nsfw`, `jailbreak`, `enhanceDefinitions` (the
  built-in override slots, see `PromptManager` `defaultPrompts`) and every custom prompt: toggles,
  fiction styles, POV rules, jailbreaks, CoT users, etc.
* **`system_prompt: true`** — the block sits in the "system prompt" slot exposed to the model
  (providers that treat system prompts specially use it, e.g. `use_sysprompt`).
* **`injection_position`** — `0` = in-flow at its `prompt_order` position; `1` (INJECTION_POSITION.ABSOLUTE) =
  *in-chat injection*: dropped into `messages` (`populationInjectionPrompts` in `openai.js`), slicing at
  `injection_depth` counted from the end of the conversation, grouped by `injection_order`,
  role as `system`/`user`/`assistant` per `role`. This is how the "Internal States" boxes poll in the
  FF5.4 preset every turn.
* `injection_trigger` can gate an injection on an event/condition.

### The macro layer (must-know before reading any prompt text)
Every prompt's text is expanded by `substituteParams` (`public/scripts/macros.js`) before being put in
the request. In particular (see `macros.js` `preEnvMacros`/`postEnvMacros`):
* `{{// anything }}` — comment macro; produces empty string. Used as *visible author notes* inside the
  preset JSON so you can see what a block is for without it ever reaching the model.
* `{{trim}}`, `{{newline}}`, `{{noop}}` — whitespace control / no-op.
* `{{setvar::key::value}}` and `{{getvar::key}}` — variables that can seed per-turn *templates*
  (this FF5.4 preset pre-defines `{{setvar::dndTemplate::…}}`, `bondsTemplate`… at the top of `main`
  and then re-prints fresh blocks every turn).
* `{{user}}` / `{{char}}`, `{{random:…}}`, `{{pick:…}}`, `{{date}}`, `{{time}}`, `{{maxContext}}`, etc.

### The send pipeline (chat-completion side)
Entry point: `generateChatCompletion` → `prepareOpenAIMessages` → `preparePromptsForChatCompletion` +
`populateChatCompletion` (all `public/scripts/openai.js`), then `createGenerationParameters`,
then `sendOpenAIRequest` → `POST /api/backends/chat-completions` (`src/endpoints/backends/chat-completions.js`
converts to whatever provider was picked and calls out).

Rough order in which things are assembled (global `prompt_order` is the authoritative sequence):

1. `worldInfoBefore` (lorebook "before" entries; formatted via `wi_format`),
2. `main`, `worldInfoAfter`, `charDescription`, `charPersonality`, `scenario`,
   `personaDescription` — placed by `addToChatCompletion('worldInfoBefore'|'main'|…)` matching
   each marker's slot in `prompt_order`. Known extensions (summary/memory `1_memory`,
   authors-note `2_floating_prompt`, vectors `3_vectors`/`4_vectors_data_bank`, `chromadb`) can be
   injected *relative* to `main` via `position`.
3. Custom (non-marker) prompts follow in their `prompt_order` sequence (see `preparePromptsForChatCompletion`
   `systemPrompts` array and `addToChatCompletion` loop over `userRelativePrompts`).
4. `dialogueExamples` via `populateDialogueExamples`, then `chatHistory` via `populateChatHistory`
   (injections layered by `populationInjectionPrompts` at `injection_depth`).
5. In-chat ABSOLUTE injections: sliced into the message list at their depth, in `injection_order`
   (grouped: those with order `100` first, then custom orders).
6. Special blocks: `impersonate` / `quietPrompt` / `groupNudge` / `bias`, `continue_prefill`,
   function-call tool schemas.
7. All text is macro-expanded, trimmed to the context budget by the token handler
   (`PromptManager.getTokenHandler`, `ChatCompletion.reserveBudget` in `PromptManager.js`).
8. Finally `createGenerationParameters` (builds the `generate_data` payload: `messages`, `model`,
   `temperature`, `top_p`, `top_k`, `min_p`, repeats, `stop`, `stream`, `max_tokens`, `seed`,
   provider extras like `openrouter_*`, `custom_include_body`, `reasoning_effort`) and
   `sendOpenAIRequest` posts to `/api/backends/chat-completions`.
9. `custom-request.js` is the same pipeline exposed programmatically (used by extensions,
   including the RPG Engine bridge and `loreweaver-bridge.js`).

## The preset actually examined: `Freaky Frankenstein 5.4 Internal States vers. Fiction Styles + Ground Prose Rules.json`

Non-obvious facts before diving in:
* 102 top-level keys; `prompts` list has 68 entries but `prompt_order[0].order` only references 61
  (`character_id: 100001`, global). ~26 custom prompts are the usable toggles; ~12 are 30-char
  `{{//Keep toggled off}}{{trim}}` no-op "dormant slots" (placeholders to keep the picker UI tidy).
* `out of order` prompts (UUID keys not referenced in `prompt_order`) still exist in the file — those
  are old alternative versions riding along (e.g. `0b0afd85-…`, `019f62e8-…-7018` NPC-voice detritus),
  harmless clones kept for quick swapping.
* Comments are The FF5.4 signature: every block opens with `{{// author's guide }}` so the block reads
  as its own manual.
* `injection_position: 1, injection_depth: 0` for all "Internal States" modules — i.e. dropped INTO
  the conversation (right before `chatHistory`) every single turn, regardless of how long the chat is.

### 1. Group structure (the "pick one" pattern)
The preset uses little `=Pick one X 👇` separator prompts (`{{//Keep toggled off}}` matching `marker=False`
blocks with only code-comments) as visual dividers in `prompt_order`:

| Group | Members | Currently on |
|---|---|---|
| Prose Style | Manga / Visual Novel / **Light-Novel (⚡, active)** / Story Mode / Cinematic Realism | Light Novel |
| POV | 3rd / 2nd / 1st / **Hybrid (active)** | Hybrid |
| NSFW | Realism Mode / **Freaky Mode (active)** | Freaky Mode |
| Echo vs Anti-echo | Anti-parrot/Anti-echo (active) / Embellish Mode | Anti-echo |
| Colors | Colored Dialogue 2.0 VN (active) / Colored Dialogue VN (copy) | 2.0 VN |
| Chain of Thought | MAX Nested Gates / **BOLT (active)** / Micro | BOLT |
| Internal States modules | DnD Sim, Agenda, GM Notebook, Inventory/Feats/Titles, Relationships (bonds/sparks/grudge), **Chekhov's Gun**, Internal Thoughts, World Sim (off), Twitter feed (off) | most on, World Sim off |

### 2. What each active family does
* **`main` (⚡️Main Prompt)** — the anchor `<system_state>`: Uncensored Sim goal; role of the AI as
  cinematographer + DM + GM controlling all NPCs; Rules of physics & perception (line of sight 120°
  forward, muffled sound ranges); `random events`; `do_not_repeat_descriptions`; `NPC_intro` "sweep"
  (hair→body→attire the first time an NPC appears). Topped by `{{setvar::X::}}` initializers blanking
  each "internal states template" so stale blocks don't leak in.
* **⏰ Time and Place** — always-on header: `[ 🕰️ Time … | 🗓️ Day # … | 📍 Location … | [WeatherEmoji] … ]`
  at the top of *every* reply, controlled partially by `{{isotime}}`, `{{date}}`, `{{weekday}}`.
* **Prose family (pick one)** — 5 mutually exclusive voices (Manga panels, VN interiority,
  Light-Novel readability, Story Mode, Cinematic). Only one may be on at a time (that's the point of
  the "pick one" separator).
* **📚 Ground Prose Rules** — the "anti-slop" ban system: concrete physical prose only, no abstract
  emotion, no stock metaphor, no "negative framing". The author's note says "keep ON, the Prose Styles
  assume this stays active".
* **POV family (pick one)** — includes `Hybrid POV`: 3rd person world narration + 2nd person physical
  sensation for the user's body only (`<user_autonomy>` lock keeps the point-of-view from leaking
  into the AI acting for the player). This is an interesting mechanic when ported to RPG Engine.
* **NSFW/Consent family (pick one)** — consent toggles (Realism vs Freaky). *Freaky Mode* specs how
  adult scenes are written (detailed haptic/bodily description rules).
* **Anti-parrot / anti-echo (`<user_autonomy>`)** — Never write what `{{user}}` says/thinks/does if
  the player didn't write it; never resolve the player's action; never even narrate consequences past
  the player's last explicit action.
* **Total Output Length** — `HARD CAP: 200 words narrative body target 150-200`… interesting as this
  fights some models (some authors turn it off for chatty models as named in the comment).
* **NPC Voice + Dialogue 2.0 (`<speech_selection>` + Speech Acts framework)** — decides WHEN a
  character speaks; quotes framed as *acts situated in context*, which is scientifically framed
  (semantic vs pragmatic meaning).
* **Anti-Omniscient NPCs** — no unearned knowledge; no scent identification; no mind-reading.
* **NPC Instincts + VAD Emotions** — 9 core instincts (closure, preservation, comfort, tribal,
  reproduction, pattern fear…) driving emotional realism per NPC.
* **Realistic NPC's (`<realistic_bold_characters>`)** — "Roads/Challenge-Me"-lite: NPCs pursue goals
  relentlessly, may lie/confront, not pandering to the player.
* **Banned Word List** — deterministic ban list words must be avoided & replaced (`fresh meat, husky,
  breath catching, predatory, ozone, …`). Curated pet-peeve list against AI-slop vocabulary.
* **Colored Dialogue 2.0 VN** — forces output `<color:tone>"Dialogue"</color:tone>` so the render can
  color it in the frontend.
* **Pop in Graphics (`<gfx_protocol>`)** — emit HTML blocks `<!-- GFX_START --> … <!-- GFX_END -->`
  (terminals, signs, maps, letters) inline when the PC examines readable media. Good example of a
  world-effect prompt leveraged for UI.
* **Spectacle Combat Physics** — turn-based exchange duels; ONE exchange per response, cut at
  reaction point (never resolve the player's dodge). Pairs with `user_autonomy`.
* **Onomatopoeia Mode (`<onomatopoeia>`)** — 3 layers (SFX lines, vocal sound-words, intimacy
  vocalizations) with rules on when to CAPS/soften; useful explicit counter-note since
  `Ground Prose` bans "describing" vocal sounds.
* **Icebreaker Test** (`<professional_legality>` role=assistant) — the 3rd stronger jailbreak style block.
* **HQ NPC Genesis** — deterministic naming rules for NEW NPCs (generate 5 names, pick the 5th; ban
  Elara/Lily/etc.)
* **Temperature/Time-and-Place variation holders, debug engine** — developer template blocks.

### 3. Internal States (the flagship mechanism)
Master toggle "👾Internal States 💾🎮" + 8 sub-modules, all with `injection_position: 1`,
`injection_depth: 0`, role `user` (i.e. injected as *user* message content before chat history each
turn):

1. **DnD Simulator (`<internal_dndsim>`)** — rolls d20 under `Locked DC` vs `User Roll`/`NPC Roll`;
   literally defines "dice are law" lore-wise. Template output (`dndTemplate`) is rendered inline at
   end of every reply as `<details><summary>🎲 DND TASK SIM</summary>…</details>`.
2. **Internal Agenda (`<internal_agendatracker>`)** — off-screen NPC schedule table `[NPC] — Agenda | Step | current/max | Location`;
   "sleep, eat, work, sex, wander" allowed actions; NPCs complete "agendas" and refresh them
   (autonomous simulation of backstory). Pairs with `random events`.
3. **GM's Notebook (`internal_gmnotebook`)** — persistent scratchpad `[R] Reminder / [T] Thread / [D] Debug`.
4. **Inventory, Feats, Titles (`internal_inv`)** — tracks items/skills/titles which MODIFY d20 rolls
   (`{{getvar::…}}` macro bindings). 1:1 with RPG Engine's new `actions.js` abilities, worth aligning.
5. **Relationships RPG (`internal_bondtracker`)** — tri-axis BOND / Sparks / Grudge scale −5..+20
   with macros `{{getvar::bond_X_Y}}` etc.
6. **Chekhov's Gun** — planted foreshadowed "Bullets" that can randomly "fire" when conditions align.
7. **Internal Thoughts (`internal_npcthoughts`)** — raw internal thoughts of up to 3 NPCs per turn,
   masked from prose (feeds output, ground-truth only).
8. **World Sim (off in preset)**, **Twitter feed fun module (off)**.

Big takeaway: each module provides (a) a *template string* set as a `{{setvar::}}`, (b) a live
state block the model updates every turn inside `<details>` HTML, (c) boundary rules (never appear
in prose; they're state, not story). The preset expects you to use frontend **regex** to strip these
blocks before rendering to save tokens (per "internal states MUST be used with regex to avoid token
bloat" note).

### 4. Chain of Thought (pick one)
MAX / **BOLT** / Micro. BOLT = medium-speed "cognitive task list" reasoning pipeline
(`Think tags, tasks 0-10: Gamestate, NPC Plans, Complications…`). Be aware its rules are terse and
order-dependent (`Reason in think tags, never draft prose in think tags`).

### 5. Prompt-order reality check
`prompt_order[0].order` alternates real content with `=Pick one X` separators (disabled), giving
around **61 ordered placements**; `nsfw`, `jailbreak`, `enhanceDefinitions`, `main` markers are all
exposed at fixed indexes `0, 45…60`. Internal States chips sit at #46–57 in `prompt_order`, *after*
the `chatHistory` marker (45), but `prompt_order` does not actually control their final placement:
because they carry `injection_position: 1`, `populationInjectionPrompts` splices them into the
chat-history region at `injection_depth` (here 0) regardless of their order index. The same pivot
holds for `jailbreak` (index 60) once its marker fills.

## Where the RPG Engine stands today (asymmetry baseline)

`app/src/scripts/narrator-prompt.md` (single hardcoded system block), `prose-rules.js` (Prose Pack),
`scene-dice.js`/`stats.js` (die math, code-side — already nearly the same philosophy as the DnD Sim
module). The RPG Engine bridge (`loreweaver-bridge.js`) sends to `/api/backends/chat-completions` but
**does not walk through `PromptManager`, `prompt_order`, macro expansion of a preset, or `oai_settings`
sampling** — the gap we plan to close next.

Interesting ports ahead (concrete, not just vibes):
* Replace `narrator-prompt.md` with a Marked-up preset stack honored by `PromptManager` on the
  `chat_completion_source` route; reuse `substituteParams` with `{{//}}` comment ergonomics.
* Port the Internal States pattern: our skill-check, trackers `key:`, new `[ACTION: …]` strip already
  match "GM chips stay out of prose" — the FF5.4 module templates and deltas could be unified
  (and `actions.js` might literally read preset-set `{{setvar::invTemplate}}` vars someday).
* Per-setting "features modes" (pick-one groups) match the engine's `tracker` + `scene-dice` feature
  toggles; stay consistent.
---

## Cutover design (2026-11-21, [rpge-patch 020–023] planning)

**Decisions taken in brainstorm (not yet code):**

1. **Bridge shape — data-reuse, not UI-copy.** Do NOT copy ST PromptManager's HTML wall. Port the
   JSON *schema* (`prompts`+`prompt_order`) and macro grammar (`{{setvar}}`/`{{getvar}}`/`{{// }}`)
   into an engine-local, lightweight prompt-stack model with Import/Export speaking ST's exact
   `.json` format. Samplers already bridge via `loreweaver-bridge.js` + `/api/settings/get` connection
   profiles (unchanged). Regex engine ported wholesale from
   `public/scripts/extensions/regex/engine.js` (`runRegexScript`) as pre-render post-processing.

2. **FF 5.4 Engine Edition** = verbatim copy of the real FF5.4 file's prose/pacing/POV/NSFW/behavior
   blocks, with all 8 `injection_position:1` Internal States HTML modules REMOVED. Rationale: each of
   those fake `<details>` dashboards already has a superior engine-native counterpart
   (`scene-dice.js`+`stats.js` ≈ DnD Sim; `actions.js` ≈ Inv/Feats/Titles; `openThreads`/patch 013 ≈
   GM's Notebook; `npc-life.js`/patch 012 ≈ Internal Agenda; tracker rows ≈ Relationships). Code-does-
   the-math beats AI-claims-dashboard.

3. **`<!-- GFX_START -->` Pop-in Graphics (patch 020)** — `rich-text.js` escape-first pipeline is a
   constraint (everything `&lt;`-escaped before formatting), but `core()` already liftable-hides code
   spans via `CODE_MARK` before escaping; same lift-out pattern hoists `<!-- GFX_START -->…INNER…<!-- GFX_END -->`
   inner HTML aside pre-escape, whitelist-sanitizes (tags: div/span/b/i/u/br/hr; style attribute
   limited to background/color/font/border/padding-family), swap back post-markdown. Theme CSS in
   `styles.css` (terminal/map/letter/phone per `<gfx_protocol>`). Self-contained — no preset dependency.

4. **Inline images (patch 020)** — `![alt](src)` handling in `richText`; `esc()` escapes `&<>"'` but
   NOT brackets/parens so the regex stays viable. Both forms work:
   - `https://…webp` external URLs load fine — helmet CSP is OFF (`contentSecurityPolicy: false`),
     `img-src` unrestricted.
   - `/user/images/...` paths map 1:1 to `src/users.js` line 1217 `router.use('/user/images/*', …)`
     already serving `req.user.directories.userImages`; same-origin, no CORS issue inside the
     extension iframe.
   Validate/escape `url` (reject unbalanced quotes) before writing `src="…"` — no attribute-injection.
   Emit `<img class="msg-img">`, optional `alt` from the bracket text.

**Proposed patch order (hand-test each before next):**
- `[rpge-patch 020]` — GFX blocks + inline images in `rich-text.js`/`styles.css`
- `[rpge-patch 021]` — port `runRegexScript` from `public/scripts/extensions/regex/engine.js`
- `[rpge-patch 022]` — engine-native prompt-stack model + lightweight editor + Import/Export (ST-json)
- `[rpge-patch 023]` — author "FF 5.4 — Engine Edition" preset data (port prose/POV/NSFW/behavior
  blocks verbatim; internal-states dropped in favour of native panels)

**Open questions for user (2026-11-21):** confirm patch order, and whether 020 or 021 should lead
(patch 020 is smaller/visual, 021 is a defensive prerequisite for importing external presets).
