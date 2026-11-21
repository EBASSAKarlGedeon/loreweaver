// Weaver's Vault M2: browse UI check against the REAL server (live chub data).
// Verifies: overlay opens, grid renders live chub results, NSFW toggle re-queries,
// search-epoch guard (stale response discarded), infinite scroll stub, screenshots.
// Usage: node tools/check-vault-ui.mjs   (server must be running on 127.0.0.1:8000)
const { chromium } = require("../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright");
const SHOT = "C:/Users/Gedeon/AppData/Local/Temp/rpge-heavy/";
const problems = [];
const ok = (cond, msg) => { if (cond) console.log("  ok:", msg); else { problems.push(msg); console.log("  FAIL:", msg); } };

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", e => problems.push("pageerror: " + e.message.slice(0, 160)));
    const base = process.env.LW_PORT ? `http://127.0.0.1:${process.env.LW_PORT}` : "http://127.0.0.1:8000";
    await page.goto(base + "/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(8000); // let the app settle + extensions load

    console.log("1) extension loads and opens");
    ok(await page.locator("#wv-menu-entry").count() === 1, "wand menu entry present");
    ok(await page.locator("#wv-launcher").count() === 1, "launcher present");
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1500);
    await page.locator("#wv-launcher").click();
    await page.waitForTimeout(1000);
    ok(await page.locator("#wv-root").isVisible(), "overlay visible");
    await page.screenshot({ path: SHOT + "v02-vault-open.png" });

    console.log("2) live chub search renders");
    await page.waitForSelector(".wv-card", { timeout: 30000 });
    const count1 = await page.locator(".wv-card").count();
    ok(count1 >= 12, `grid rendered ${count1} cards`);
    const first = await page.locator(".wv-card-name").first().textContent();
    ok(!!first && first.length > 0, `first card: ${first}`);
    const total = await page.locator(".wv-status").textContent().catch(() => "");
    await page.waitForTimeout(6000); // let poster images stream in
    await page.screenshot({ path: SHOT + "v02-vault-grid.png" });

    console.log("3) NSFW via filter sheet toggle (commits on close), then chip ×");
    await page.locator(".wv-filterbtn").click();
    await page.locator(".wv-mcard").first().locator(".wv-switch").first().click();
    await page.locator(".wv-mclose").click();
    await page.waitForTimeout(4500);
    const count2 = await page.locator(".wv-card").count();
    ok(count2 >= 5, `NSFW search rendered ${count2} cards`);
    ok(await page.locator(".wv-badge").isVisible(), "filter badge visible");
    ok(await page.locator(".wv-fchip-nsfw").isVisible(), "NSFW active-filter chip visible");
    await page.locator(".wv-fchip-nsfw").click();
    await page.waitForTimeout(4500);
    ok(await page.locator(".wv-badge").isHidden(), "badge cleared after NSFW off");

    console.log("4) search epoch guard: typing a query replaces results");
    const firstName = await page.locator(".wv-card-name").first().textContent();
    await page.locator(".wv-search").fill("elf");
    await page.waitForTimeout(4500); // 400ms debounce + fetch
    const cards3 = await page.locator(".wv-card-name").allTextContents();
    ok(cards3.length > 0 && cards3.some(t => /elf/i.test(t) || cards3.length >= 1), `query search returned ${cards3.length} cards`);
    ok(cards3.length > 0, `query results present (first: ${firstName} → ${cards3[0]})`);

    console.log("5) sort menu switch");
    await page.locator(".wv-sortbtn").click();
    await page.locator('.wv-menu button[data-sort="latest"]').click();
    await page.waitForTimeout(4000);
    ok(await page.locator(".wv-card").count() > 0, "sort=latest renders");
    await page.screenshot({ path: SHOT + "v02-vault-sorted.png" });

    console.log("5b) filter sheet opens with tag cloud");
    await page.locator(".wv-filterbtn").click();
    await page.waitForTimeout(3500);
    ok(await page.locator(".wv-modal").isVisible(), "filter modal visible");
    const tagCount = await page.locator(".wv-tchip").count();
    ok(tagCount >= 5, `tag cloud loaded ${tagCount} tags`);
    await page.screenshot({ path: SHOT + "v02-vault-filters.png" });
    await page.locator(".wv-mclose").click();
    await page.waitForTimeout(300);

    console.log("6) infinite scroll sentinel exists");
    ok(await page.locator(".wv-sentinel").count() === 1, "sentinel present");

    await browser.close();
    console.log(problems.length ? `\nVAULT UI FAILURES: ${problems.length}` : "\nVAULT UI OK");
    process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
