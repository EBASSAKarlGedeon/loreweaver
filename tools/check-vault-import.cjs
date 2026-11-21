// Weaver's Vault M3: detail popup + import check against the REAL server (live chub).
// Verifies: card click → detail popup, mode sheet logic, the EXTENSION's import path
// (stamping + ledger + native chain), then ALWAYS cleans up the imported character.
// Usage: node tools/check-vault-import.cjs   (server on 127.0.0.1:8000)
const { chromium } = require("C:/Users/Gedeon/Documents/Coding/Loreweaver/public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright");
const SHOT = "C:/Users/Gedeon/AppData/Local/Temp/rpge-heavy/";
const problems = [];
const ok = (cond, msg) => { if (cond) console.log("  ok:", msg); else { problems.push(msg); console.log("  FAIL:", msg); } };

const fs = require("fs");
function fsHasNoStrayCharacter() {
    try {
        const dir = "C:/Users/Gedeon/Documents/Coding/Loreweaver/data/default-user/characters";
        return fs.readdirSync(dir).filter(f => /card builder/i.test(f)).length === 0;
    } catch { return false; }
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", e => problems.push("pageerror: " + e.message.slice(0, 160)));
    await page.goto("http://127.0.0.1:8000/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(9000);
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1200);
    await page.locator("#wv-launcher").click();
    await page.waitForSelector(".wv-card", { timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log("1) card click opens detail popup");
    await page.locator(".wv-card").first().click();
    await page.waitForSelector(".wv-detail-body", { timeout: 20000 });
    await page.waitForTimeout(2500);
    const detailName = await page.locator(".wv-detail-name").textContent();
    ok(!!detailName && detailName.length > 0, `detail popup: ${detailName}`);
    ok(await page.locator(".wv-detail-source").count() === 1, "'open on source site' link present");
    const bodyText = await page.locator(".wv-detail-body").textContent();
    ok(bodyText.length > 50, `detail body renders (${bodyText.length} chars)`);
    await page.screenshot({ path: SHOT + "v03-detail.png" });

    // The detail sub-line reports "lorebook: N entries" when the card has one.
    const hasBook = (await page.locator(".wv-detail-sub").textContent()).includes("lorebook");

    console.log("2) import-mode sheet appears only when a lorebook exists");
    await page.locator(".wv-import-button").click();
    await page.waitForTimeout(600);
    const sheetCount = await page.locator(".wv-mode-sheet").count();
    if (hasBook) {
        ok(sheetCount === 1, "mode sheet shown");
        const modes = await page.locator(".wv-mode-sheet button").allTextContents();
        ok(modes.some(m => /Character \+ lorebook/.test(m)) && modes.some(m => /Lorebook only/.test(m)), `modes: ${modes.join(" | ")}`);
        await page.screenshot({ path: SHOT + "v03-mode-sheet.png" });
        await page.locator(".wv-mode-cancel").click();
        // Cancel means no import happened — done testing import for a book card.
    } else {
        ok(sheetCount === 0, "no sheet (no lorebook) — straight import begins");
    }

    console.log("3) extension import path (stamping + ledger)" + (hasBook ? " — SKIPPED (book card; hand-test both-mode)" : ""));
    if (!hasBook) {
        const before = await page.evaluate(async () => {
            const { characters, getCharacters } = await import("/script.js");
            await getCharacters();
            return characters.map(c => c.avatar);
        });
        // The straight import was already triggered by the click above; wait for it.
        await page.waitForTimeout(6000);
        const diff = await page.evaluate(async (before) => {
            const { characters, getCharacters } = await import("/script.js");
            await getCharacters();
            const newChars = characters.filter(c => !before.includes(c.avatar));
            return newChars.map(c => ({ name: c.name, avatar: c.avatar, ext: c.data?.extensions ?? {} }));
        }, before);
        ok(diff.length >= 1, `import created ${diff.length} character(s)`);
        const imported = diff[0];
        if (imported) {
            ok(imported.ext?.vault_source === "chub" && !!imported.ext?.vault_url, `provenance stamped: ${JSON.stringify(imported.ext).slice(0, 140)}`);
            await page.waitForTimeout(4000); // debounced settings save
        }
        await page.screenshot({ path: SHOT + "v03-imported.png" });

        console.log("4) cleanup — delete imported character");
        for (const c of diff) {
            const status = await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import("/script.js");
                const r = await fetch("/api/characters/delete", {
                    method: "POST",
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: false }),
                });
                return r.status;
            }, c.avatar);
            ok(status === 200 || status === 204, `deleted ${c.name} (${status})`);
        }
        await page.evaluate(async () => {
            const { getCharacters } = await import("/script.js");
            await getCharacters();
        });
    }

    // 5) ledger persisted to the synced settings file (checked server-side)
    let ledgerOK = false;
    try {
        const fs = require("fs");
        const s = JSON.parse(fs.readFileSync("C:/Users/Gedeon/Documents/Coding/Loreweaver/data/default-user/settings.json", "utf-8"));
        const v = s.extension_settings?.['weavers-vault'];
        ledgerOK = Array.isArray(v?.ledger) && v.ledger.some(e => e.source === "chub" && e.id?.includes("character-card-builder"));
        // cleanup ledger entry so the user's settings stay pristine
        if (ledgerOK) {
            v.ledger = v.ledger.filter(e => !(e.source === "chub" && e.id?.includes("character-card-builder")));
            fs.writeFileSync("C:/Users/Gedeon/Documents/Coding/Loreweaver/data/default-user/settings.json", JSON.stringify(s, null, 4), "utf-8");
        }
    } catch (e) { console.log("  ledger check error:", e.message); }
    ok(ledgerOK, "import ledger persisted (source/id/url recorded) and cleaned up");
    ok(fsHasNoStrayCharacter(), "no stray imported character remains");

    await browser.close();
    console.log(problems.length ? `\nVAULT IMPORT FAILURES: ${problems.length}` : "\nVAULT IMPORT OK");
    process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
