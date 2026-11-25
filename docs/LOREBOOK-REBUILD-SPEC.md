# Lorebook rebuild (LLM) — spec

Status: **decided, not built** (2026-11-26). Every contract below is read out of the Glaze source
(`C:/Users/Gedeon/Documents/Coding/Glaze-stable`), with file/line references so it can be re-checked.
Where we deviate, it says so and why.

## 1. What it is

A JanitorAI **public** lorebook is JSON: `convertCharacterBook` + `saveWorldInfo`, already implemented
(`index.js:3088-3095`). A **scripted** book is JavaScript source (`const loreEntries = [...]`, sometimes
assembled by code), so we store the source (`book.jsSource`, `weavers-vault-janitor.js:671-677`) and stop
with a toast: *"it needs an LLM rebuild, which is not run automatically."*

This spec replaces that dead end. The rebuild turns the stored **source text** into World Info entries
with one model call (or several, chunked). Nothing is driven on the site — that was the capture step,
which we do not use here.

Not in scope: running on import, rebuilding public books, streaming, editing the prompt per book.

## 2. Where it sits

```
importJanitorLorebooks()                       index.js:3069
  POST /api/weavers-vault/janitor/lorebooks    weavers-vault.js:1241
     public    -> convertCharacterBook + saveWorldInfo    (unchanged)
     scripted  -> { jsSource } stored, row gets [Build]   (new)
     closed    -> named refusal                           (unchanged)
     failed    -> named reason                            (unchanged)
```

**User-initiated only.** A `[Build]` button on the scripted row, never a side effect of import, mount
or refresh: a rebuild spends real money per book, and this project has already paid for silent
automatic work once.

## 3. The request, exactly as Glaze builds it

`lib/features/catalog/services/janitor_lorebook_rebuilder.dart:330-373`.

### 3.1 Messages

Exactly two: one `system`, one `user`. There is **no** second "key inference" call — the context rides
in the same user message and the system prompt explains its status. Ported from JAR `extract.js`
`buildExtractionMessages`.

Each selected, non-empty context block is:

```js
`${intro}\n\n${value.trim()}`
```

blocks joined with `\n\n---\n\n`, then the payload appended as one more part:

```js
fromJs ? `JavaScript lorebook source to convert into entries:\n\n${text}`
       : `Raw lorebook text to convert into entries:\n\n${text}`
```

The six intros, verbatim and in this order (an empty block is omitted entirely, never sent as a bare
header):

1. `card` — `CONTEXT — the character card these entries accompany. Use it ONLY to infer better trigger keys and resolve names/aliases. Do NOT output any of this card text as entries:`
2. `catalog` — `CONTEXT — the public catalog description for this character as shown on the site (setting, place and faction names). Use it ONLY to infer better trigger keys. Do NOT output any of this as entries:`
3. `scenario` — `CONTEXT — the scenario / setup for this roleplay. Use it ONLY to infer better trigger keys (names, places, situations). Do NOT output any of this as entries:`
4. `greetings` — `CONTEXT — the character's opening message(s) / greeting(s). Use them ONLY to infer better trigger keys (names, places, items mentioned). Do NOT output any of this as entries:`
5. `lorebookDescs` — `CONTEXT — the public descriptions of lorebooks attached to this character (titles and descriptions only — the lorebook contents themselves are NOT included here). Use them ONLY to infer better trigger keys. Do NOT output any of this as entries:`
6. `extra` — `CONTEXT — additional notes provided by the user (names, aliases, setting details). Use it ONLY to infer better trigger keys. Do NOT output any of this as entries:`

### 3.2 The two system prompts (verbatim, `:28-81`)

These are the output contract; a different prompt is a different feature. Both are overridable by a
setting, and a blank override means "use the built-in default" (`lorebookSystemPrompt`, `:296`).

```text
You reconstruct a SillyTavern World Info (lorebook) from raw text.

You are given text extracted from an LLM chat prompt: one or more lorebook entries a
roleplay platform injected because their trigger keywords matched. The character card and
user persona have already been removed; what remains is lorebook entry bodies concatenated
together (often separated by blank lines). You may also be given the character card and a
catalog/world description as CONTEXT — use those ONLY to infer better keys, never output
them as entries.

Your job:
1. Split the text into discrete, self-contained World Info entries. Each coherent block
   about one topic (a person, place, faction, item, rule, lore fact) is one entry. Do NOT
   merge unrelated topics; do NOT split a single topic across entries.
2. For each entry write:
   - "content": the entry body, faithful to the source.
   - "key": array of primary trigger keywords/phrases (names, aliases, places, distinctive
     nouns), inferred from the content and the provided context.
   - "keysecondary": optional array of secondary keywords (else []).
   - "comment": a short title (the topic name).
   - "order": optional integer insertion order; default 100.
3. Output ONLY a JSON object:
   { "entries": [ { "comment": "...", "key": ["..."], "keysecondary": [], "content": "...", "order": 100 }, ... ] }
No markdown, no prose, no code fences — JSON only.
```

```text
You reconstruct a SillyTavern World Info (lorebook) from JavaScript source.

You are given the JavaScript source of a JanitorAI "advanced" / Nine API lorebook script. It
typically defines an array of lore entries (often `const loreEntries = [ ... ]`), where each
entry is an object with fields such as `keywords`/`keys`/`keysRaw`, `content`, `personality`,
`scenario`, `name`/`title`/`category`, `constant`, `priority`/`insertion_order`, and an
optional `filters.notWith` (secondary "not with" keywords). Some scripts assemble entries
with code; recover the resulting lore regardless.

You may also be given the character card and a catalog/world description as CONTEXT — use
those ONLY to infer better keys, never output them as entries.

Your job:
1. Recover every distinct lore entry the script defines. Do NOT invent entries the script
   does not contain; do NOT merge unrelated entries or split a single entry.
2. For each entry write:
   - "content": the entry body. If an entry has no `content` but has `personality` and/or
     `scenario`, combine those into the content.
   - "key": array of primary trigger keywords (from `keywords`/`keys`/`keysRaw`).
   - "keysecondary": secondary keywords (e.g. from `filters.notWith`), else [].
   - "comment": a short title (from `name`/`title`/`category`).
   - "order": optional integer insertion order (from `priority`/`insertion_order`); default 100.
3. Output ONLY a JSON object:
   { "entries": [ { "comment": "...", "key": ["..."], "keysecondary": [], "content": "...", "order": 100 }, ... ] }
No markdown, no prose, no code fences — JSON only.
```

### 3.3 Chunking (`:161-288`)

```js
// budget: the user's setting, clamped to half of what is left of the window
budget = chunkTokens   // setting, default 24000 (kDefaultLorebookBuildChunkTokens)
if (window > 0) budget = Math.min(budget, Math.floor((window - fixedTokens) / 2))
budget = Math.max(budget, 2000)          // kMinLorebookBuildChunkTokens

fixedTokens = tokens(system) + tokens(messagesFor(''))   // every request repeats it

if (fromJs || chunkTokens <= 0) -> one request           // a script must be read whole
else chunks = chunkLorebookText(text, budget)
     if (chunks.length <= 1) -> one request with the WHOLE text, not the chunk
     else one request per chunk
```

`/2` is deliberate: prompt and reply share the window and the reply is about as long as the text
(`:166-170`). A JS source that does not fit is **not** cut — it fails with a clear message.

`chunkLorebookText` cuts between entry blocks (blank lines), packs greedily, joins a chunk's pieces
with `\n\n`; a single block over budget is cut on line breaks, and a single over-long line by length
(`:192-242`). No attempt is made to be JSON-aware.

## 4. Wiring it to our stack

The vault is the first extension here to call a model: profiles and secrets live in `extension_settings`,
so the call is client-side (Glaze is identical — the rebuild is not part of the capture driver).

```js
import { ConnectionManagerRequestService } from '../shared.js';   // shared.js:388
import { getTokenCount } from '../../tokenizers.js';              // SYNC: planning needs a number now
import { createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from '../../world-info.js';
import { planBuild, transportFor, parseReply } from './lorebook-rebuild.js';

// Sync by design: planBuild() must price a request before it is sent, and the
// async counter belongs to rendering, not to the plan.
const countTokens = (text) => {
    try { return getTokenCount(text, 0); } catch { return Math.ceil(String(text).length / 4); }
};

const plan = planBuild({ text: jsSource, fromJs: true, context, countTokens });
const { messages, maxTokens, temperature, stream, includePreset } = transportFor(plan.requests[0]);

const data = await ConnectionManagerRequestService.sendRequest(
    profileId, messages,
    maxTokens,                                   // undefined => no cap (§5.1)
    { stream, includePreset, includeInstruct: false, overridePayload: { temperature } },
);
const reply = data.content;                      // parseReply(reply, { part, total })
```

`sendRequest` takes a real message array (`shared.js:439`), so the system prompt is a system message
and not a glued-on prefix. `includePreset: false` matters: a chat preset injects its own system
prompt and character placeholders around a mechanical JSON task.

**Profile resolution** — Glaze `resolveLorebookBuildConfig` (`:309`):

```js
const id = settings.lorebookRebuildProfileId;          // per-role setting
let profile = id ? profiles.find(p => p.id === id) : null;
profile ??= profileOf(extension_settings.connectionManager.selectedProfile);   // empty or stale id -> active
if (!profile) throw new VaultRebuildError('no_connection');
if (profile.api !== 'custom' || !isChatCompletion(profile)) throw ...;  // embeddings / text-completion
const model = settings.lorebookRebuildModel?.trim() || profile.model;  // per-build override
```

Glaze refuses embedding connections outright (`:318`). For `textgenerationwebui` we refuse too: the
message array has no meaning there, and flattening it would silently break the prompt contract.

**Context window** for the chunk clamp: `SillyTavern.getContext().oai_settings.openai_max_context`
(`script.js:8033` exposes the chat-completion settings). Unknown or 0 -> no clamp, exactly Glaze with
a connection of unknown window; the dialog then says *"window unknown — one request, no clamp"*.

## 5. Transport parameters, parsing, failure

### 5.1 Parameters — do not cap the reply

**The reply is boundless.** Glaze sends `maxTokens: 0` to a transport that drops the field
(`:573-578`), with the reason written in the source:

> On reasoning models `max_tokens` bounds the COMBINED reasoning + content output, so any finite cap
> can be spent entirely on the thinking stream — leaving `content` empty (finish_reason "length")
> before the model ever emits the JSON.

Our transport can do the same: `sendRequest(profileId, messages, maxTokens)` forwards `max_tokens`
into `ChatCompletionService.processRequest`, and `createRequestData()` deletes every `undefined`
value (`custom-request.js:444-449`) before `JSON.stringify` — so `undefined` means the field never
reaches the provider. `transportFor()` (in `lorebook-rebuild.js`) returns exactly that, and the
module exports `BOUNDLESS_MAX_TOKENS === undefined` so no caller can quietly reintroduce a cap.

`temperature: 0.2` rides the payload (`overridePayload`), no client-side timeout: a chunked build of
a big book legitimately takes minutes. A source whose API *requires* `max_tokens` (Anthropic-style)
is a named refusal rather than a silent default — none of the four profiles here are.

Before the first real build, one logged request must show no `max_tokens` in the body (§11).

### 5.2 Parsing (`_stripFences` `:377`, `_coerceEntries` `:389`, `_buildEntry` `:410`)

1. fence: `/^```(?:json)?\s*([\s\S]*?)\s*```$/i` -> take group 1;
2. then cut to the outermost JSON: from the first `[`/`{` to `max(lastIndexOf('}'), lastIndexOf(']'))`;
3. coerce: an array is the list; `parsed.entries` as list or map; else `parsed.lorebook` as list;
   anything else is empty;
4. per entry: `key|keys|keywords`, `keysecondary|secondary_keys|keySecondary`, `content|text`,
   `comment|title|name|category` (fallback `Entry <n>`), `order|priority|insertion_order` only when
   numeric (default 100), `constant === true`;
5. keys: an array, or a comma-separated string; trimmed, empties dropped (no de-duplication in Glaze —
   we de-duplicate, a proven no-op for the site's output and a guard against repeated names).

`position` in Glaze is `matchGlobal`; ST has no such field — leave ST's own default from
`createWorldInfoEntry`. `content` is NOT dropped when empty by Glaze — we drop a contentless entry and
count it, because ST would otherwise save a dead trigger.

### 5.3 Failure and resume (`:502-527, :547-640`)

* A part with no usable entry -> **fail the build**. No empty book, no partial save.
* Part cache keyed by `profileId + model + exact messages`; cleared on success; a build failing at
  14 of 20 resumes at 14 (`[Resume]`).
* Errors carry `part i/n`, the raw reply, the reasoning text when the provider returns one, and
  `resumable`.

## 6. UI

One dialog per scripted book:

```
Lorebook: <name>                                    <n> tokens of source
Model: <profile> / <model>   (changeable; says when it is the active connection)

Context for key inference                       Request plan
  [x] Character card          <n> tok             1 request (~<n> input tokens)
  [x] Site description        <n> tok
  [x] Scenario                <n> tok
  [ ] Greetings               <n> tok              [Preview prompt]  [Cancel]  [Build]
  [ ] Other lorebooks         <n> tok
  [ ] Additional text         <n> tok
```

* counts from `getTokenCountAsync` on the exact strings, never `length / 4`;
* the plan comes from the **same** `planBuild()` that sends, so the preview cannot drift (Glaze's rule:
  the preview is built by the sending function, `:323-326`);
* `[Preview prompt]` renders the exact system + user messages, read-only, no network;
* book state: `building 2/3` -> `saved 12 entries` | `failed at part 2/3: <reason>` + `[Resume]`;
* defaults are Glaze's (`janitor_lorebook_capture_sheet.dart:167-191`): card, catalog, scenario on;
  greetings, other lorebooks, extra off.

## 7. The site description block

`catalog` is Glaze's ~2900-token "Card description on site". Our server stores only the short public
bio (`weavers-vault-janitor.js:319-322`). Enabling `catalog` therefore costs **one extra page fetch per
build**, cached per character for the session. Decision 2026-11-26: we feed it, toggle on by default,
its token count visible before spending. The fetch needs a janitorai.com go-ahead; the rebuild works
with it switched off.

## 8. Saving

```js
const data = { entries: {} };
for (const raw of parsedEntries) {
    const entry = createWorldInfoEntry(name, data);        // ST's template, every field present
    entry.key = raw.key; entry.keysecondary = raw.keysecondary;
    entry.comment = raw.comment; entry.content = raw.content;
    entry.order = raw.order; entry.constant = raw.constant;
}
await saveWorldInfo(name, data, true);                     // immediately — same as the public path
await updateWorldInfoList();
await stampVaultProvenance(avatar, { vault_lorebooks: savedNames });   // index.js:3117
```

Provenance stays on the card (`vault_lorebooks`, merge-attributes per PITFALLS #1) exactly as the
public import does; the book JSON gets no extra keys, so nothing tool-specific leaks into a World
Info file the user may export. Glaze stamps nothing at all.

**Deviation from Glaze, deliberate:** Glaze saves the rebuilt book disabled and scoped to the
character. ST has no book-level scope — binding is the character's `world` field — and the vault does
not rewrite a character's binding as a side effect. Entries are saved enabled, the book is not attached
automatically, and the toast names it so it can be selected on the character.

## 9. Files

```
weavers-vault/lorebook-rebuild.js   NEW   pure core: prompts, planBuild(), messagesFor(), parseReply(),
                                          chunkText(), budget(). No imports, no DOM — Jest imports it.
weavers-vault/index.js                    dialog, per-book state, save, progress, resume
weavers-vault/style.css                   dialog styles (reuse .wv-dwin / .wv-acc patterns)
weavers-vault/docs/PITFALLS.md            only if a bug ships
tests/vault/lorebook-rebuild.test.js NEW  §10
```

`planBuild()` takes injected `countTokens` and `window`, so every rule below is testable without a
browser or a network call.

## 10. Tests (no network, no connection profile)

Standing rule from 2026-11-26: **no test and no slice may call a connection profile without an
explicit go-ahead from the user**, who will switch to a cheaper model for the run that matters. The
core below is pure, so every rule is proven offline; the first real call is a separate, asked-for
step.


1. text under budget -> 1 request; system = text prompt; user ends with the raw-text header; the
   selected blocks appear in order with their exact intros.
2. an unselected or empty block is absent — no header with nothing under it.
3. over budget -> N requests, each carrying the full context, each within budget, and
   `chunks.join` reconstructs the source with no text lost or duplicated.
4. `fromJs` -> always 1 request, even far over budget; system = the JS prompt; `chunkTokens: 0` -> 1.
5. budget: window 0 -> no clamp; small window -> floor 2000; never negative.
6. `chunks.length <= 1` -> the whole text is sent, not a chunk.
7. parse: fenced reply; bare array; `lorebook` key; `entries` as a map; `keys`/`text`/`title`/`priority`
   aliases; `constant: true`; missing order -> 100; contentless entry dropped and counted.
8. parse failure -> `VaultRebuildError` naming the part, never an empty list.
9. resume: a cached part is not resent; a different model misses the cache.
10. `transportFor()` hands the transport `undefined` `max_tokens` (the test asserts it), so the
    request body carries no output cap at all; temperature is 0.2.

## 11. Done means

* §10 green plus the existing 358 vault tests;
* one logged real request whose body matches the preview byte for byte, and whose `max_tokens` is the
  large value (this is the check §5.1 demands);
* one real scripted book rebuilt and compared to the site: entry count within the site's, every entry
  has content and >= 1 key, and no context text leaked into an entry (grep an entry body for the first
  sentence of the card description);
* one forced failure (bad model id) showing `failed at part i/n` and a working `[Resume]`.

## 12. Open decisions

1. Where a rebuilt book lands: the same library list as public imports (plan) or its own group.
2. `[Build all]` for a card with several scripted books: sequential with a line per book (plan).
3. Whether the two system prompts should be editable in the dialog or only in extension settings
   (Glaze: settings only; plan: settings only, dialog shows the effective prompt in the preview).
