const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  for (const wait of [1000, 6000]) {
    const pg = await b.newPage({ viewport: { width: 900, height: 900 } });
    await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
    await pg.waitForTimeout(wait);
    const info = await pg.evaluate(() => {
      const svg = document.querySelector('#host svg');
      const out = [];
      svg.querySelectorAll('circle').forEach(c => {
        out.push({ cx: c.getAttribute('cx'), cy: c.getAttribute('cy'), r: c.getAttribute('r'),
          transform: c.getAttribute('transform'), display: c.style.display });
      });
      const gs = [];
      svg.querySelectorAll('g').forEach(g => { if (g.getAttribute('transform')) gs.push(g.getAttribute('transform').slice(0,120)); });
      return { circles: out, gTransforms: gs };
    });
    console.log('=== wait', wait, '===');
    console.log(JSON.stringify(info, null, 1).slice(0, 2500));
    await pg.close();
  }
  await b.close();
})();
