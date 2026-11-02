// Sweep with centered gaze: forces pupils to neutral, then samples frames.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
async function main() {
  const outDir = '/tmp/orb_gaze';
  fs.mkdirSync(outDir, { recursive: true });
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  const exe = path.join(PW, 'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ reduced_motion: 'no-preference', viewport: { width: 900, height: 900 }, device_scale_factor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const el = await page.$('#host');
  const box = await el.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(([x, y]) => window.__inst.setGaze({ x, y }), [cx, cy]);
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(700);
    await page.evaluate(([x, y]) => window.__inst.setGaze({ x, y }), [cx, cy]);
    await el.screenshot({ path: path.join(outDir, `g_${i}.png`), omitBackground: true });
  }
  await browser.close();
  console.log('done');
}
main().catch(e => { console.error(e); process.exit(1); });
