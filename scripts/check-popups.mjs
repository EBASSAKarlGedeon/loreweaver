// Checks the character details popup and the Appearance panel on the landing page.
// Needs seeded data first: node scripts/seed-sample-data.mjs
// Usage: node scripts/check-popups.mjs
import { APP_URL, connect, wait } from './cdp.mjs';

const ESCAPE = ['Escape', 'Escape', 27];
const browser = await connect();
await browser.send('Page.navigate', { url: `${APP_URL}/` });
await wait(4000);

// Character details
await browser.evaluate(`document.querySelectorAll('.stlp-char-card')[0].click()`);
await wait(800);
console.log(`screenshot: ${await browser.screenshot('details')}`);
browser.check('details popup opens', await browser.evaluate(`!!document.querySelector('.stlp-details')`), true);
await browser.pressKey(...ESCAPE);
await wait(400);
browser.check('Escape closes details', await browser.evaluate(`!document.querySelector('.stlp-details')`), true);

// Studio drawer (opened from the top bar gear)
await browser.evaluate(`document.querySelector('button[aria-label="Open Studio"]').click()`);
await wait(800);
browser.check('panel opens on Theme tab', await browser.evaluate(`document.querySelector('.stlp-tabs .active')?.textContent.trim()`), 'Theme');
await browser.evaluate(`[...document.querySelectorAll('.stlp-tabs button')].find(b => b.textContent.trim() === 'Cards').click()`);
await wait(400);
console.log(`screenshot: ${await browser.screenshot('appearance-cards')}`);
browser.check('Cards tab shows the card style control', await browser.evaluate(`document.querySelectorAll('.stlp-segmented button').length >= 4`), true);
await browser.pressKey(...ESCAPE);
await wait(400);
browser.check('Escape closes panel', await browser.evaluate(`!document.querySelector('.stlp-settings')`), true);

browser.close();
