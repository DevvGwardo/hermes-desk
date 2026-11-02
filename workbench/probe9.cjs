const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
const crypto = require('crypto');
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await b.newPage({ viewport: { width: 900, height: 900 } });
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/index.html', { waitUntil: 'load' });
  for (let i = 0; i < 6; i++) {
    await pg.waitForTimeout(1500);
    const h = await pg.evaluate(() => {
      const s = document.getElementById('stage').innerHTML;
      return s.length + ':' + s.slice(0, 60);
    });
    console.log(i, h);
  }
  await b.close();
})();
