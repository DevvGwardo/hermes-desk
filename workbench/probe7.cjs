const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await b.newPage();
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  const r = await pg.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res({ frames: n, vis: document.visibilityState, hidden: document.hidden }); };
    requestAnimationFrame(tick);
  }));
  console.log('headless rAF:', JSON.stringify(r));
  await b.close();
  // headed attempt
  try {
    const b2 = await chromium.launch({ executablePath: exe, headless: false });
    const pg2 = await b2.newPage();
    await pg2.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
    const r2 = await pg2.evaluate(() => new Promise(res => {
      let n = 0; const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res({ frames: n, vis: document.visibilityState }); };
      requestAnimationFrame(tick);
    }));
    console.log('headed rAF:', JSON.stringify(r2));
    await b2.close();
  } catch (e) { console.log('headed failed:', e.message.split('\n')[0]); }
})();
