const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await (await b.newContext({ reducedMotion: 'no-preference' })).newPage();
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  await pg.waitForTimeout(500);
  // body bbox + eye placement
  const r = await pg.evaluate(() => {
    const svg = document.querySelector('#host svg');
    let body = null;
    svg.querySelectorAll('path').forEach(el => { if (el.style && el.style.fill === 'var(--fg)') { try { const b = el.getBBox(); if (!body || b.width*b.height > body.w*body.h) body = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch {} } });
    return { body };
  });
  console.log('body:', JSON.stringify(r));
  await b.close();
})();
