const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await b.newPage({ viewport: { width: 900, height: 900 } });
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  for (let i = 0; i < 10; i++) {
    await pg.waitForTimeout(1000);
    const d = await pg.evaluate(() => {
      const out = [];
      document.querySelectorAll('#host svg path').forEach(el => {
        if (el.style && el.style.fill === 'var(--bg)') out.push(el.getAttribute('d').slice(0,60));
      });
      return out;
    });
    console.log(i, JSON.stringify(d));
  }
  await b.close();
})();
