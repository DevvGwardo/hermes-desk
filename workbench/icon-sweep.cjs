// Sweep: idle cat running (motion on), N element shots, pick best later via score.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
async function main() {
  const n = parseInt(process.argv[2] || '10', 10);
  const outDir = process.argv[3] || '/tmp/orb_sweep';
  fs.mkdirSync(outDir, { recursive: true });
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  const exe = path.join(PW, 'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ reduced_motion: 'no-preference', viewport: { width: 900, height: 900 }, device_scale_factor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.waitForTimeout(2000); // settle past mount pose
  const el = await page.$('#host');
  for (let i = 0; i < n; i++) {
    await el.screenshot({ path: path.join(outDir, `cand_${i}.png`), omitBackground: true });
    await page.waitForTimeout(600);
  }
  await browser.close();
  console.log('done', n);
}
main().catch(e => { console.error(e); process.exit(1); });
