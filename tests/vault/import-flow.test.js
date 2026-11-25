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

    test('the options are a menu anchored to the button, not a sheet over the layout', () => {
        expect(clientJs).not.toContain('<div class="wv-modesheet">\n        + \'<div class="wv-modehandle"></div>');
        expect(optionsSheet).toContain("'<div class=\"wv-importmenu\" role=\"menu\" aria-label=\"Import options\">'");
        expect(optionsSheet).toContain('wv-mode-overlay wv-menuoverlay');
        // Right edges flush with the button, 10px above it, clamped to 12px.
        expect(optionsSheet).toContain('box.right - width');
        expect(optionsSheet).toContain('box.top - height - 10');
        expect(optionsSheet).toContain('const margin = 12;');
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

    test('an unchecked book is never folded into the closed list', () => {
        const sheet = clientJs.slice(clientJs.indexOf('function openCaptureSheet'), clientJs.indexOf('function showImportOptions'));
        expect(sheet).toContain("state.books.filter(book => book.kind === 'closed')");
        expect(sheet).toContain("const failedBooks = () => state.books.filter(book => book.kind === 'failed')");
        expect(sheet).toContain("$('.wv-cfailed').hidden = !failed.length");
        expect(sheet).toContain("'Not checked · '");
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
    test('row buttons never paint the UA buttonface', () => {
        const reset = clientCss.slice(clientCss.indexOf(':where(#wv-root) button {'), clientCss.indexOf('}', clientCss.indexOf(':where(#wv-root) button {')));
        expect(reset).toContain('background: transparent;');
        expect(reset).toContain('border: 0;');
        expect(reset).toContain('color: inherit;');
        // Zero specificity, or every hover/focus rule in the file loses to it.
        expect(reset).not.toContain('#wv-root button');
        expect(clientCss.indexOf(':where(#wv-root) button {')).toBeLessThan(clientCss.indexOf('.wv-modecard button {'));
    });

    test('the import menu is compact and undimmed', () => {
        const menu = clientCss.slice(clientCss.indexOf('.wv-importmenu {'), clientCss.indexOf('@keyframes wv-menu-in'));
        expect(menu).toContain('width: min(320px, calc(100vw - 24px));');
        expect(menu).toContain('position: absolute;');
        const dim = clientCss.slice(clientCss.indexOf('.wv-menuoverlay {'), clientCss.indexOf('.wv-importmenu {'));
        expect(dim).toContain('background: transparent;');
    });

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

/**
 * The building stage, matched to Glaze's capture sheet
 * (janitor_lorebook_capture_sheet.dart:1507 `_buildBlock`). Every rule below was
 * a visible divergence: pill chips instead of a breadcrumb, caps micro-headers
 * with no help or description, a permanent bordered dump of the text, a
 * full-width download button, bare checkboxes instead of ContextSourceTile
 * rows, an always-open alias field, and stretched pills.
 */
describe('the building stage matches Glaze', () => {
    const build = clientJs.slice(
        clientJs.indexOf('<div class="wv-cstage-build" hidden>'),
        clientJs.indexOf('<div class="wv-cstage-save" hidden>'),
    );

    test('the step bar is a breadcrumb with the back arrow in it', () => {
        expect(clientJs).toContain('<div class="wv-crumbs"></div>');
        expect(clientJs).not.toContain('wv-cpill');
        expect(clientCss).not.toContain('.wv-cpill');
        expect(clientJs).toContain("'<span class=\"wv-crumb' + (entry.id === current ? ' on' : '')");
        // The arrow sits in the strip, not in the title bar beside the close X.
        const header = clientJs.slice(clientJs.indexOf('<div class="wv-chead">'), clientJs.indexOf('<div class="wv-cstrip">'));
        expect(header).not.toContain('wv-cback');
        expect(clientJs.slice(clientJs.indexOf('<div class="wv-cstrip">'))).toContain('wv-cback');
        // At the first step it closes the sheet instead of vanishing.
        expect(clientJs).toContain("if (step === 'close') { close(); return; }");
        const crumbOn = clientCss.slice(clientCss.indexOf('.wv-crumb.on {'), clientCss.indexOf('}', clientCss.indexOf('.wv-crumb.on {')));
        expect(crumbOn).toContain('var(--wv-accent)');
    });

    test('each group is a MenuGroup header with help and a description', () => {
        expect(build).toContain('<span class="wv-cgtitle">Build with LLM</span>');
        expect(build).toContain('<span class="wv-cgtitle">Context for key inference</span>');
        // '?' help on both headers, a muted 12px description under them.
        expect(build.match(/class="wv-help"/g)).toHaveLength(2);
        expect(build).toContain('<div class="wv-cgdesc wv-cextnote"></div>');
        expect(clientCss).toMatch(/\.wv-cgtitle \{[\s\S]{0,80}font-size: 18px;/);
        expect(clientCss).toMatch(/\.wv-cgdesc \{[\s\S]{0,120}font-size: 12px;/);
        // The caps micro-header is gone.
        expect(clientCss).not.toContain('.wv-cgrouphead');
    });

    test('the extracted content is a collapsed disclosure and download is a row', () => {
        expect(build).toMatch(/class="wv-cm wv-cdisc" type="button" aria-expanded="false"/);
        expect(build).toContain('<div class="wv-cdiscbody" hidden>');
        // Download is a MenuItem row with an icon and a subtitle, not a button.
        expect(build).toContain('class="wv-cm wv-cdltext"');
        expect(build).not.toMatch(/wv-abtn[^"]*wv-cdltext/);
        expect(build).toContain('Raw text, no entries or keys');
        // Glaze's count is tokens, not blocks.
        expect(clientJs).toContain("'Extracted content · ' + tokensOf(text) + ' tokens'");
    });

    test('a context source is a ContextSourceTile: text row, chevron, switch', () => {
        // Label + token count, and the count is Glaze's ~4-char fallback.
        expect(clientJs).toContain("? tokensOf(text) + ' tokens'");
        expect(clientJs).toContain('Math.ceil(String(text).trim().length / 4)');
        // Opening the text cannot flip the switch: the row and the switch are
        // separate targets, like ContextSourceTile's InkWell + Switch.
        expect(clientJs).toMatch(/class="wv-csrcmain" type="button"/);
        expect(clientJs).toContain('data-switch=');
        expect(clientJs).toContain("querySelectorAll('[data-switch]')");
        expect(clientJs).toContain("button.closest('.wv-csrc').querySelector('.wv-csrcbody')");
        // An empty source cannot be opened or sent.
        expect(clientJs).toContain("(text ? (state.context[key] ? ' checked' : '') : ' disabled')");
        expect(clientJs).toContain('Needs one extra site fetch');
        // The row keeps showing what it would send after being switched off.
        expect(clientJs).toContain('toggles: { card: true, catalog: true, scenario: true, greetings: true, lorebookDescs: true },');
        expect(clientJs).toContain("'Card description on site'");
        expect(clientJs).toContain("'First message(s)'");
        expect(clientJs).toContain("'Lorebook titles + descriptions'");
    });

    test('the extra aliases are a switch that gates the field', () => {
        expect(build).toContain('class="wv-cm wv-cswitchrow wv-cxrow" type="button" role="switch"');
        expect(build).toContain('<label class="wv-cfield wv-cxtrafield" hidden>');
        expect(clientJs).toContain("$('.wv-cxtrafield').hidden = !state.extraOn;");
        // Off means the text is not sent, so the switch cannot lie.
        expect(clientJs).toContain("extra: state.extraOn ? state.extra : '',");
    });

    test('the new rows cannot restyle the collect lists', () => {
        // `.wv-crow` already belongs to a collect-stage book row with its own
        // card background; the menu rows are `.wv-cm` so neither can win.
        expect(clientCss).toMatch(/\.wv-crow \{[\s\S]{0,120}background: rgba\(255, 255, 255, 0\.04\);/);
        expect(clientCss).toMatch(/\.wv-cm \{[\s\S]{0,120}display: flex;/);
        // A menu row carries no fill of its own; only hover paints it.
        expect(clientCss).not.toMatch(/\.wv-cm \{[\s\S]{0,140}background:/);
    });

    test('the actions do not stretch and the patience note follows them', () => {
        expect(build).toContain('class="wv-cpatience"');
        expect(build).toContain('please be patient.');
        expect(clientCss).toMatch(/\.wv-cactions \.wv-abtn \{\r?\n\s+flex: 0 0 auto;/);
        expect(clientCss).not.toContain('min-width: 170px;');
    });
});

/**
 * The saving stage, matched to Glaze's `_buildResult`
 * (janitor_lorebook_capture_sheet.dart:1629): a MenuGroup with the name field
 * and two MenuItem rows, then the Tavern JSON ContentPane. Ours had an action
 * bar with three pills — two of them duplicating rows that already exist — and
 * no view of what Save actually writes.
 */
describe('the saving stage matches Glaze', () => {
    const saveStart = clientJs.indexOf('<div class="wv-cstage-save" hidden>');
    const save = clientJs.slice(
        saveStart,
        clientJs.indexOf('root.appendChild(overlay);', saveStart),
    );

    test('the built count is a MenuGroup header with help', () => {
        expect(save).toContain('<div class="wv-cghead"><span class="wv-cgtitle wv-cbuilt-head">Built 0 entries</span>');
        expect(save).toContain('<span class="wv-help" title="What Save and Export write.');
        expect(clientJs).toContain("'Built ' + state.built.entries.length");
    });

    test('the scope sentence is the group description, not a loose note', () => {
        expect(save).toContain('<div class="wv-cgdesc wv-cscope"></div>');
        expect(clientCss).toMatch(/\.wv-cgdesc \{[\s\S]{0,120}font-size: 12px;/);
    });

    test('Save and Export are menu rows, not a stretched action bar', () => {
        expect(save).toContain('class="wv-cm wv-csave"');
        expect(save).toContain('class="wv-cm wv-cexport"');
        expect(save).toContain('fa-bookmark wv-cmicon');
        expect(save).toContain('fa-download wv-cmicon');
        expect(save).toContain('Adds the book to your World Info and attaches it to the card.');
        expect(save).toContain('SillyTavern world info, nothing written to the library.');
        expect(save).not.toContain('wv-cactions');
    });

    test('the extracted .txt download stays in the building group only', () => {
        expect(save).not.toContain('wv-cdltext2');
        expect(clientJs).not.toContain('wv-cdltext2');
        // It lives in the Building group's disclosure row, wired once.
        expect(clientJs).toContain("$('.wv-cdltext').addEventListener");
        expect(clientJs).toContain("downloadTextFile('extracted-lorebook.txt'");
        expect(clientJs.split("downloadTextFile('extracted-lorebook.txt'").length - 1).toBe(1);
    });

    test('the Tavern JSON that Save writes is shown before it is written', () => {
        expect(save).toContain('<pre class="wv-cpre wv-cjsontext"></pre>');
        expect(clientJs).toContain('JSON.stringify(worldInfoFor(state.built.name, built), null, 2)');
        expect(clientCss).toMatch(/\.wv-cjsontext \{[\s\S]{0,160}font-family: ui-monospace/);
        // ContentPane: capped at 220 px, rounded like Glaze's pane (r12).
        expect(clientCss).toMatch(/\.wv-cpre \{[\s\S]{0,160}max-height: 220px;/);
        expect(clientCss).toMatch(/\.wv-cpre \{[\s\S]{0,220}border-radius: 12px;/);
    });
});