# LoreWeaver

An immersive AI character platform for roleplay, storytelling, and creative writing — inspired by SillyTavern, built to sync across your devices through your own server.

This is the **Phase 1 MVP**: the working spine. It runs entirely in the browser (offline-first via IndexedDB) and talks to any OpenAI-compatible LLM endpoint.

## What works right now

- **Character cards** — create / edit / delete characters (name, description, personality, scenario, first message). Stored locally.
- **Chat** — stream replies from an LLM, with persistent per-character chat history.
- **Studio** — point LoreWeaver at OpenAI or any local model server (Ollama, llama.cpp, KoboldCpp) from the Model tab (base URL, model, API key), and change the look from the other tabs. Open it with the gear in the top bar.
- **Works offline** — everything is stored in IndexedDB; no backend required yet.

## Roadmap

- **Phase 2 — The soul:** lorebooks / world-info (keyword-triggered context injection), personas, prompt presets, message branching/regeneration.
- **Phase 3 — Sync:** a self-hosted server (Node + Hono + SQLite) for accounts, cross-device sync, and an LLM proxy so API keys never sit on your devices.
- **Phase 4 — Shells:** wrap the web app in Tauri (desktop) and Capacitor (mobile) so it becomes a real app.
- **Phase 5 — SillyTavern's depth:** group chats, regex scripts, quick replies, author's notes, TTS/STT, image-gen hooks, an extension system.

## Get started

```bash
npm install
npm run dev
```

Open the printed URL (default http://localhost:5173), then:

1. Open **Studio** (the gear in the top bar) and go to the **Model** tab. Pick a provider and set the model (and API key, if using OpenAI).
2. Go to **Characters** and create a character.
3. Go to **Chat**, pick the character, and start writing.

### Connecting a local model

For a fully private setup, run [Ollama](https://ollama.com) and pull a model (e.g. `ollama run llama3.1`), then in Studio → Model set:

- **Base URL:** `http://localhost:11434/v1`
- **Model:** `llama3.1` (or whichever you pulled)
- **API key:** leave blank

## Project layout

```
src/
  app.html / app.css        app shell + global styles
  lib/
    types.ts                Character, Chat, ChatMessage, Settings
    db.ts                   Dexie (IndexedDB) — offline-first store
    llm.ts                  OpenAI-compatible streaming client
    prompt.ts               assembles the prompt from card + history
    state/settings.svelte.ts reactive settings singleton
  routes/
    +layout.svelte          nav + global setup
    +page.svelte            the chat screen
    characters/+page.svelte character editor
    settings/+page.svelte   connection settings
```

## Tech

SvelteKit (Svelte 5, runes) · Dexie/IndexedDB · TypeScript. The sync server and native shells come later — same language, same frontend, no rewrites.
