const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const puppeteer = require('puppeteer-core');
const http = require('http');
const https = require('https');
const { URL } = require('url');
require('console-stamp')(console, {
  format: ':date(yyyy/MM/dd HH:MM:ss.l)',
});

// ------------------- Config helpers --------------------

function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const PORT =
  Number(process.env.HDMI_REMOTE_PORT || process.env.CC4C_PORT || 5589);

const VIDEO_WIDTH = Number(process.env.VIDEO_WIDTH || 1920);
const VIDEO_HEIGHT = Number(process.env.VIDEO_HEIGHT || 1080);

// How long to hold a "black" start before streaming TS (ms)
const BLACKOUT_MS = Number(process.env.BLACKOUT_MS || 3000);

const FULLSCREEN = envBool('FULLSCREEN', true);
const KIOSK = envBool('KIOSK', true);

const DEFAULT_URL = process.env.DEFAULT_URL || '';

const PROFILE_DIR =
  process.env.PROFILE_DIR ||
  path.join(os.homedir(), '.chrome-hdmi-remote-profile');

// Pull presets from env like CHAN_MSNOW, CHAN_CNN, etc.
const PRESETS = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('CHAN_') && value) {
    const name = key.slice(5).toLowerCase(); // CHAN_MSNOW -> 'msnow'
    PRESETS[name] = value;
  }
}

const TS_SOURCES = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('TS_') && value) {
    const name = key.slice(3).toLowerCase(); // TS_MSNOW -> 'msnow'
    TS_SOURCES[name] = value;
  }
}

console.log('Selected settings:');
console.log(`Port: ${PORT}`);
console.log(`Resolution: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);
console.log(`Fullscreen(F11): ${FULLSCREEN}`);
console.log(`Kiosk flag: ${KIOSK}`);
console.log(`Default URL: ${DEFAULT_URL || '(none)'}`);
console.log('Presets:', PRESETS);
console.log('TS sources:', TS_SOURCES);

// -------------------- Chrome detection --------------------

function detectChromeExecutable() {
  const override = process.env.CHROME_BIN;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const platform = process.platform;
  const candidates = [];

  if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
      'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    'Could not find Chrome executable. Set CHROME_BIN to its full path.'
  );
}

const CHROME_EXECUTABLE = detectChromeExecutable();
console.log(`Using browser executable: ${CHROME_EXECUTABLE}`);

// -------------------- Puppeteer state --------------------

/** @type {import('puppeteer-core').Browser | null} */
let browser = null;
/** @type {import('puppeteer-core').Page | null} */
let page = null;

let currentUrl = null;
let lastTuneAt = null;
const upSince = new Date().toISOString();

// Simple sleep helper (also used instead of page.waitForTimeout)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------- Browser helpers --------------------

async function getBrowser() {
  if (browser) return browser;

  browser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
      '--window-position=0,0',
      '--start-fullscreen',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--autoplay-policy=no-user-gesture-required',
      '--force-webrtc-ip-handling-policy=default_public_interface_only',
      KIOSK ? '--kiosk' : '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${PROFILE_DIR}`,
    ],
    env: {
      ...process.env, // important: propagate DISPLAY, etc.
    },
  });

  browser.on('disconnected', () => {
    console.warn('[browser] disconnected');
    browser = null;
    page = null;
  });

  return browser;
}

async function getPage() {
  const b = await getBrowser();
  if (page && !page.isClosed()) {
    return page;
  }

  const pages = await b.pages();
  page = pages[0] || (await b.newPage());

  try {
    await page.setViewport({
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
    });
  } catch (err) {
    console.warn('failed to set viewport (probably fine):', err.message);
  }

  return page;
}

async function ensureFullScreen(p) {
  if (!FULLSCREEN) return;
  try {
    await p.bringToFront();
    await p.keyboard.press('F11');
  } catch (err) {
    console.warn('failed to send F11 fullscreen toggle:', err.message);
  }
}

async function clickVideoJsFullscreen(p) {
  try {
    // Wait up to 15s for the player controls to appear
    await p.waitForSelector('.vjs-fullscreen-control', { timeout: 15000 });

    await p.evaluate(() => {
      const btn = document.querySelector('.vjs-fullscreen-control');
      if (btn && btn instanceof HTMLElement) {
        btn.click();
      }
    });

    console.log('[fullscreen] clicked .vjs-fullscreen-control');
  } catch (err) {
    console.warn('[fullscreen] could not click fullscreen button:', err.message);
  }
}

async function pressFullscreenKey(p) {
  try {
    // Give focus to the player area by clicking roughly in the center
    await p.bringToFront();
    await p.mouse.move(VIDEO_WIDTH / 2, VIDEO_HEIGHT / 2);
    await p.mouse.click();

    // Send the "f" key – many players treat this as "toggle fullscreen"
    await p.keyboard.press('f');

    console.log('[fullscreen] sent "f" key to page');
  } catch (err) {
    console.warn('[fullscreen] could not send "f" key:', err.message);
  }
}

// ---------------------- Tuning logic ----------------------

async function tuneTo(url) {
  if (!url) {
    throw new Error('No URL provided and DEFAULT_URL is empty');
  }

  console.log(`tuning to ${url}`);

  // No more closing browser on channel change – reuse the same page
  const p = await getPage();

  await p.bringToFront();

  await p.goto(url, {
    waitUntil: ['load', 'networkidle2'],
    timeout: 90_000,
  });

  // Fast fullscreen (F11)
  await ensureFullScreen(p);

  // PHILO: do NOT wait for .vjs-fullscreen-control; click live ASAP
  if (url.includes('philo.com')) {
    console.log('[tuneTo] URL contains philo.com (fast live click)');
    try {
      // small delay just to let UI paint
      await sleep(200);
      await p.mouse.move(0, 0);
      await p.mouse.move(1800, 540, { steps: 50 });
      await p.mouse.click(1800, 540, { button: 'left' });
      console.log('[tuneTo] Set Philo to Skip to Live');
    } catch (e) {
      console.log('[tuneTo] Error for philo.com:', e);
    }
  } else {
    // Non-philo sites still use the video.js fullscreen control
    await clickVideoJsFullscreen(p);
  }

  currentUrl = url;
  lastTuneAt = new Date().toISOString();

  console.log(`page is now at ${url}`);
}

// Periodic watchdog to keep Chrome alive-ish
setInterval(async () => {
  try {
    if (!browser) return;
    if (!page || page.isClosed()) {
      console.warn('[watchdog] page missing, recreating');
      page = await getPage();
    }
  } catch (err) {
    console.warn('[watchdog] error:', err.message);
  }
}, 30_000);

// -------------------- HTTP API --------------------

const app = express();
app.use(morgan('combined'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    upSince,
    currentUrl,
    lastTuneAt,
  });
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    currentUrl,
    lastTuneAt,
    presets: Object.keys(PRESETS),
    tsSources: Object.keys(TS_SOURCES),
  });
});

// Tune using ?url=...
app.get('/tune', async (req, res) => {
  const url = req.query.url || DEFAULT_URL;
  if (!url) {
    res.status(400).json({ ok: false, error: 'Missing url parameter' });
    return;
  }

  try {
    await tuneTo(String(url));
    res.json({ ok: true, url: String(url), lastTuneAt });
  } catch (err) {
    console.error('failed to tune:', err);
    res
      .status(500)
      .json({ ok: false, error: String(err.message || err || 'unknown') });
  }
});

// Tune using preset: /tune/msnbc -> CHAN_MSNBC
app.get('/tune/:name', async (req, res) => {
  const name = String(req.params.name || '').toLowerCase();
  const url = PRESETS[name];

  if (!url) {
    res.status(404).json({
      ok: false,
      error: `Unknown preset ${name}. Set CHAN_${name.toUpperCase()} in env.`,
    });
    return;
  }

  try {
    await tuneTo(url);
    res.json({ ok: true, name, url, lastTuneAt });
  } catch (err) {
    console.error('failed to tune preset:', err);
    res
      .status(500)
      .json({ ok: false, error: String(err.message || err || 'unknown') });
  }
});

// Basic reload endpoint
app.post('/reload', async (req, res) => {
  if (!page || page.isClosed()) {
    res.status(409).json({ ok: false, error: 'No active page' });
    return;
  }
  try {
    await page.reload({ waitUntil: ['load', 'networkidle2'] });
    lastTuneAt = new Date().toISOString();
    res.json({ ok: true, currentUrl, lastTuneAt });
  } catch (err) {
    console.error('failed to reload:', err);
    res
      .status(500)
      .json({ ok: false, error: String(err.message || err || 'unknown') });
  }
});

app.get('/stream/:name', async (req, res) => {
  const name = String(req.params.name || '').toLowerCase();
  const tsUrl = TS_SOURCES[name];
  const chanUrl = PRESETS[name];

  if (!tsUrl) {
    res.status(404).json({
      ok: false,
      error: `No TS source for ${name}. Set TS_${name.toUpperCase()}=http://192.168.0.168/0.ts in env.`,
    });
    return;
  }

  const delayMs = Number(process.env.TUNE_DELAY_MS || 0);

  // 1) Kick off Chrome tuning in the background (don't block the stream)
  if (chanUrl) {
    console.log(`[stream/${name}] async tuning to ${chanUrl}`);
    (async () => {
      try {
        await tuneTo(chanUrl);
        if (delayMs > 0) {
          console.log(
            `[stream/${name}] async waiting ${delayMs}ms for encoder to catch up`
          );
          await sleep(delayMs);
        }
        console.log(`[stream/${name}] async tune complete`);
      } catch (err) {
        console.error(`[stream/${name}] async tune failed:`, err);
      }
    })();
  } else {
    console.warn(
      `[stream/${name}] no CHAN_${name.toUpperCase()} set, skipping tune step`
    );
  }

  // 2) Proxy the TS from the hardware encoder (start immediately)
  console.log(`[stream/${name}] proxying TS from ${tsUrl}`);

  try {
    if (BLACKOUT_MS > 0) {
      console.log(`[stream/${name}] initial blackout ${BLACKOUT_MS}ms`);
      await sleep(BLACKOUT_MS);
    }

    const target = new URL(tsUrl);
    const client = target.protocol === 'https:' ? https : http;

    const upstreamReq = client.request(target, (upstreamRes) => {
      // Pass through status, but force TS content-type for Channels
      res.statusCode = upstreamRes.statusCode || 200;
      res.setHeader('Content-Type', 'video/mp2t');

      upstreamRes.on('error', (err) => {
        console.error(`[stream/${name}] upstream stream error:`, err);
        res.destroy(err);
      });

      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error(`[stream/${name}] upstream request error:`, err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end('upstream error');
      } else {
        res.destroy(err);
      }
    });

    upstreamReq.end();
  } catch (err) {
    console.error(`[stream/${name}] handler error:`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('proxy error');
    } else {
      res.destroy(err);
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`HDMI Encoder Remote listening on port ${PORT}`);
});
