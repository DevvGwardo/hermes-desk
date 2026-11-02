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
  for (const shape of ['cat', 'blob']) {
    await pg.evaluate((sh) => {
      const host = document.getElementById('host');
      host.innerHTML = '';
      try { window.__inst.unmount(); } catch {}
      window.__inst = GrokEngine.mount({ state: 'idle', shape: sh, size: 512, gazeTarget: null }, host);
    }, shape);
    await pg.waitForTimeout(2500);
    const d = await pg.evaluate(() => {
      const out = [];
      document.querySelectorAll('#host svg path').forEach(el => {
        if (el.style && el.style.fill === 'var(--bg)') out.push(el.getAttribute('d').slice(0,70));
      });
      return out;
    });
    console.log(shape, JSON.stringify(d));
    const svg = await pg.$('#host svg');
    await svg.screenshot({ path: `out/shape_${shape}.png`, omitBackground: true });
  }
  await b.close();
})();
