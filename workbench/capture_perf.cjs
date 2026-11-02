// Perf-only capture: wait for harness to finish, grab chart + numbers
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');

(async () => {
  const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 1.5 });
  await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' });
  // harness: 4 runs x (300ms settle + 3s sample) + final 2.5s ≈ 18s — poll until ready
  await page.waitForFunction(() => window.__PERF_RESULTS && document.getElementById('perf').textContent.includes('orbs'), null, { timeout: 45000 });
  const results = await page.evaluate(() => window.__PERF_RESULTS);
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(results, null, 2));
  const chartEl = await page.$('#sec-perf');
  await chartEl.screenshot({ path: path.join(OUT, 'perf_chart.png') });
  console.log('perf:', JSON.stringify(results));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
