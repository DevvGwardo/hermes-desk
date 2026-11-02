const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const pg = await (await b.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: 'no-preference' })).newPage();
  await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
  const r = await pg.evaluate(() => ({ Aqe: GrokEngine.Aqe, tzt: GrokEngine.tzt }));
  console.log('Aqe=', JSON.stringify(r.Aqe).slice(0, 600));
  // poll eye transforms for 25s in no-preference mode
  let last = '';
  for (let i = 0; i < 13; i++) {
    await pg.waitForTimeout(2000);
    const eyes = await pg.evaluate(() => [...document.querySelectorAll('#host svg path')].filter(el => el.style && el.style.fill === 'var(--bg)').map(el => el.getAttribute('transform')));
    const s = JSON.stringify(eyes);
    console.log(i, s === last ? 'SAME' : s);
    last = s;
  }
  await b.close();
})();
