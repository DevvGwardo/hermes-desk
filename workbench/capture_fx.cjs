// Capture every fx pattern as a short looping GIF (via frames + ffmpeg palette)
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT_GIFS = path.join(__dirname, 'out', 'fx_gifs');
const FPS = 20;

(async () => {
  fs.mkdirSync(OUT_GIFS, { recursive: true });
  const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 480, height: 480 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'index.html'), { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const patterns = await page.evaluate(() => GrokEngine.uzt);

  // hide everything except the stage, blow the stage up to fill the viewport
  await page.addStyleTag({ content: `
    body > *:not(#sec-single), #sec-single .cell, #sec-single div[style*="margin-top"] { display: none !important; }
    #stage { position: fixed; inset: 0; width: 100vw; height: 100vh; border-radius: 0; }
  `});

  const tmp = '/tmp/fx_frames_' + Date.now();
  fs.mkdirSync(tmp, { recursive: true });

  let done = 0;
  for (const pat of patterns) {
    const state = await page.evaluate(p => {
      const dzt = GrokEngine.dzt;
      return Object.keys(dzt).find(s => dzt[s] === p) || null;
    }, pat);
    if (!state) { console.log('skip', pat, '(no driving state)'); continue; }

    // remount stage with this state at capture size
    await page.evaluate(s => {
      const stage = document.getElementById('stage');
      stage.querySelectorAll('span').forEach(n => n.remove());
      const w = document.createElement('span');
      w.style.cssText = '--fg:#b7d9ff;--bg:#1a3d6b;display:inline-block;line-height:0';
      stage.appendChild(w);
      GrokEngine.mount({ state: s, size: 300 }, stage);
    }, state);
    await page.waitForTimeout(400);

    const dir = path.join(tmp, pat);
    fs.mkdirSync(dir, { recursive: true });
    const frames = FPS * 3; // 3s loop
    for (let i = 0; i < frames; i++) {
      await page.screenshot({ path: path.join(dir, `f_${String(i).padStart(4,'0')}.png`),
        clip: { x: 40, y: 40, width: 400, height: 400 } });
      await page.waitForTimeout(1000 / FPS);
    }
    execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i ${dir}/f_%04d.png -vf "fps=14,scale=340:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" -loop 0 ${path.join(OUT_GIFS, pat)}.gif`);
    done++;
    console.log(`ok ${pat}.gif (${state})`);
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${done}/${patterns.length} fx gifs captured`);
})().catch(e => { console.error(e); process.exit(1); });
