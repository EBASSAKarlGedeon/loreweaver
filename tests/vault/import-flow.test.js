import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
    bookKinds,
    captureBack,
    captureConfirmClose,
    captureStage,
    captureStages,
    hasAttachedBooks,
    importOptions,
    lorebookRefs,
} from '../../public/scripts/extensions/weavers-vault/import-flow.js';

/**
 * The import workflow, as decisions plus the contract that wires them.
 *
 * Glaze's import is one button (`character_detail_screen.dart:1026-1037`), a
 * sheet that only exists when the character lists lorebooks (`:281-283`), and a
 * four-stage capture sheet (`janitor_lorebook_capture_sheet.dart:943-951`). The
 * decisions are unit-tested here; the widget half is pinned by reading the
 * client, because `index.js` cannot be imported without a browser.
 */

const clientDir = path.resolve('public/scripts/extensions/weavers-vault');
const clientJs = fs.readFileSync(path.join(clientDir, 'index.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(clientDir, 'style.css'), 'utf8');
const serverJs = fs.readFileSync(path.resolve('src/endpoints/weavers-vault.js'), 'utf8');

describe('attached lorebooks', () => {
    test('only lorebook and advanced scripts are lorebooks', () => {
        const refs = lorebookRefs({
            scripts: [
                { id: 1, title: 'Court', type: 'lorebook' },
                { id: 2, title: 'Court JS', type: 'advanced', is_public: false },
                { id: 3, title: 'A plugin', type: 'script' },
                { title: 'No id', type: 'lorebook' },
                null,
            ],
        });
        expect(refs).toEqual([
            { id: '1', title: 'Court', isPublic: true },
            { id: '2', title: 'Court JS', isPublic: false },
        ]);
    });

    test('a card without a scripts list has no books', () => {
        expect(lorebookRefs(null)).toEqual([]);
        expect(lorebookRefs({})).toEqual([]);
        expect(lorebookRefs({ scripts: 'nope' })).toEqual([]);
        expect(hasAttachedBooks(null)).toBe(false);
        expect(hasAttachedBooks({ scripts: [{ id: 1, type: 'lorebook' }] })).toBe(true);
    });
});

describe('book kinds', () => {
    const books = [
        { kind: 'public', book: { entries: [] } },
        { kind: 'scripted', jsSource: 'registerLorebook(...)' },
        { kind: 'closed', reason: 'private' },
        { kind: 'failed', reason: 'http 500' },
        { kind: 'public' },
    ];

    test('each kind keeps its own path, and only two are downloadable', () => {
        const kinds = bookKinds(books);
        expect(kinds.json).toHaveLength(1);
        expect(kinds.js).toHaveLength(1);
        expect(kinds.closed).toHaveLength(1);
        expect(kinds.failed).toHaveLength(1);
        expect(kinds.downloadable).toHaveLength(2);
    });

    test('nothing to show is not an error', () => {
        expect(bookKinds(undefined).downloadable).toEqual([]);
    });
});

describe('import options sheet', () => {
    test('no books, no sheet: a plain import asks nothing', () => {
        expect(importOptions({ bookCount: 0 })).toBeNull();
        expect(importOptions()).toBeNull();
    });

    test('three modes with the exact Glaze labels and hints', () => {
        expect(importOptions({ bookCount: 2 }).map(option => option.mode))
            .toEqual(['character+lorebooks', 'character', 'lorebooks']);
        const rows = importOptions({ bookCount: 1 });
        expect(rows[0].label).toBe('Character + lorebooks');
        expect(rows[0].hint).toBe('Also import the attached lorebooks');
        expect(rows[1].label).toBe('Character only');
        expect(rows[1].hint).toBe('Import the character without its lorebooks');
        expect(rows[2].label).toBe('Lorebooks only');
        expect(rows[2].hint).toBe('Pull the lorebooks without adding the character');
    });
});

describe('capture stages', () => {
    test('derived, never stored: each stage only exists when its work does', () => {
        expect(captureStage({ importing: true, hasFlow: true, built: true })).toBe('character');
        // No closed book means no build stage at all, even with a capture.
        expect(captureStage({ hasFlow: false, extracted: true, built: true })).toBe('collect');
        expect(captureStage({ hasFlow: true })).toBe('collect');
        expect(captureStage({ hasFlow: true, extracted: true })).toBe('build');
        expect(captureStage({ hasFlow: true, extracted: true, built: true })).toBe('save');
    });

    test('the strip lists character only for a running import', () => {
        expect(captureStages({}).map(stage => stage.id)).toEqual(['collect', 'build', 'save']);
        expect(captureStages({ importing: true }).map(stage => stage.id))
            .toEqual(['character', 'collect', 'build', 'save']);
    });

    test('back steps one stage and is held while the sheet is working', () => {
        expect(captureBack({ stage: 'save', built: true })).toBe('build');
        expect(captureBack({ stage: 'build' })).toBe('collect');
        expect(captureBack({ stage: 'collect' })).toBe('close');
        expect(captureBack({ stage: 'build', busy: true })).toBe('held');
    });

    test('closing with work in hand is the only close that asks', () => {
        expect(captureConfirmClose({ delivered: false })).toBe(true);
        expect(captureConfirmClose({ delivered: true })).toBe(false);
        // Nothing extracted, nothing built: nothing to confirm.
        expect(captureConfirmClose({ delivered: false, work: false })).toBe(false);
        expect(captureConfirmClose({ delivered: false, work: true })).toBe(true);
    });
});

describe('the client wires those decisions', () => {
    const optionsSheet = clientJs.slice(clientJs.indexOf('function showImportOptions'), clientJs.indexOf('function openImportFlow'));
    const openFlow = clientJs.slice(clientJs.indexOf('function openImportFlow'), clientJs.indexOf('function captureJanitorLore'));

    test('the Import button never changes its label', () => {
        expect(clientJs).toContain('<span class="fa-solid fa-download wv-dfabicon"></span>');
        expect(clientJs).toContain('<span class="wv-dfablabel">Import to library</span>');
        expect(clientJs).not.toContain('Recover definition');
        expect(clientJs).not.toContain('wv-dfab-recover');
    });

    test('the sheet is gated on the character listing books', () => {
        expect(openFlow).toContain('if (!refs.length)');
        expect(openFlow).toContain('showImportOptions({');
        expect(clientJs).not.toContain('function showImportModeSheet');
    });

    test('a plain import never pulls lorebooks on the side', () => {
        expect(openFlow).not.toContain('importJanitorLorebooks');
        expect(openFlow).not.toContain('openRebuildSheet');
        // The old fast path (card, then every book it can get) stays out of the button.
        expect(clientJs).not.toMatch(/importJanitorCard\(item, character\);\n\s*return;/);
    });

    test('a closed definition is a mode of the same button', () => {
        expect(openFlow).toContain('if (closed) recoverJanitorCard(item, popup, fab, status);');
        expect(optionsSheet).toContain('openCaptureSheet({ item, meta, character: null });');
        expect(optionsSheet).toContain('characterImport: importJanitorCharacter');
        expect(optionsSheet).toContain('openCaptureSheet({ item, meta, character, characterImport: importJanitorCharacter });');
    });

    test('one capture serves both the card and its lorebook text', () => {
        const importJanitor = optionsSheet.slice(optionsSheet.indexOf('const importJanitorCharacter'));
        expect(importJanitor).toContain('captureJanitorLore(item, onPhase)');
        expect(importJanitor).toContain('payload.lorebookText');
        expect(clientJs).toContain("body: JSON.stringify({ id: item.fullPath, lore: true })");
        // And the server only returns the text when it is asked for — and only
        // then accepts a public definition, which can still own a closed book.
        expect(serverJs).toContain('const loreOnly = req.body?.lore === true;');
        expect(serverJs).toContain('if (!loreOnly && janitorDefinitionPublic(meta)) {');
        expect(serverJs).toContain('req.body?.lore === true && typeof capture.lorebookText');
    });

    test('the capture sheet guards close and back like Glaze', () => {
        expect(clientJs).toContain('captureConfirmClose({ delivered: state.delivered, work: Boolean(state.captured || state.built) })');
        expect(clientJs).toContain("The lorebook hasn't been saved or exported yet. Closing now discards the extraction progress.");
        expect(clientJs).toContain('captureBack({ stage: stage(), built: Boolean(state.built), busy: busy() })');
        // Build -> collect drops the extraction it was derived from (Glaze :1026).
        expect(clientJs).toMatch(/state\.captured = '';[\s\S]{0,80}state\.built = null;/);
    });

    test('public entries are cut out of the captured text before the build', () => {
        expect(clientJs).toContain('state.captured = withoutPublicEntries(raw, contents)');
        expect(clientJs).toContain('publicEntryContents(jsonBooks())');
    });

    test('the inventory is the same list, read-only, and only when opened', () => {
        expect(clientJs).toContain('const bookRefs = item.source === \'janitor\' ? lorebookRefs(report?.meta ?? null) : [];');
        expect(clientJs).toContain("if (i === 1 && !booksLoaded) { booksLoaded = true; loadBooks(); }");
        expect(clientJs).toContain('Read-only inventory. Use Import to bring these into the library.');
    });
});

describe('capture sheet styles', () => {
    test('a display rule cannot beat the hidden attribute', () => {
        // `.wv-cempty { display: flex }` would otherwise paint over [hidden].
        expect(clientCss).toContain('.wv-csheet [hidden] {');
        expect(clientCss).toMatch(/\.wv-csheet \[hidden\] \{\r?\n\s+display: none !important;/);
    });

    test('the body is the only scroller', () => {
        const sheet = clientCss.slice(clientCss.indexOf('.wv-csheet {'), clientCss.indexOf('.wv-chead {'));
        expect(sheet).toContain('overflow: hidden;');
        expect(clientCss).toMatch(/\.wv-cbody \{[\s\S]{0,240}overflow-y: auto;/);
        // Children keep their height; flex would otherwise squash every row.
        expect(clientCss).toMatch(/\.wv-cbody > \* \{\r?\n\s+flex: none;/);
        expect(clientCss).toMatch(/\.wv-cbody \{[\s\S]{0,240}flex: 1 1 auto;/);
    });
});
