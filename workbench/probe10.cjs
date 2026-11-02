const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await b.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  await pg.waitForTimeout(1500);
  const before = await pg.evaluate(() => {
    const out = [];
    document.querySelectorAll('#host svg path').forEach(el => { if (el.style && el.style.fill === 'var(--bg)') out.push(el.getAttribute('transform')); });
    return out;
  });
  console.log('before setState:', JSON.stringify(before));
  await pg.evaluate(() => { window.__inst.setState('idle'); window.__inst.setGaze(null); window.__inst.setPaused(true); });
  await pg.waitForTimeout(600);
  const after = await pg.evaluate(() => {
    const out = [];
    document.querySelectorAll('#host svg path').forEach(el => { if (el.style && el.style.fill === 'var(--bg)') out.push(el.getAttribute('transform')); });
    return out;
  });
  console.log('after setState:', JSON.stringify(after));
  const svg = await pg.$('#host svg');
  await svg.screenshot({ path: 'out/reset_test.png', omitBackground: true });
  await b.close();
})();
