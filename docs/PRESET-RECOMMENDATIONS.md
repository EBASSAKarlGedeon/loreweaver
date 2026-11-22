# Preset & Extension Recommendations — from analysing Pura 16.0 and Sola V4

Written 2026-11-11, after full-text analysis of two community presets:

- **Pura's Director Preset 16.0** (77 prompts, ~11 active by default) — `OpenAI Settings/Pura's Director Preset 16.0 (SillyTavern).json`
- **Sola V4 Flame ST** (137 prompts) — `OpenAI Settings/☀️ 🧡 Sola V4 Flame ST 🧡 ☀️.json`

Goal: feed the **FF 5.4 preset update** and the **Character Extensions** (see `CHARACTER-CELLS-SPEC.md`). Read this alongside that spec; nothing here changes the Character Cells slice plan by itself.

---

## 1. What each preset actually is (one paragraph each)

**Pura** is a lean core plus a big dormant menu. One ~1300-token Main Prompt written as a style guide
(every rule carries its reason in the same sentence), a famous anti-slop banned-phrase list, and two
families of toggles: **session modes** (Friction, NSFW, Nightmare, Genre, Voices — delivered through
`{{setvar}}`/`{{getvar}}` variables so a toggle's text lands at one fixed slot inside the Main Prompt,
rendering as *nothing* when off) and **per-message dice tables** (Chaos Mode, Genre Randomiser,
Scene Pressure Cocktail — injected as user-role messages at depth 0, so they re-roll every reply).
Trackers are exact-format blocks (`[SCENE|Loc|Time|Mood]`) designed to be parsed by regex into pretty
cards — the format is a *contract with a renderer*.

**Sola** is the same variable trick industrialised: every module writes a variable, one "Master
Blueprint" manifest assembles them into tagged containers (`<sola_prose>`, `<sola_intimacy>`…), and a
"Secret Drawer" assembles trackers after chat history. Its distinctive layers: five playable
**co-author personas** ("Minds" — the meta layer is a character), a complete **typographic language**
(`<copper:whisper>"..."`, gradients, kinetic tags, hover subtext), a **reasoning-embedded story
review** (a checklist injected into the thinking, with a 3-anchor draft rule: OPEN / FOCUS / YIELD),
and **the Easel** — a full showrunner ledger with stable IDs, pressure states, planted seeds, and a
"directorial dare" rated back next turn.

## 2. The transferable patterns

These are the ideas worth stealing, independent of which preset:

| # | Pattern | Source | What it means |
|---|---------|--------|---------------|
| P1 | **Rule → reason in one breath** | Pura | Every bullet: imperative + why ("Only literal parrots will echo or repeat previous wording"). Models follow it better than bare commands. |
| P2 | **Modes as variables, not blocks** | Pura + Sola | A toggle writes a var; one manifest consumes it at a fixed slot. Off = literally zero tokens. |
| P3 | **Shared-variable exclusivity** | Pura | Mutually exclusive options write the *same* var (`writefor`, `length`, `narration`) — last one enabled wins. Exclusivity enforced by the machine, not by user discipline. |
| P4 | **Per-message spice = depth-0 injection** | Pura | Randomisers/scene modifiers live as `role=user` injections so they re-roll each turn; persistent config routes via vars instead. Two lanes for two lifetimes. |
| P5 | **Independent axes for variety** | Pura | Scene Pressure Cocktail: 5 tables × ~16 options combined = thousands of textures from one toggle. Beat repetition by rolling *axes*, not scenarios. |
| P6 | **Tracker output contract** | Pura | Exact bracket format + mandatory non-empty cause field + "only what changed" + "most scenes: nothing" (silence is the default state). |
| P7 | **Triple-artifact modules** | Sola | Each module ships THREE texts: the instruction payload, a one-line *review reminder* (re-check while drafting), and an *audit line* (what PASS/WARN looks like after). This is what makes a big optional system hold together. |
| P8 | **Kill-switch prompts** | Sola | "Zero HTML" / "Zero Trackers": prompts that exist only to empty every slot above them. One switch wipes a whole layer. |
| P9 | **Reasoning-embedded review** | Sola | Review checklist + 3 anchors (OPEN/FOCUS/YIELD) injected into the thinking pass, fragments only, hard stop once YIELD is locked. |
| P10 | **Meta layer as a character** | Sola | The person running the preset is performed (persona, endearments, sign-off, OOC mannerism script with worked examples). |
| P11 | **Emotion-as-arc modules** | Sola | Yearning / Courtship / Repair / Aftercare: treat feelings as *scenes with cost and evidence*, not state flips. "Trust returns by evidence across the next scenes, not one conversation." |
| P12 | **Fidelity-by-audit trackers** | Sola | Orientation immutable from the card, anti-mirror gate ("render-only inputs"), mask vs motive, a stated Boundary line, one-line directorial audit. |
| P13 | **Diegetic UI** | Pura + Sola | Stats/documents the *characters* can see and argue with (Pura's Diegetic Stats) vs documents rendered as HTML artifacts (Sola's Tools). Both increase immersion; both need renderer support. |
| P14 | **README-as-prompt** | Pura | The manual + changelog ships as a never-enabled prompt inside the preset file. Self-documenting distribution. |

## 3. Recommendations: FF 5.4 preset update

For the FF 5.4 preset (FF5 mechanics + World Sim tables port; see CHARACTER-CELLS-SPEC.md §FF):

1. **Adopt P2 + P3 as the toggle architecture.** FF 5.4's mode toggles (World Sim on/off, cells on/off,
   GM-voice level) become `{{setvar}}` stubs consumed by one manifest block. Mutually exclusive
   settings (e.g. "World Sim: full / light / off") share one variable name so a stale combo can't
   coexist. *(Pura's machine-enforced exclusivity; Sola's blueprint placement.)*
2. **Adopt P7 for every new module.** When a module is added, write all three artifacts at once:
   the instruction, its one-line draft-time reminder, and its audit line. Cheap to do now, painful
   to retrofit. (If FF 5.4 ships without Sola's Easel, the "audit line" can be a self-check bullet
   instead of a rendered PASS/WARN row.)
3. **Adopt P5 for the world sim.** Rather than more scenario tables, give the World Sim
   *independent axes* (e.g. pressure / consequence / off-screen motion / social weather) that combine
   per turn. This is the cheapest fix for the "same three random events recycle" complaint.
4. **Adopt P6 as the house rule for any output block.** Every FF 5.4 tracker/table block follows:
   exact format, mandatory cause line, changed-only, default silence.
5. **Adopt P1 in every rewrite.** When touching existing FF 5.4 prompt text, upgrade bare commands
   to rule+reason. Don't bulk-rewrite; upgrade opportunistically.
6. **Adopt P14.** Put the FF 5.4 manual/changelog in as a never-enabled prompt so the shipped file
   explains itself.
7. **Skip for now:** Sola's reasoning-embedded review (P9) — powerful but model-specific and
   token-heavy; revisit after slice work settles. P10 meta-personas — a taste decision, and FF 5.4
   already has a GM voice; keep it invisible unless the user asks.

## 4. Recommendations: Character Extensions

For the extension-side work (Character Cells FF 5.4 mechanics + UI):

1. **Cells ↔ Pura's Relationship Tracker (P6 + P12).** Pura's dating-sim card is the closest existing
   analogue to a character cell: stage ladder (Stranger→Devoted, cold + tangled variants), a route
   label, one-rung-per-scene maximum, can go backwards, likes/dislikes gated behind *on-screen
   discovery*, a keepsake memory, a named next threshold, 💀 SEVERED retirement. Steal its
   *behavioural rules* (one rung max per scene; discovery-gated lists; separate "heart" vs "trust"
   that may disagree) as cell-update semantics — they prevent the classic "cell jumps to Devoted
   because the user was nice twice" failure.
2. **Cells ↔ Sola's {{char}} Matrix (P12).** For the cell audit story: orientation/fidelity is
   immutable from the card; user traits are "render-only inputs"; a stated Boundary line that the
   cell's audit verifies each turn; mask-vs-motive as the observable gap. Maps directly onto the
   FF5 ledger's tier checks (PASS/WARN language is Sola's — consider borrowing the vocabulary).
3. **Renderer contract from day one (P6/P13).** Whether cells render as Pura-style regex cards or
   Sola-style HTML artifacts, the *format law* paragraph (exact shape, field order, "reproduce this
   shape exactly, every time") belongs in the spec before the prompt text is written. Pura's
   changelog notes a missing closing tag broke the whole card — format bugs are found only by
   stress-testing real renders.
4. **Digest line (Sola's Master HUD).** If cells surface in a HUD-like summary, use Sola's
   25-word `digest` attribute pattern (day · time · gear · T/F/D/Y numbers) as the glanceable
   one-liner above the detail.
5. **Optional later: chatterbox-style co-author feed (P10).** A rolling short text thread where the
   system comments on cell state would be a charming stretch goal — only after the core cells slice.

## 5. Priority order (suggested)

1. FF 5.4: toggle architecture via shared-variable exclusivity (P2/P3) — foundational.
2. FF 5.4: triple-artifact module pattern (P7) — cheap now, expensive later.
3. Extension: cell behavioural rules from Pura's Relationship Tracker + Sola's Matrix (P12).
4. FF 5.4: World Sim as independent axes (P5).
5. Everything else opportunistically (P1, P6, P14).

## 6. Caveats learned from reading both

- **Variable routing is chat-scoped.** A toggle prompt must stay enabled to refresh its var; a
  disabled toggle leaves a stale value behind until it's zeroed (Sola solves this with a giant
  "macro state zeroing" block that clears ~200 vars at prompt start — Pura just accepts the quirk).
  If FF 5.4 adopts P2, it needs a zeroing block too.
- **Anti-slop blacklists backfire on small models.** Pura ships its Grounded Prose Rules off by
  default for weak models; same caution applies to any banned-list we add.
- **Format law or death.** Both presets learned through breakage that the renderer's exact expected
  shape must be stated in the prompt ("The renderer matches this exact shape and draws the record as
  a card") — and even then, one stray closing tag breaks it. Budget real-device render testing.
- **Token discipline:** Pura's plug-and-play is ~1300 tokens; Sola's fully-laden build is far heavier.
  FF 5.4's core should stay in Pura's weight class; Sola-weight builds are opt-in per module.
