const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const PW = process.env.HOME + '/Library/Caches/ms-playwright';
let exe = null;
for (const d of fs.readdirSync(PW)) {
  if (d.startsWith('chromium-')) for (const p of [path.join(PW,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'), path.join(PW,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing')]) if (fs.existsSync(p)) exe = p;
}
(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true });
  for (const args of ['--force-prefers-reduced-motion', '']) {
    const ctx = await b.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2, reducedMotion: args ? 'reduce' : 'no-preference' });
    const pg = await ctx.newPage();
    await pg.goto('file://' + process.env.HOME + '/maiavm-desktop/workbench/icon-capture.html', { waitUntil: 'load' });
    await pg.waitForTimeout(2500);
    const r = await pg.evaluate(() => ({
      rm: matchMedia('(prefers-reduced-motion: reduce)').matches,
      eyes: [...document.querySelectorAll('#host svg path')].filter(el => el.style && el.style.fill === 'var(--bg)').map(el => el.getAttribute('transform')),
    }));
    console.log(args || 'no-preference', 'rm=' + r.rm, JSON.stringify(r.eyes));
    await ctx.close();
  }
  await b.close();
})();
