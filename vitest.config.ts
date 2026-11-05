import { defineConfig } from 'vitest/config';

// Minimal runner config per docs/TESTING.md §3: a vitest.config.ts exists so
// Vitest ignores vite.config.ts (no SvelteKit plugin needed) — the Phase 1
// tests cover pure modules only (lorebook engine, lorebook importer) and
// import them via relative paths, so no $lib alias is required either.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
