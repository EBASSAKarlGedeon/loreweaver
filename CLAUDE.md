# Loreweaver

Personal, immersive AI chatbot platform. Forked from SillyTavern (AGPL-3.0) and gradually adapted into Loreweaver.
Personal use only. The AGPL license and upstream credits must stay intact.

## Goal

Standalone apps for **Windows, Linux and Android**, with **offline-capable two-way sync** between devices.

## Repo setup

- `origin` -> https://github.com/EBASSAKarlGedeon/loreweaver.git (ask before pushing)
- `upstream` -> https://github.com/SillyTavern/SillyTavern (pull upstream fixes with `git fetch upstream`)
- History is kept from upstream (`release` branch = upstream release).
- `public/ReVardanis/` is just character card images. Ignore it.

## Plan

### Phase 1: Rebrand (COMPLETE, merged into `release` and pushed)
- All user-visible branding is Loreweaver: titles, welcome/login/splash screens, README, package.json, manifest.json, locales (16 files), logo, apple-icons, favicon.ico, system avatar (`img/five.png`), version display (server agent in `src/util.js` + frontend `displayVersion` in `public/script.js`). Old `logo.svg` deleted.

Tier 2, internal identifiers (NOT renamed; renaming breaks extensions and existing data):
- `SillyTavern` global, localStorage keys, `data/` layout, `st-` CSS prefixes.

Tier 3, legal (never change):
- AGPL license text and upstream attribution.

Post-Phase-1 sweep (2026-11-10): a full repo triage of `SillyTavern` strings (484 hits / 119 files) rebranded all remaining stale user-visible strings — server startup banner/window title/listen logs, security + whitelist + port-in-use messages, recover.js CLI, in-app popups/toasts/slash-command help, `Remote-Link.cmd`, `Update-Instructions.txt`, `docker-compose.yml` (service/container/hostname/image -> loreweaver), basic-auth realm, `--help` text, Electron package description, launcher .bat/.sh title/echo branding. Internal identifiers, attribution links, `.github/` + `default/` scaffold, and API-identifying strings were kept. Intentional keeps (do NOT re-flag these): the `SillyTavern System` chat sender name (renaming would orphan existing chats' sender labels + TTS voice mappings), the Horde client agent string, HTTP user-agents sent to content sites, and `X-Title`/provider-identifying headers. Note: popups/toasts/help strings use their English text as i18n keys; translated locales now fall back to the new English wording.

### Phase 2: Offline-capable two-way sync (COMPLETE, in use)
- Syncs: chats, characters, lorebooks, settings (everything under `data/`).
- Does NOT sync: API keys (per-device secrets).
- Design DECIDED, full spec in `docs/SYNC-SPEC.md` (read it before touching sync). Summary: hub-and-spoke over Tailscale (personal server = hub running the same Loreweaver backend), file-level sync with SHA-256 hashes, hub-assigned change-log `seq` for ordering, chats fast-forward by message prefix, any other conflict keeps the loser as a conflict copy (never lose data). Cloud drives not used.
- Status: milestones 1-7 IMPLEMENTED (paths/scan/state, hub router, client engine+transport, chat merge, scheduler, token CLI `sync-token.js`, UI status block), 120 tests in `tests/sync/`. VERIFIED END-TO-END in real use: hub on `thinkpad-srv` (Debian 13, over Tailscale) syncing with the Windows client. Key setup detail: the hub router must be mounted BEFORE session/CSRF/login middleware (bearer-token device traffic) — already done in `src/server-main.js`.
- Settings merge: `settings.json` syncs via per-key 3-way merge (`src/sync/settings-merge.js`) with device-local keys; `sync.settingsAuthoritativeDevice` names the device whose values win key clashes (set only in that device's config; the PC here).
- Opt-ins: `sync.syncExtensions` and `sync.syncSecrets` widen the deny list (extensions dir / root `secrets.json` only); both flags needed on hub AND client; nested `secrets*` always denied.
- Retention: `sync.retentionDays` pruning of `sync-trash/`/`sync-conflicts/` is IMPLEMENTED (`src/sync/retention.js`, runs on the scheduler for both hub and client roles).
- Acceptance checklist (spec section 12): DONE 2026-11-10. All 123 tests in `tests/sync/` pass; every acceptance item is covered by automated tests — character edit A<->B convergence and chat fast-forward both directions (`engine.test.js` "edit on A converges to B", "chat continued on A then on B fast-forwards"), diverged offline chats keep both versions as conflict copy (`engine.test.js` "diverged chats keep both versions", `merge.test.js`), delete-on-A trash flow (`engine.test.js` "delete on A removes the file on B and trashes it"), secrets denial with/without opt-in (`hub.test.js`), traversal/absolute/denied-path rejection (`hub.test.js` + `paths.test.js`), crash-safe atomic writes (`scan-state.test.js` `atomicWriteFile`), and offline-tolerance/convergence (`engine.test.js` + `scheduler.test.js`). Real-device end-to-end (item flows 1-3 live) was already verified in use: hub on `thinkpad-srv` (Debian 13, over Tailscale) <-> Windows client <-> S21 Ultra. Linux device onboarding is SKIPPED (user decision, 2026-11: Termux on Android covers it; no separate Linux device will be onboarded) — see `docs/SYNC-ONBOARDING.md` for the S21 Ultra procedure.

### Phase 3: Packaging
- Standalone apps: each bundles its own Node backend (no separate server).
- Windows/Linux: Electron or similar. Android is the hard one (embedded Node, e.g. nodejs-mobile).

### Phase 4: Models
- LLM provider will be switched later; keep provider config swappable. Cost per token was the reason the earlier project (original Loreweaver rewrite) was abandoned, so prefer adapting what exists over rebuilding.

## Working agreements
- Small, focused commits. Ask before merging `rebrand` into `release` or pushing.
- Never push without asking.
- Prefer minimal changes to the existing SillyTavern code; adapt rather than rewrite.
- Every user-found bug that does NOT require a code correction (config fix, procedure, misunderstanding) gets an entry in `docs/FAQ.md` (symptom → cause → fix), so it isn't rediscovered later.
