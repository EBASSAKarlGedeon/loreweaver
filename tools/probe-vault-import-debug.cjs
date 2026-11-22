// Manual import probe: click first card's FAB, capture the full pipeline round-trip,
// toastr, console errors, and the resulting character file state.
const { chromium } = require("C:/Users/Gedeon/Documents/Coding/Loreweaver/public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright");
(async () => {
    const base = process.env.LW_PORT ? `http://127.0.0.1:${process.env.LW_PORT}` : "http://127.0.0.1:8000";
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const logs = [];
    page.on("console", m => logs.push(`[console.${m.type()}] ${m.text().slice(0, 250)}`));
    page.on("pageerror", e => logs.push("[pageerror] " + e.message.slice(0, 250)));
    page.on("response", async r => {
        if (/api\/content\/importURL|api\/characters\/(edit|import)|api\/characters\/all/.test(r.url())) {
            const body = await r.text().catch(() => "");
            logs.push(`[${r.status()}] ${r.request().method()} ${r.url().slice(r.url().indexOf("/api/"))} :: ${body.slice(0, 160)}`);
        }
    });
    await page.goto(base + "/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(9000);
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1200);
    await page.locator("#wv-launcher").click();
    await page.waitForTimeout(25000); // grid search
    await page.locator(".wv-card").first().click();
    await page.waitForSelector(".wv-dwin", { timeout: 20000 });
    await page.waitForTimeout(6000); // detail fetch
    await page.locator(".wv-dfab").click();
    await page.waitForTimeout(15000); // import round-trip
    const toasts = await page.evaluate(() =>
        [...document.querySelectorAll(".toast-error, .toast-warning, .toast-success, .toast-info")]
            .map(t => t.innerText.trim().slice(0, 120)));
    console.log("toasts:", JSON.stringify(toasts));
    console.log("log tail:\n" + logs.slice(-20).join("\n"));
    await browser.close();
})().catch(e => { console.error("PROBE ERROR:", e.message); process.exit(1); });
