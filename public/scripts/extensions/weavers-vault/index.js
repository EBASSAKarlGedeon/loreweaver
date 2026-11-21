// Weaver's Vault — character library extension (M2: browse UI for chub.ai).
// Pure drawer/overlay extension: zero Loreweaver core edits. Imports happen in M3.
// Attribution: source-adapter logic ported from Glaze (AGPL-3.0) — docs/vault/.
import { extension_settings } from '../../extensions.js';
import { getRequestHeaders } from '../../../script.js';

const extensionName = "Weaver's Vault";
const MODULE = 'weavers-vault';

const DEFAULTS = {
    nsfw: false,          // Vault's own toggle, default SFW (design Q7-of-round-1)
    sort: 'popular',
    query: '',
    perPage: 24,
    openAfterImport: true,
    filters: {},          // per-source filter profiles (keyed by source id)
    ledger: [],           // import ledger (Q4): {source, id, name, at, url}
    favorites: [],        // {source, id, name}
};

function settings() {
    extension_settings[MODULE] = extension_settings[MODULE] ?? {};
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

function saveSettingsQuiet() {
    // extension_settings is saved by Loreweaver's debounced settings saver; pull it in.
    import('../../../script.js').then(m => m.saveSettingsDebounced());
}

// ---------------------------------------------------------------------------
// Overlay shell (proven RPG-engine pattern: fullscreen DOM overlay, no iframe)
// ---------------------------------------------------------------------------

let root = null;

function ensureOverlay() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'wv-root';
    root.hidden = true;
    root.innerHTML = `
        <div class="wv-panel">
            <div class="wv-header">
                <div class="wv-title"><span class="fa-solid fa-book"></span> Weaver's Vault</div>
                <button class="wv-close menu_button" title="Close"><span class="fa-solid fa-xmark"></span></button>
            </div>
            <div class="wv-toolbar">
                <div class="wv-source-chip" title="Source (more coming)">chub.ai</div>
                <input class="wv-search text_pole" type="text" placeholder="Search characters…" autocomplete="off" />
                <select class="wv-sort" title="Sort">
                    <option value="popular">Popular</option>
                    <option value="trending_week">Trending (week)</option>
                    <option value="trending_24h">Trending (24h)</option>
                    <option value="latest">Latest</option>
                    <option value="rating">Top rated</option>
                    <option value="updated">Recently updated</option>
                </select>
                <label class="wv-nsfw-toggle" title="Show NSFW results">
                    <input type="checkbox" class="wv-nsfw" /> <span>NSFW</span>
                </label>
            </div>
            <div class="wv-status"></div>
            <div class="wv-grid"></div>
            <div class="wv-endbar"></div>
            <div class="wv-sentinel"></div>
        </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.wv-close').addEventListener('click', closeVault);
    return root;
}

function openVault() {
    ensureOverlay();
    root.hidden = false;
    const s = settings();
    const search = root.querySelector('.wv-search');
    const sortSel = root.querySelector('.wv-sort');
    const nsfw = root.querySelector('.wv-nsfw');
    search.value = s.query;
    sortSel.value = s.sort;
    nsfw.checked = s.nsfw;
    if (!state.hydrated) {
        state.hydrated = true;
        runSearch();
    }
}

function closeVault() {
    if (root) root.hidden = true;
}

// ---------------------------------------------------------------------------
// Search state + epoch guard (Glaze mechanic: stale responses discarded on any
// change of query/sort/filters/page-reset)
// ---------------------------------------------------------------------------

const state = {
    hydrated: false,
    epoch: 0,
    query: '',
    sort: 'popular',
    nsfw: false,
    page: 0,
    items: [],
    total: 0,
    hasMore: false,
    loading: false,
    reachedEnd: false,
};

let searchTimer = null;

function resetAndSearch() {
    state.page = 0;
    state.items = [];
    state.reachedEnd = false;
    runSearch();
}

function runSearch() {
    const myEpoch = ++state.epoch;
    state.loading = true;
    state.page = state.page || 1;
    renderStatus('Searching…');
    fetch('/api/weavers-vault/chub/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            query: state.query,
            page: state.page,
            limit: settings().perPage,
            sort: state.sort,
            nsfw: state.nsfw,
            nsfl: false, // account-scoped on chub; v2 alongside the chub key
        }),
    })
        .then(r => r.json().then(body => ({ ok: r.ok, status: r.status, body })))
        .then(({ ok, status, body }) => {
            if (myEpoch !== state.epoch) return; // stale
            state.loading = false;
            if (!ok) {
                // Party-labeled error: the source is at fault, not the app.
                renderStatus(`chub.ai answered ${status}${body?.error ? ` — ${body.error}` : ''}`, true);
                return;
            }
            if (state.page === 1) state.items = body.items ?? [];
            else state.items.push(...(body.items ?? []));
            state.total = body.total ?? state.items.length;
            state.hasMore = Boolean(body.hasMore);
            state.reachedEnd = state.items.length === 0 || !state.hasMore;
            renderGrid();
            renderStatus();
        })
        .catch(error => {
            if (myEpoch !== state.epoch) return;
            state.loading = false;
            renderStatus(`Network error — ${error.message}`, true);
        });
}

function loadMore() {
    if (state.loading || state.reachedEnd) return;
    state.page += 1;
    runSearch();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus(text, isError = false) {
    const el = root.querySelector('.wv-status');
    el.classList.toggle('wv-status-error', isError);
    if (text) {
        el.textContent = text;
        el.hidden = false;
        return;
    }
    if (state.reachedEnd) {
        el.textContent = state.items.length
            ? `${state.items.length}${state.total ? ` of ${state.total}` : ''} — End of results`
            : 'No results';
    } else {
        el.hidden = true;
    }
}

function fmtCount(n) {
    if (!n) return '';
    return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function renderGrid() {
    const grid = root.querySelector('.wv-grid');
    const nsfwOn = state.nsfw;
    grid.innerHTML = '';
    for (const item of state.items) {
        const card = document.createElement('div');
        card.className = 'wv-card';
        const blur = item.nsfw && !nsfwOn;
        card.innerHTML = `
            <div class="wv-poster ${blur ? 'wv-blur' : ''}">
                <img loading="lazy" referrerpolicy="no-referrer" alt="" />
                ${item.nsfw && !nsfwOn ? '<button class="wv-reveal" title="Reveal">👁</button>' : ''}
            </div>
            <div class="wv-card-name" title=""></div>
            <div class="wv-card-meta"></div>
            <div class="wv-card-tags"></div>
        `;
        const img = card.querySelector('img');
        img.src = item.avatarUrl || '';
        card.querySelector('.wv-poster').dataset.letter = (item.name || '?')[0];
        img.addEventListener('error', () => { img.src = ''; card.querySelector('.wv-poster').classList.add('wv-noimg'); });
        if (blur) {
            card.querySelector('.wv-reveal')?.addEventListener('click', e => {
                e.stopPropagation();
                card.querySelector('.wv-poster').classList.remove('wv-blur');
                card.querySelector('.wv-reveal').remove();
            });
        }
        const name = card.querySelector('.wv-card-name');
        name.textContent = item.name;
        name.title = item.name;
        const meta = card.querySelector('.wv-card-meta');
        const bits = [];
        if (item.tokens) bits.push(`${fmtCount(item.tokens)} tokens`);
        if (item.chatCount) bits.push(`💬 ${fmtCount(item.chatCount)}`);
        meta.textContent = bits.join(' · ');
        const tagRow = card.querySelector('.wv-card-tags');
        for (const tag of (item.tags ?? []).slice(0, 3)) {
            const chip = document.createElement('span');
            chip.className = 'wv-tag-chip';
            chip.textContent = tag;
            tagRow.appendChild(chip);
        }
        // M3 wires the detail popup onto this click.
        grid.appendChild(card);
    }
    const endbar = root.querySelector('.wv-endbar');
    endbar.textContent = state.reachedEnd && state.items.length ? 'End of results' : '';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireToolbar() {
    const search = root.querySelector('.wv-search');
    const sortSel = root.querySelector('.wv-sort');
    const nsfw = root.querySelector('.wv-nsfw');
    search.addEventListener('input', () => {
        state.query = search.value;
        settings().query = search.value;
        saveSettingsQuiet();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(resetAndSearch, 400); // Glaze's debounce cadence
    });
    sortSel.addEventListener('change', () => {
        state.sort = sortSel.value;
        settings().sort = sortSel.value;
        saveSettingsQuiet();
        resetAndSearch();
    });
    nsfw.addEventListener('change', () => {
        state.nsfw = nsfw.checked;
        settings().nsfw = nsfw.checked;
        saveSettingsQuiet();
        resetAndSearch();
        // Also unblur already-rendered cards when switching on without a refetch.
        if (nsfw.checked) root.querySelectorAll('.wv-blur').forEach(el => el.classList.remove('wv-blur'));
    });
    // Infinite scroll (Glaze: load more when near the end)
    const sentinel = root.querySelector('.wv-sentinel');
    new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) loadMore();
    }, { root: root.querySelector('.wv-panel'), rootMargin: '400px' }).observe(sentinel);
}

function addMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('wv-menu-entry')) return !!menu;
    const item = document.createElement('div');
    item.id = 'wv-menu-entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = "Open Weaver's Vault";
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-book extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = "Weaver's Vault";
    item.append(icon, label);
    item.addEventListener('click', openVault);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openVault(); });
    menu.appendChild(item);
    return true;
}

function addLauncher() {
    if (document.getElementById('wv-launcher')) return;
    const b = document.createElement('button');
    b.id = 'wv-launcher';
    b.type = 'button';
    b.title = "Open Weaver's Vault";
    b.setAttribute('aria-label', "Open Weaver's Vault");
    b.textContent = '📚';
    b.addEventListener('click', openVault);
    document.body.appendChild(b);
}

jQuery(async () => {
    console.log(`[${extensionName}] Loading…`);
    try {
        settings();
        if (!addMenuEntry()) {
            // Menu not ready yet; retry shortly (same as RPG engine's approach).
            setTimeout(addMenuEntry, 2000);
        }
        addLauncher();
        ensureOverlay();
        wireToolbar();
        console.log(`[${extensionName}] ✅ Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Failed to load:`, error);
    }
});
