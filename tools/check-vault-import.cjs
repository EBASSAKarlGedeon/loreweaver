// Weaver's Vault M3: detail window + import check against the REAL server (live chub).
// Verifies: card click → Glaze detail WINDOW (hero/tabs/FAB), import-options sheet
// logic, the EXTENSION's import path (stamping + ledger), then cleans up ONLY the
// character this run provably created.
//
// ── SAFETY POLICY (mandatory since the 2026-11-21 library-loss incident) ──────
//  1. This harness REFUSES to run unless the target data dir is tracked by git
//     (i.e. a Testing-branch worktree). Every deletion must be reversible.
//  2. Cleanup NEVER uses a set-difference ("before" list). It deletes only
//     characters that provably carry data.extensions.vault_source === 'chub'
//     AND data.extensions.vault_url === the exact fullPath this run imported.
//  3. If the imported character cannot be identified with certainty (0 or >1
//     matches), the harness deletes NOTHING and reports failure.
//  4. An empty/failed library snapshot aborts the import test — it must never
//     be treated as "everything is new".
// Usage: node tools/check-vault-import.cjs   (server on 127.0.0.1:8000 or $LW_PORT,
//        data dir override via $LW_DATA)
const { chromium } = require("C:/Users/Gedeon/Documents/Coding/Loreweaver/public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const SHOT = "C:/Users/Gedeon/AppData/Local/Temp/rpge-heavy/";
const problems = [];
const ok = (cond, msg) => { if (cond) console.log("  ok:", msg); else { problems.push(msg); console.log("  FAIL:", msg); } };

const DATA_DIR = process.env.LW_DATA
    ? path.resolve(process.env.LW_DATA)
    : path.resolve(__dirname, "..", "data", "default-user");
const REPO_ROOT = path.resolve(DATA_DIR, "..", "..");

// Policy guard 1: the data dir MUST be git-tracked (Testing branch worktree),
// so any deletion this harness causes can be restored with git.
function assertTrackedDataDir() {
    let tracked = "";
    try {
        tracked = execSync("git ls-files data/default-user/characters", {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 15000,
        });
    } catch { /* not a repo or git unavailable → tracked stays empty */ }
    if (!tracked.trim()) {
        console.error(
            "REFUSING TO RUN: data/default-user is not tracked by git in this checkout.\n" +
            "Test policy: destructive harnesses run only against a Testing-branch worktree\n" +
            "(git worktree: ../Loreweaver-testing) where the data folder is committed, so\n" +
            "every deletion is reversible. See CLAUDE.md → Test policy.");
        process.exit(2);
    }
    console.log(`  policy: data dir ${DATA_DIR} is git-tracked (${tracked.trim().split("\n").length} character files) — deletions are reversible`);
}
assertTrackedDataDir();

(async () => {
    const base = process.env.LW_PORT ? `http://127.0.0.1:${process.env.LW_PORT}` : "http://127.0.0.1:8000";
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", e => problems.push("pageerror: " + e.message.slice(0, 160)));

    // Capture the fullPath of the card under test from the vault's own detail
    // fetch (openDetail → /api/weavers-vault/chub/character?fullPath=…).
    let testFullPath = null;
    page.on("request", r => {
        const m = r.url().match(/\/api\/weavers-vault\/chub\/character\?fullPath=([^&]+)/);
        if (m) testFullPath = decodeURIComponent(m[1]);
    });

    await page.goto(base + "/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(9000);
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1200);
    // Deterministic baseline: persisted vault filters (e.g. a stale tagNames
    // entry) can zero out the search, which would look like a UI failure.
    // Reset them to defaults before opening the panel.
    await page.evaluate(async () => {
        const { extension_settings } = await import("/scripts/extensions.js");
        const { saveSettingsDebounced } = await import("/script.js");
        const v = extension_settings["weavers-vault"] ?? {};
        v.filters = v.filters ?? { chub: {} };
        v.filters.chub.tagNames = [];
        v.filters.chub.topics = [];
        v.filters.chub.minTokens = 29;
        v.filters.chub.maxTokens = 100000;
        v.filters.chub.nsfw = false;
        v.query = "grandmother";
        saveSettingsDebounced();
    });
    await page.locator("#wv-launcher").click();
    await page.waitForSelector(".wv-card", { timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log("1) card click opens the Glaze detail window");
    await page.locator(".wv-card").first().click();
    await page.waitForSelector(".wv-dwin", { timeout: 20000 });
    await page.waitForTimeout(2500);
    const detailName = await page.locator(".wv-heroname").textContent();
    ok(!!detailName && detailName.trim().length > 0, `detail window hero: ${detailName}`);
    ok(await page.locator(".wv-dtab").count() === 3, "tab strip: Info / Prompt Blocks / Images");
    ok(await page.locator(".wv-dfab").isVisible(), "Import FAB visible");
    // kebab → desktop popup with the source-site row
    await page.locator(".wv-dkebab").click();
    await page.waitForTimeout(300);
    ok((await page.locator(".wv-dpoprow").allTextContents()).some(t => /Open source site/.test(t)), "kebab popup: open source site");
    await page.locator(".wv-dback").click(); // closes popup via outside-click… back closes the window
    await page.waitForTimeout(400);
    const closed = !(await page.locator(".wv-dwin").isVisible());
    ok(closed, "back button closes the detail window");
    if (closed) {
        await page.locator(".wv-card").first().click();
        await page.waitForSelector(".wv-dwin", { timeout: 20000 });
        await page.waitForTimeout(2500);
    }

    // Policy guard 2: without the exact fullPath of the card under test there is
    // no provable cleanup invariant → the import test must not run at all.
    if (!testFullPath) {
        problems.push("could not capture the card's fullPath — import test skipped, NOTHING was imported or deleted");
        console.log("  FAIL: no fullPath captured; refusing to import (nothing to clean up, nothing deleted)");
        await browser.close();
        console.log(problems.length ? `\nVAULT IMPORT FAILURES: ${problems.length}` : "\nVAULT IMPORT OK");
        process.exit(problems.length ? 1 : 0);
    }
    const expectedUrl = `https://chub.ai/characters/${testFullPath}`;
    console.log(`  policy: cleanup invariant = vault_source==='chub' && vault_url==='${expectedUrl}'`);

    console.log("2) import-mode sheet appears only when a lorebook exists");
    await page.locator(".wv-dfab").click();
    await page.waitForTimeout(800);
    const sheetCount = await page.locator(".wv-modesheet").count();
    if (sheetCount) {
        ok(sheetCount === 1, "mode sheet shown");
        const modes = await page.locator(".wv-modelabel").allTextContents();
        ok(modes.some(m => /Character \+ lorebooks/.test(m)) && modes.some(m => /Lorebooks only/.test(m)), `modes: ${modes.join(" | ")}`);
        await page.screenshot({ path: SHOT + "v03-mode-sheet.png" });
        await page.locator(".wv-mode-overlay").click({ position: { x: 8, y: 8 } });
        // Cancel means no import happened — done testing import for a book card.
    } else {
        ok(true, "no sheet (no lorebook) — straight import begins");
        console.log("3) extension import path (stamping + ledger)");
        await page.waitForTimeout(6000); // straight import was triggered by the FAB click
        await page.screenshot({ path: SHOT + "v03-imported.png" });
        await page.waitForTimeout(4000); // debounced settings save
    }

    if (!sheetCount) {
        // Identify ONLY characters that provably came from this exact import.
        // The expected char carries vault_source==='chub' and vault_url equal to
        // the fullPath captured from this run's detail fetch. Never a diff.
        const candidates = await page.evaluate(async (expectedUrl) => {
            const { characters, getCharacters } = await import("/script.js");
            await getCharacters();
            return characters
                .filter(c => c.data?.extensions?.vault_source === "chub" && c.data?.extensions?.vault_url === expectedUrl)
                .map(c => ({ name: c.name, avatar: c.avatar }));
        }, expectedUrl);
        ok(candidates.length >= 1, `import created ${candidates.length} matching character(s) for ${testFullPath}`);
        ok(candidates.length === 1, "exactly one match — cleanup is unambiguous");

        console.log("4) cleanup — delete ONLY the provenance-matched character");
        if (candidates.length === 1) {
            const c = candidates[0];
            const status = await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import("/script.js");
                const r = await fetch("/api/characters/delete", {
                    method: "POST",
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: false }),
                });
                return r.status;
            }, c.avatar);
            ok(status === 200 || status === 204, `deleted ${c.name} (${c.avatar}) (${status})`);
            await page.evaluate(async () => {
                const { getCharacters } = await import("/script.js");
                await getCharacters();
            });
        } else {
            problems.push("cleanup aborted: 0 or ambiguous provenance matches — NOTHING was deleted");
            console.log("  FAIL: cleanup aborted — nothing deleted (restore/verify manually if an import happened)");
        }

        // Post-cleanup verification, again by provenance (not by name or diff).
        const remaining = await page.evaluate(async (expectedUrl) => {
            const { characters, getCharacters } = await import("/script.js");
            await getCharacters();
            return characters.filter(c =>
                c.data?.extensions?.vault_source === "chub" && c.data?.extensions?.vault_url === expectedUrl).length;
        }, expectedUrl);
        ok(remaining === 0, "no character with this run's provenance remains");
    }

    // 5) ledger persisted to the synced settings file (checked server-side)
    let ledgerOK = false;
    try {
        const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf-8"));
        const v = s.extension_settings?.["weavers-vault"];
        ledgerOK = Array.isArray(v?.ledger) && v.ledger.some(e => e.source === "chub" && e.id === testFullPath);
        // Cleanup the ledger entry so the user's settings stay pristine — only when
        // explicitly enabled (WV_CLEAN_LEDGER=1); the direct write races the server's
        // debounced save, so it is opt-in.
        if (ledgerOK && process.env.WV_CLEAN_LEDGER === "1") {
            v.ledger = v.ledger.filter(e => !(e.source === "chub" && e.id === testFullPath));
            fs.writeFileSync(path.join(DATA_DIR, "settings.json"), JSON.stringify(s, null, 4), "utf-8");
        }
    } catch (e) { console.log("  ledger check error:", e.message); }
    ok(ledgerOK, "import ledger persisted (source/id/url recorded)");

    await browser.close();
    console.log(problems.length ? `\nVAULT IMPORT FAILURES: ${problems.length}` : "\nVAULT IMPORT OK");
    process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
