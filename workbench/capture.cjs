// Mascot workbench capture — screenshots, MP4 frames, perf data
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
function findChrome() {
  for (const d of fs.readdirSync(PW)) {
    if (d.startsWith('chromium-')) {
      const p = path.join(PW, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
      const p2 = path.join(PW, d, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(p2)) return p2;
    }
  }
  return null;
}

const OUT = path.join(__dirname, 'out');
const FPS = 30;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome() || CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('no chrome found');
  console.log('chrome:', exe);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 520, height: 520 }, deviceScaleFactor: 2 });

  // ── 1. state screenshots (stage view) ──
  const states = ['idle','thinking','working','happy','sleeping','listening','celebrate','error',
                  'orbit','radar','progress','loading','writing','alerting','sad','surprised'];
  await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const shotDir = path.join(OUT, 'states'); fs.mkdirSync(shotDir, { recursive: true });
  for (const s of states) {
    await page.evaluate(st => window.__setStage(st), s);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shotDir, `${s}.png`), clip: { x: 40, y: 60, width: 420, height: 420 } });
  }

  // light theme sample
  await page.evaluate(() => window.__setStage('idle'));
  await page.click('#btn-light');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shotDir, 'idle_light.png'), clip: { x: 40, y: 60, width: 420, height: 420 } });

  // shape morphs screenshot (full page section)
  const pageFull = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
  await pageFull.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' });
  await pageFull.waitForTimeout(2500); // let perf harness finish
  const shapesEl = await pageFull.$('#shapes');
  await shapesEl.screenshot({ path: path.join(OUT, 'shapes.png') });

  // contact sheet
  const sheetEl = await pageFull.$('#sheet');
  await sheetEl.screenshot({ path: path.join(OUT, 'sheet_states.png') });

  // perf chart + numbers
  const chartEl = await pageFull.$('#sec-perf, section:last-of-type');
  if (chartEl) await chartEl.screenshot({ path: path.join(OUT, 'perf_chart.png') });
  const perfText = await pageFull.evaluate(() => window.__PERF_RESULTS || null);
  if (perfText) fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(perfText, null, 2));
  console.log('perf:', JSON.stringify(perfText));

  // ── 2. animation captures → frames dir per clip ──
  async function captureClip(name, seconds, prep) {
    const dir = path.join(OUT, 'frames_' + name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (prep) { await prep(); await page.waitForTimeout(400); }
    const total = Math.floor(FPS * seconds);
    for (let i = 0; i < total; i++) {
      await page.screenshot({ path: path.join(dir, `f_${String(i).padStart(4,'0')}.png`),
        clip: { x: 40, y: 60, width: 420, height: 420 } });
      await page.waitForTimeout(1000 / FPS);
    }
    console.log(`captured ${name}: ${total} frames`);
  }

  await captureClip('thinking', 3.5, () => page.evaluate(s => window.__setStage(s), 'thinking'));
  await captureClip('burst_spin', 3.5, async () => {
    await page.evaluate(s => window.__setStage(s), 'idle');
    await page.evaluate(() => window.__spin());
    await page.evaluate(() => window.__burst());
  });
  await captureClip('celebrate', 3.5, () => page.evaluate(s => window.__setStage(s), 'celebrate'));
  await captureClip('orbit_fx', 4, () => page.evaluate(s => window.__setStage(s), 'orbit'));

  // shape morph video: cat -> cloud mid-flight
  await captureClip('morph', 3, async () => {
    await page.evaluate(s => window.__setStage(s), 'idle'); // cat default
    await page.selectOption('#shape-sel', 'cloud');
  });
  await captureClip('morph_gem', 3, async () => {
    await page.selectOption('#shape-sel', 'cat');
    await page.waitForTimeout(800);
    await page.selectOption('#shape-sel', 'gem');
  });

  // idle blink/gaze loop
  await captureClip('idle_live', 5, async () => {
    await page.selectOption('#shape-sel', 'cat');
    await page.evaluate(s => window.__setStage(s), 'idle');
  });

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
