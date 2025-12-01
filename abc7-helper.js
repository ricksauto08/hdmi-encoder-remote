const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
require('console-stamp')(console, {
  format: ':date(yyyy/MM/dd HH:MM:ss.l)',
});

// ---------- config ----------

const ABC_URL = process.env.ABC_URL || 'https://abc.com/watch-live/';
const VIDEO_WIDTH = Number(process.env.VIDEO_WIDTH || 1920);
const VIDEO_HEIGHT = Number(process.env.VIDEO_HEIGHT || 1080);
const PROFILE_DIR =
  process.env.PROFILE_DIR ||
  path.join(os.homedir(), '.chrome-hdmi-remote-profile-abc-test');

// ---------- helpers ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectChromeExecutable() {
  const override = process.env.CHROME_BIN;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      // ignore
    }
  }

  throw new Error(
    'Could not find Chrome executable. Set CHROME_BIN to its full path.'
  );
}

// ---------- main ABC helper ----------

async function runAbcHelper(page) {
  console.log('[abc-abc] navigating to:', ABC_URL);

  await page.goto(ABC_URL, {
    waitUntil: ['load', 'networkidle2'],
    timeout: 90_000,
  });

  await page.bringToFront();

  // Give the page/player a few seconds to boot
  console.log('[abc-abc] page loaded, waiting ~4s before gesture');
  await sleep(4000);

  // 1) "Touch screen" – click center of the video area
  const centerX = VIDEO_WIDTH / 2;
  const centerY = VIDEO_HEIGHT / 2;
  await page.mouse.move(centerX, centerY, { steps: 25 });
  await page.mouse.click(centerX, centerY, { button: 'left' });
  console.log(`[abc-abc] clicked center at ${centerX},${centerY}`);

  // 2) Press "m" to toggle mute
  await sleep(100); // tiny delay so the click is processed
  await page.keyboard.press('m');
  console.log('[abc-abc] sent "m" key (mute/unmute)');

  // 3) After ~0.5s, press "f" for player fullscreen
  await sleep(500);
  await page.keyboard.press('f');
  console.log('[abc-abc] sent "f" key (player fullscreen)');

  console.log('[abc-abc] sequence done – leaving page open so you can inspect');
}

// ---------- bootstrap ----------

async function main() {
  const chromePath = detectChromeExecutable();
  console.log('[abc-abc] Using browser executable:', chromePath);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
    },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
      '--window-position=0,0',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${PROFILE_DIR}`,
    ],
    env: {
      ...process.env,
    },
  });

  try {
    const [page] = await browser.pages();
    await runAbcHelper(page);
    // Keep browser open so you can see the result
  } catch (err) {
    console.error('[abc-abc] error:', err);
  }
}

main().catch((err) => {
  console.error('[abc-abc] fatal error:', err);
});
