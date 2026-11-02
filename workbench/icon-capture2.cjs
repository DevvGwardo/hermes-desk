// Fixed icon capture: idle cat, gaze released (null), neutral settle,
// paused, ELEMENT screenshot of the <svg> art node itself (engine renders
// SVG, not <canvas>) with omitBackground => real transparency.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

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
  const settleMs = parseInt(process.argv[3] || '2500', 10);
  const exe = findChrome();
  if (!exe) throw new Error('no chrome found');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  // Idle cat, gaze released to neutral, no spin/bounce/burst calls.
  await page.evaluate(() => {
    window.__mount(512);
    if (window.__inst && window.__inst.setGaze) window.__inst.setGaze(null);
  });
  await page.waitForTimeout(settleMs);
  await page.evaluate(() => window.__pause(true));
  await page.waitForTimeout(300);
  const svg = await page.$('#host svg');
  if (!svg) throw new Error('no svg art element in #host');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await svg.screenshot({ path: outFile, omitBackground: true });
  console.log('wrote', outFile);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
