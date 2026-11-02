import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/Users/devgwardo/hermes-desk/docs/blueprint/media';
const APP_URL = 'http://127.0.0.1:5173';

function findChrome() {
  const pw = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  for (const d of fs.readdirSync(pw)) {
    if (!d.startsWith('chromium-')) continue;
    for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                       'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
      const p = path.join(pw, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no chrome found');
}

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

async function capture(url, file, waitFor) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  if (waitFor) {
    try { await page.waitForFunction(waitFor, null, { timeout: 15000 }); } catch {}
  }
  await page.waitForTimeout(2000); // let engine settle
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`captured: ${file}`);
  await page.close();
}

// Gallery mode — shows all states at once
await capture(`${APP_URL}/mascot-lab.html?mode=gallery&character=owl`, 'mascot-gallery.jpg',
  () => document.querySelector('[data-character]') !== null);

// Stage mode — the flight test lab
await capture(`${APP_URL}/mascot-lab.html?mode=stage&character=owl`, 'mascot-stage.jpg',
  () => window.mascotStage !== undefined);

await browser.close();
console.log('done');
