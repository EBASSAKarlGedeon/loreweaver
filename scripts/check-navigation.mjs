// Checks the landing-to-chat flows: Start New Chat, Continue, and an unknown chat id.
// Needs seeded data first: node scripts/seed-sample-data.mjs
// Usage: node scripts/check-navigation.mjs
import { APP_URL, connect, wait } from './cdp.mjs';

const browser = await connect();

await browser.send('Page.navigate', { url: `${APP_URL}/` });
await wait(2500);
// Mira has no chats yet: open her details and start one
await browser.evaluate(`[...document.querySelectorAll('.stlp-char-card')].find(c => c.textContent.includes('Mira')).click()`);
await wait(500);
await browser.evaluate(`document.querySelector('.stlp-details-newchat').click()`);
await wait(4000);
browser.check('Start New Chat opens /chat/<id>', await browser.evaluate(`/^\\/chat\\/\\d+$/.test(location.pathname)`), true);
browser.check('new chat shows the character', await browser.evaluate(`document.querySelector('.conv-header')?.textContent.trim()`), 'Chatting with Mira Tessel');
browser.check('new chat has its first message', await browser.evaluate(`[...document.querySelectorAll('.msg')].map(m => m.textContent.trim())`), ['Mira Tessel Hello there!']);

await browser.send('Page.navigate', { url: `${APP_URL}/` });
await wait(2500);
await browser.evaluate(`document.querySelector('.stlp-hero-continue').click()`);
await wait(4000);
browser.check('Continue opens the most recent chat', await browser.evaluate(`document.querySelector('.conv-header')?.textContent.trim()`), 'Chatting with Mira Tessel');

await browser.send('Page.navigate', { url: `${APP_URL}/chat/999999` });
await wait(4000);
browser.check('unknown chat shows a message', await browser.evaluate(`document.querySelector('.empty p')?.textContent.trim()`), 'This chat no longer exists.');

browser.close();
