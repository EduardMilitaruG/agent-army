#!/usr/bin/env node
// Read-only look at a web page in a real (headless) browser, for pages that need JavaScript
// (auction sites, job boards). Saves a screenshot the bot can open with Read, and prints the text.
//   node tools/snap.mjs https://www.example.com/lot/123
// Safety: GET requests only (no forms, logins, bids or posts can be sent), no downloads,
// linkedin.com is refused, nothing is clicked or typed, fresh profile every time (no cookies).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const url = process.argv[2];
if (!url || !/^https:\/\/[^\s]+$/i.test(url)) { console.error('usage: snap.mjs https://...'); process.exit(2); }
const host = new URL(url).hostname;
if (/(^|\.)linkedin\.com$/i.test(host)) { console.error('Refused: linkedin.com is never opened.'); process.exit(3); }
if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) { console.error('Refused: only public websites.'); process.exit(3); }

const require = createRequire(resolve(import.meta.dirname, '..', '..', 'jobfy-qa', 'job-hunter', 'package.json'));
const { chromium } = require('@playwright/test');
const OUT = resolve(import.meta.dirname, '..', 'data', 'snaps');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
let blocked = 0;
try {
  const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 }, locale: 'es-ES' });
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.method() !== 'GET' || /(^|\.)linkedin\.com$/i.test(new URL(req.url()).hostname)) { blocked++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  const file = resolve(OUT, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${host.replace(/[^a-z0-9.-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true, timeout: 20000 }).catch(() => page.screenshot({ path: file }));
  const title = await page.title();
  const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\n{3,}/g, '\n\n').slice(0, 15000);
  console.log(`Title: ${title}\nURL: ${page.url()}\nScreenshot: ${file.replace(/\\/g, '/')} (open it with Read)\nBlocked non-GET requests: ${blocked}\n\n--- page text ---\n${text}`);
} catch (e) {
  console.error(`Could not load the page: ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
