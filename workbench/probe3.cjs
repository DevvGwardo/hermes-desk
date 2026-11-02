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
  await pg.waitForTimeout(2500);
  const info = await pg.evaluate(() => {
    const svg = document.querySelector('#host svg');
    const out = [];
    svg.querySelectorAll('*').forEach(el => {
      const fill = el.style && el.style.fill;
      let bb = null;
      try { if (el.getBBox) { const b = el.getBBox(); bb = [b.x, b.y, b.width, b.height]; } } catch {}
      const r = el.getBoundingClientRect ? (() => { const t = el.getBoundingClientRect(); return [t.x, t.y, t.width, t.height]; })() : null;
      out.push({ tag: el.tagName, fill: fill || el.getAttribute && el.getAttribute('fill'), d: el.getAttribute && el.getAttribute('d') ? el.getAttribute('d').slice(0,80) : null, bbox: bb, clientRect: r });
    });
    return out;
  });
  for (const e of info) {
    if (e.fill && e.fill.includes('--bg')) console.log(JSON.stringify(e));
  }
  await b.close();
})();
