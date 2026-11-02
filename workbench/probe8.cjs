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
  await pg.waitForTimeout(1500);
  const info = await pg.evaluate(() => {
    const out = [];
    document.querySelectorAll('#host svg path').forEach(el => {
      if (el.style && el.style.fill === 'var(--bg)') {
        const cs = getComputedStyle(el);
        out.push({ d: el.getAttribute('d').slice(0,50), transformAttr: el.getAttribute('transform'),
          styleTransform: el.style.transform || null, computedTransform: cs.transform,
          animations: (el.getAnimations ? el.getAnimations().map(a => ({ name: (a.animationName||null), playState: a.playState, cur: a.currentTime })) : []) });
      }
    });
    // parent g transforms chain for first eye
    let chain = [];
    let el = null;
    document.querySelectorAll('#host svg path').forEach(p => { if (p.style && p.style.fill === 'var(--bg)' && !el) el = p; });
    while (el) { chain.push(el.tagName + ':' + (el.getAttribute('transform') || el.style.transform || '-')); el = el.parentElement; }
    return { eyes: out, chain };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 2500));
  await b.close();
})();
