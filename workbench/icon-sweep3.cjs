// Sweep states: setState, settle, 3 element shots each (running, motion on).
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
async function main() {
  const states = (process.argv[2] || 'happy,surprised,excited,celebrate,curious,playful,proud').split(',');
  const outDir = '/tmp/orb_states';
  fs.mkdirSync(outDir, { recursive: true });
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  const exe = path.join(PW, 'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ reduced_motion: 'no-preference', viewport: { width: 900, height: 900 }, device_scale_factor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const el = await page.$('#host');
  for (const s of states) {
    await page.evaluate(st => window.__setState(st), s);
    await page.waitForTimeout(2200); // let expression establish
    for (let i = 0; i < 3; i++) {
      await el.screenshot({ path: path.join(outDir, `${s}_${i}.png`), omitBackground: true });
      await page.waitForTimeout(700);
    }
    console.log('shot', s);
  }
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
