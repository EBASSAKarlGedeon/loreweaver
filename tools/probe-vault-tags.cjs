// Probe: open the filter sheet's TAGS card and screenshot the tag cloud
// (verifies parseChubTags lowercase/dedupe behavior end-to-end).
// Usage: node tools/probe-vault-tags.cjs  (server on 127.0.0.1:8000 or $LW_PORT)
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
    await page.locator(".wv-filterbtn").click();
    await page.waitForTimeout(4000); // tag cloud fetch (server round-trip)
    const names = await page.locator(".wv-tchip").allTextContents();
    console.log('chips:', names.length);
    console.log('sample:', names.slice(0, 12).map(s => s.trim()).join(' | '));
    console.log('all lowercase:', names.map(s => s.trim()).every(n => n === n.toLowerCase()));
    // scroll the TAGS card into view inside the sheet and screenshot it
    await page.evaluate(() => {
        const card = [...document.querySelectorAll('.wv-mcard, .wv-mgroup')].find(g => /TAGS/i.test(g.textContent) && g.querySelector('.wv-tchip'));
        if (card) card.scrollIntoView({ block: 'start' });
        return Boolean(card);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT + "probe-tags-lower.png" });
    await browser.close();
    if (names.length >= 5 && names.map(s => s.trim()).every(n => n === n.toLowerCase())) console.log('TAGS LOWERCASE OK');
    else process.exit(1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
