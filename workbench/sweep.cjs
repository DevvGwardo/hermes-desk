// Sweep: try pause-from-start (neutral first frame) + settle-time variants.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

function findChrome() {
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  for (const d of fs.readdirSync(PW)) {
    if (d.startsWith('chromium-')) {
      for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) {
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

async function capture(browser, mode, settleMs, outFile) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.evaluate(({ mode }) => {
    const host = document.getElementById('host');
    host.innerHTML = '';
    if (window.__inst) { try { window.__inst.unmount(); } catch {} }
    if (mode === 'paused-first') {
      window.__inst = GrokEngine.mount({ state: 'idle', shape: 'cat', size: 512, paused: true, gazeTarget: null }, host);
    } else {
      window.__inst = GrokEngine.mount({ state: 'idle', shape: 'cat', size: 512, gazeTarget: null }, host);
    }
  }, { mode });
  await page.waitForTimeout(settleMs);
  await page.evaluate(() => window.__inst && window.__inst.setPaused(true));
  await page.waitForTimeout(300);
  const svg = await page.$('#host svg');
  await svg.screenshot({ path: outFile, omitBackground: true });
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const variants = [
    ['paused-first', 800],
    ['paused-first', 2000],
    ['live', 3000], ['live', 5000], ['live', 8000], ['live', 11000],
  ];
  for (const [mode, ms] of variants) {
    const out = path.join(__dirname, 'out', `sweep_${mode}_${ms}.png`);
    await capture(browser, mode, ms, out);
    console.log('wrote', out);
  }
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
