// Probe: open a card's detail window and screenshot the Glaze rebuild:
// hero + tabs + Info pane; Prompt Blocks accordion; FAB + import options sheet.
// Usage: node tools/probe-vault-detail.cjs  (server on 127.0.0.1:8000 or $LW_PORT)
const { chromium } = require('../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright');

(async () => {
    const SHOT = process.env.SHOT_DIR || "C:/Users/Gedeon/AppData/Local/Temp/rpge-heavy/";
    const base = process.env.LW_PORT ? `http://127.0.0.1:${process.env.LW_PORT}` : "http://127.0.0.1:8000";
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(base + "/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(8000);
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1500);
    await page.locator("#wv-launcher").click();
    await page.waitForTimeout(1000);
    await page.waitForSelector(".wv-card", { timeout: 30000 });
    await page.waitForTimeout(3000); // posters

    // open detail on the first card
    await page.locator(".wv-card").first().click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: SHOT + "d1-detail-hero.png" });

    // tab: Prompt Blocks
    await page.locator(".wv-dtab").nth(1).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT + "d2-detail-prompts.png" });

    // open one accordion
    await page.locator(".wv-acc .wv-acchead").nth(1).click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT + "d3-detail-accordion.png" });

    // tab: Images
    await page.locator(".wv-dtab").nth(2).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT + "d4-detail-images.png" });

    // back to Info, FAB + import options sheet
    await page.locator(".wv-dtab").nth(0).click();
    const hasFAB = await page.locator(".wv-dfab").isVisible();
    console.log("FAB visible:", hasFAB);
    await page.locator(".wv-dfab").click();
    await page.waitForTimeout(500);
    const modeSheet = await page.locator(".wv-modesheet").isVisible().catch(() => false);
    console.log("import options sheet:", modeSheet);
    await page.screenshot({ path: SHOT + "d5-detail-mode-sheet.png" });
    await page.locator(".wv-mode-overlay").click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(300);

    // kebab popup
    await page.locator(".wv-dkebab").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: SHOT + "d6-detail-kebab.png" });

    await browser.close();
    console.log("DETAIL PROBE DONE");
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
