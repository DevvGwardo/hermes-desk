// happy + particles suppressed, true 2x, 4 shots.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
async function main() {
  const outDir = '/tmp/orb_nofx';
  fs.mkdirSync(outDir, { recursive: true });
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  const exe = path.join(PW, 'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__setState('happy'); window.__inst.setParticles([]); });
  await page.waitForTimeout(2500);
  const el = await page.$('#host');
  for (let i = 0; i < 4; i++) {
    await el.screenshot({ path: path.join(outDir, `nofx_${i}.png`), omitBackground: true });
    await page.waitForTimeout(800);
  }
  await browser.close();
  console.log('done');
}
main().catch(e => { console.error(e); process.exit(1); });
