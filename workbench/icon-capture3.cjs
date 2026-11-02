// Final icon capture: animated (reducedMotion no-preference) idle cat,
// gaze null. Polls live eye placement in SVG space until mirrored about
// body center-x (114.27) and level (<0.8u ≈ <3.2px @1024), eyes fully open,
// then pauses + element-screenshots the <svg> art node (omitBackground).
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

function findChrome() {
  const PW = process.env.HOME + '/Library/Caches/ms-playwright';
  for (const d of fs.readdirSync(PW)) {
    if (d.startsWith('chromium-')) {
      for (const p of [path.join(PW, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                        path.join(PW, d, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')]) {
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

const CX = 114.27, TOL = 0.8;

async function main() {
  const outFile = process.argv[2] || path.join(__dirname, 'out', 'orb_raw.png');
  const budgetMs = parseInt(process.argv[3] || '240000', 10);
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, 'icon-capture.html'), { waitUntil: 'load' });
  await page.evaluate(() => {
    const host = document.getElementById('host');
    host.innerHTML = '';
    try { window.__inst.unmount(); } catch {}
    window.__inst = GrokEngine.mount({ state: 'idle', shape: 'cat', size: 512, gazeTarget: null }, host);
    window.__inst.setGaze(null);
  });
  const t0 = Date.now();
  let polls = 0, best = null, shot = null;
  while (Date.now() - t0 < budgetMs) {
    await page.waitForTimeout(150);
    polls++;
    const eyes = await page.evaluate(() => [...document.querySelectorAll('#host svg path')]
      .filter(el => el.style && el.style.fill === 'var(--bg)')
      .map(el => el.getAttribute('transform')));
    if (eyes.length !== 2) continue;
    const pts = [];
    for (const t of eyes) {
      const m = t.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\)/);
      if (!m) break;
      pts.push({ x: +m[1], y: +m[2], sx: +m[3], sy: +m[4] });
    }
    if (pts.length !== 2) continue;
    pts.sort((a, b) => a.x - b.x);
    const mirror = Math.abs(pts[0].x + pts[1].x - 2 * CX);
    const level = Math.abs(pts[0].y - pts[1].y);
    const open = Math.min(pts[0].sy, pts[1].sy) > 0.7;
    const err = mirror + level;
    if (!best || err < best.err) best = { err, mirror, level, open, at: Date.now() - t0 };
    if (mirror < TOL && level < TOL && open) {
      await page.evaluate(() => window.__inst.setPaused(true));
      await page.waitForTimeout(250);
      const svg = await page.$('#host svg');
      const cand = outFile.replace(/\.png$/, '.cand.png');
      await svg.screenshot({ path: cand, omitBackground: true });
      shot = { file: cand, mirror, level, polls, elapsed: Date.now() - t0 };
      break;
    }
  }
  console.log('polls:', polls, 'elapsed:', Date.now() - t0, 'best:', JSON.stringify(best));
  if (!shot) {
    console.log('NO symmetric frame in budget');
    await browser.close();
    process.exit(2);
  }
  fs.copyFileSync(shot.file, outFile);
  console.log('PASS mirror=' + shot.mirror.toFixed(3) + ' level=' + shot.level.toFixed(3) + ' -> ' + outFile);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
