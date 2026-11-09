# Loreweaver

Personal, immersive AI chatbot platform. Forked from SillyTavern (AGPL-3.0) and gradually adapted into Loreweaver.
Personal use only. The AGPL license and upstream credits must stay intact.

## Goal

Standalone apps for **Windows, Linux and Android**, with **offline-capable two-way sync** between devices.

## Repo setup

- `origin` -> https://github.com/EBASSAKarlGedeon/loreweaver.git (not pushed yet; ask before pushing)
- `upstream` -> https://github.com/SillyTavern/SillyTavern (pull upstream fixes with `git fetch upstream`)
- Working branch history is kept from upstream (`release` branch).
- `public/ReVardanis/` is just character card images. Ignore it.

## Plan

### Phase 1: Rebrand (current)
Tier 1, user-visible (do first):
- Page titles, UI text, README, Start.bat, package.json name, logos/favicons.

Tier 2, internal identifiers (DO NOT rename yet; it breaks extensions and existing data):
- `SillyTavern` global, localStorage keys, `data/` layout, `st-` CSS prefixes.

Tier 3, legal (never change):
- AGPL license text and upstream attribution.

### Phase 2: Offline-capable two-way sync
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
- Small, focused commits, ideally on a `rebrand` branch rather than directly on `release`.
- Never push without asking.
- Prefer minimal changes to the existing SillyTavern code; adapt rather than rewrite.
