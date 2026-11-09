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

### Phase 2: Offline-capable two-way sync (next)
- Syncs: chats, characters, lorebooks, settings (everything under `data/`).
- Does NOT sync: API keys (per-device secrets).
- Needs a design decision: file-level vs. record-level merge, conflict resolution, change log/versioning.
- ST stores everything as files, so a per-file change log with timestamps/hashes is the likely starting point.

### Phase 3: Packaging
- Standalone apps: each bundles its own Node backend (no separate server).
- Windows/Linux: Electron or similar. Android is the hard one (embedded Node, e.g. nodejs-mobile).

### Phase 4: Models
- LLM provider will be switched later; keep provider config swappable. Cost per token was the reason the earlier project (original Loreweaver rewrite) was abandoned, so prefer adapting what exists over rebuilding.

## Working agreements
- Small, focused commits. Ask before merging `rebrand` into `release` or pushing.
- Never push without asking.
- Prefer minimal changes to the existing SillyTavern code; adapt rather than rewrite.
