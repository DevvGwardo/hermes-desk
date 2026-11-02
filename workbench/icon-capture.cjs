// Icon capture: idle cat, size 512, transparent bg, element-only screenshot @2x.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function findChrome() {
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  try {
    for (const d of fs.readdirSync(PW)) {
      if (d.startsWith('chromium-')) {
        const cands = [
          path.join(PW, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(PW, d, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        ];
        for (const p of cands) if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

async function main() {
  const outFile = process.argv[2] || path.join(__dirname, 'out', 'orb_raw.png');
  const exe = findChrome() || (fs.existsSync(CHROME_APP) ? CHROME_APP : null);
  if (!exe) throw new Error('no chrome found');
  console.log('chrome:', exe);
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1500); // settle
  const el = await page.$('#host');
  if (!el) throw new Error('no #host element');
  const box = await el.boundingBox();
  console.log('host box:', JSON.stringify(box));
  // freeze a clean frame, then shoot element only
  await page.evaluate(() => window.__pause(true));
  await page.waitForTimeout(300);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await el.screenshot({ path: outFile, omitBackground: true });
  console.log('wrote', outFile);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
