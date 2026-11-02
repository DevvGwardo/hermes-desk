const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) {
    for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) {
      if (fs.existsSync(p)) exe = p;
    }
  }
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await b.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  await pg.waitForTimeout(1200);
  const info = await pg.evaluate(() => {
    const host = document.getElementById('host');
    const all = [];
    host.querySelectorAll('*').forEach(el => all.push(el.tagName + (el.id ? '#'+el.id : '') + (el.className && el.className.baseVal === undefined ? '.'+String(el.className).split(' ').join('.') : '')));
    return { hostHTML: host.innerHTML.slice(0, 500), tags: all.slice(0, 20), n: all.length,
      canvas: !!host.querySelector('canvas'), svg: !!host.querySelector('svg') };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
