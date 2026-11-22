const { chromium } = require("C:/Users/Gedeon/Documents/Coding/Loreweaver/public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/node_modules/playwright");
(async () => {
    const base = process.env.LW_PORT ? `http://127.0.0.1:${process.env.LW_PORT}` : "http://127.0.0.1:8000";
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const logs = [];
    page.on("response", async r => {
        if (/api\/weavers-vault/.test(r.url())) {
            const body = await r.text().catch(() => "");
            logs.push(`[wv ${r.status()}] ${r.request().method()} ${r.url().slice(r.url().indexOf("/api"))} :: ${body.slice(0, 220)}`);
        }
    });
    page.on("pageerror", e => logs.push("[pageerror] " + e.message.slice(0, 200)));
    await page.goto(base + "/", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(9000);
    await page.locator("#stlp_exit_btn").click();
    await page.waitForTimeout(1200);
    await page.locator("#wv-launcher").click();
    await page.waitForTimeout(25000);
    const state = await page.evaluate(() => {
        const root = document.getElementById("wv-root");
        return { cards: root?.querySelectorAll(".wv-card").length ?? -1, body: (root?.innerText ?? "").slice(0, 200) };
    });
    console.log("state:", JSON.stringify(state));
    console.log("vault API traffic:\n" + (logs.join("\n") || "(none)"));
    await browser.close();
})().catch(e => { console.error("PROBE ERROR:", e.message); process.exit(1); });
