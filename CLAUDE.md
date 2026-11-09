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

### Phase 2: Offline-capable two-way sync (mostly done, in use)
- Syncs: chats, characters, lorebooks, settings (everything under `data/`).
- Does NOT sync: API keys (per-device secrets).
- Design DECIDED, full spec in `docs/SYNC-SPEC.md` (read it before touching sync). Summary: hub-and-spoke over Tailscale (personal server = hub running the same Loreweaver backend), file-level sync with SHA-256 hashes, hub-assigned change-log `seq` for ordering, chats fast-forward by message prefix, any other conflict keeps the loser as a conflict copy (never lose data). Cloud drives not used.
- Status: milestones 1-7 IMPLEMENTED (paths/scan/state, hub router, client engine+transport, chat merge, scheduler, token CLI `sync-token.js`, UI status block), 120 tests in `tests/sync/`. VERIFIED END-TO-END in real use: hub on `thinkpad-srv` (Debian 13, over Tailscale) syncing with the Windows client. Key setup detail: the hub router must be mounted BEFORE session/CSRF/login middleware (bearer-token device traffic) — already done in `src/server-main.js`.
- Settings merge: `settings.json` syncs via per-key 3-way merge (`src/sync/settings-merge.js`) with device-local keys; `sync.settingsAuthoritativeDevice` names the device whose values win key clashes (set only in that device's config; the PC here).
- Opt-ins: `sync.syncExtensions` and `sync.syncSecrets` widen the deny list (extensions dir / root `secrets.json` only); both flags needed on hub AND client; nested `secrets*` always denied.
- Retention: `sync.retentionDays` pruning of `sync-trash/`/`sync-conflicts/` is IMPLEMENTED (`src/sync/retention.js`, runs on the scheduler for both hub and client roles).
- Remaining: milestone 8 — running the acceptance checklist in spec section 12. Linux device onboarding is SKIPPED (user decision, 2026-11: Termux on Android covers it; no separate Linux device will be onboarded). S21 Ultra done, see `docs/SYNC-ONBOARDING.md` for the procedure.

### Phase 3: Packaging
- Standalone apps: each bundles its own Node backend (no separate server).
- Windows/Linux: Electron or similar. Android is the hard one (embedded Node, e.g. nodejs-mobile).

### Phase 4: Models
- LLM provider will be switched later; keep provider config swappable. Cost per token was the reason the earlier project (original Loreweaver rewrite) was abandoned, so prefer adapting what exists over rebuilding.

## Working agreements
- Small, focused commits. Ask before merging `rebrand` into `release` or pushing.
- Never push without asking.
- Prefer minimal changes to the existing SillyTavern code; adapt rather than rewrite.
