import { describe, test, expect } from '@jest/globals';
import {
    JANITOR_DEFAULT_CONTEXT_LENGTH,
    janitorAccountDiff,
    janitorAccountSnapshot,
    janitorDirtyReason,
    janitorDummyPreset,
    janitorIsOwnPreset,
    janitorRestorePlan,
    janitorStrayPresets,
} from '../../src/endpoints/weavers-vault-janitor-account.js';

/** The live shape of GET /hampter/api-settings, measured 2026-11-24. */
function apiSettings({ selected = 'preset-real', source = 'proxy', contextLength = 128000, presets = null } = {}) {
    return {
        legacy_config: {},
        materialized: true,
        prompts: [],
        proxy_configs: presets ?? [
            { id: 'preset-real', client_id: 'aaa', name: 'Gemini FLash 8', api_url: 'https://openrouter.ai/api/v1/chat/completions' },
            { id: 'preset-two', client_id: 'bbb', name: 'Openrouter', api_url: 'https://api.lorebary.com/openrouter' },
        ],
        settings: {
            selected_proxy_config_id: selected,
            source,
            generation_settings: { top_k: 0, temperature: 1.2, context_length: contextLength },
            openai_model: 'zai-org/glm-5.1',
        },
    };
}

describe('janitorIsOwnPreset', () => {
    test('the loopback URL is the marker a real preset can never have', () => {
        expect(janitorIsOwnPreset({ api_url: 'http://127.0.0.1:8123/v1/chat/completions' })).toBe(true);
        expect(janitorIsOwnPreset({ api_url: 'https://openrouter.ai/api/v1/chat/completions' })).toBe(false);
        expect(janitorIsOwnPreset({ api_url: undefined })).toBe(false);
    });
});

describe('janitorDummyPreset', () => {
    test('matches the shape the site accepts, with a fresh client_id each run', () => {
        let n = 0;
        const random = () => { n = (n + 0.037) % 1; return n; };
        const first = janitorDummyPreset({ random });
        const second = janitorDummyPreset({ random });
        expect(Object.keys(first).sort()).toEqual(['api_key', 'api_url', 'client_id', 'model', 'name', 'prompt_id'].sort());
        expect(first.model).toBe('gpt-4o');
        expect(first.prompt_id).toBeNull();
        expect(first.api_key).toMatch(/^sk-[a-z0-9]{48}$/);
        expect(first.api_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
        expect(first.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
        // JanitorAI permanently burns each client_id, so two runs must differ.
        expect(second.client_id).not.toBe(first.client_id);
        // And a dummy must be recognisable as ours by URL alone.
        expect(janitorIsOwnPreset(first)).toBe(true);
    });
});

describe('janitorAccountSnapshot', () => {
    test('reads the selection out of settings, not the top level', () => {
        const snapshot = janitorAccountSnapshot(apiSettings(), { takenAt: '2026-11-24T00:00:00.000Z' });
        expect(snapshot.selectedProxyConfigId).toBe('preset-real');
        expect(snapshot.source).toBe('proxy');
        expect(snapshot.contextLength).toBe(128000);
        expect(snapshot.hadOwnPresets).toBe(true);
        expect(snapshot.presetIds).toEqual(['preset-real', 'preset-two']);
        expect(snapshot.takenAt).toBe('2026-11-24T00:00:00.000Z');
    });

    test('an account with only our leftovers counts as having no presets of its own', () => {
        const snapshot = janitorAccountSnapshot(apiSettings({
            presets: [{ id: 'dummy', api_url: 'http://127.0.0.1:9000/v1/chat/completions' }],
        }));
        expect(snapshot.hadOwnPresets).toBe(false);
    });

    test('a missing context length is recorded as null, not zero', () => {
        const payload = apiSettings();
        delete payload.settings.generation_settings.context_length;
        expect(janitorAccountSnapshot(payload).contextLength).toBeNull();
    });
});

describe('janitorAccountDiff', () => {
    test('empty when the account is as it was', () => {
        const snapshot = janitorAccountSnapshot(apiSettings());
        expect(janitorAccountDiff(snapshot, apiSettings())).toEqual([]);
    });

    test('names each changed field with both values', () => {
        const snapshot = janitorAccountSnapshot(apiSettings());
        const dirty = apiSettings({ selected: 'dummy', contextLength: 0 });
        expect(janitorAccountDiff(snapshot, dirty)).toEqual([
            { field: 'selected_proxy_config_id', expected: 'preset-real', actual: 'dummy' },
            { field: 'generation_settings.context_length', expected: 128000, actual: 0 },
        ]);
    });

    test('a null snapshot has nothing to compare against', () => {
        expect(janitorAccountDiff(null, apiSettings())).toEqual([]);
    });
});

describe('janitorStrayPresets', () => {
    test('finds the presets a killed capture left behind', () => {
        const payload = apiSettings({
            presets: [
                { id: 'real', api_url: 'https://openrouter.ai/api/v1/chat/completions' },
                { id: 'left', api_url: 'http://127.0.0.1:8123/v1/chat/completions' },
            ],
        });
        expect(janitorStrayPresets(payload)).toEqual([{ id: 'left', url: 'http://127.0.0.1:8123/v1/chat/completions' }]);
    });
});

describe('janitorRestorePlan', () => {
    test('restores the selection, source and context length when the user had presets', () => {
        const plan = janitorRestorePlan(janitorAccountSnapshot(apiSettings()));
        expect(plan.selected).toBe('preset-real');
        expect(plan.source).toBe('proxy');
        expect(plan.generationSettings.context_length).toBe(128000);
    });

    test('an account with no presets goes back to the site model, not to a null selection', () => {
        const plan = janitorRestorePlan(janitorAccountSnapshot(apiSettings({
            selected: null,
            source: 'janitor',
            presets: [],
        })));
        expect(plan.selected).toBeNull();
        expect(plan.source).toBe('janitor');
    });

    test('a snapshot without a numeric context length restores 4096, never 0', () => {
        const payload = apiSettings();
        payload.settings.generation_settings.context_length = null;
        const plan = janitorRestorePlan(janitorAccountSnapshot(payload));
        expect(plan.generationSettings.context_length).toBe(JANITOR_DEFAULT_CONTEXT_LENGTH);
    });
});

describe('a fresh account that never configured API settings', () => {
    /** Measured on a second account: 200 with settings holding only nulls. */
    function freshAccount() {
        return {
            proxy_configs: [],
            settings: { selected_proxy_config_id: null, source: null, generation_settings: null },
        };
    }

    test('its snapshot records nulls rather than pretending to have values', () => {
        const snapshot = janitorAccountSnapshot(freshAccount());
        expect(snapshot.selectedProxyConfigId).toBeNull();
        expect(snapshot.source).toBeNull();
        expect(snapshot.contextLength).toBeNull();
        expect(snapshot.hadOwnPresets).toBe(false);
    });

    test('restoring still patches a context length, because the capture left 0', () => {
        const plan = janitorRestorePlan(janitorAccountSnapshot(freshAccount()));
        expect(plan.selected).toBeNull();
        // No presets of its own ⇒ the site's own model, not a null selection.
        expect(plan.source).toBe('janitor');
        // Leaving generation_settings null would leave context_length at 0.
        expect(plan.generationSettings.context_length).toBe(JANITOR_DEFAULT_CONTEXT_LENGTH);
    });

    test('a field the snapshot never had can never read dirty', () => {
        // Before this, `source: null` vs `'janitor'` and `null` vs `4096` stayed in
        // the diff forever, so the account could never be reported clean again.
        expect(janitorAccountDiff(janitorAccountSnapshot(freshAccount()), {
            proxy_configs: [],
            settings: { selected_proxy_config_id: null, source: 'janitor', generation_settings: { context_length: 4096 } },
        })).toEqual([]);
    });
});

describe('janitorDirtyReason', () => {
    test('says nothing when the account is clean', () => {
        expect(janitorDirtyReason({ diff: [], strays: [] })).toBe('');
        expect(janitorDirtyReason(null)).toBe('');
    });

    test('states the exact diff so the user can see the damage', () => {
        const reason = janitorDirtyReason({
            diff: [{ field: 'generation_settings.context_length', expected: 128000, actual: 0 }],
            strays: [{ id: 'left' }],
        });
        expect(reason).toContain('generation_settings.context_length: 128000 → 0');
        expect(reason).toContain('1 leftover capture preset');
        expect(reason).toContain('Restore it before importing again');
    });
});
