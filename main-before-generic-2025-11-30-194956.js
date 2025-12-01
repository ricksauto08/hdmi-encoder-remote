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

function canonicalName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // "e!" -> "e"
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

// Pull presets from env like CHAN_MSNBC, CHAN_ABC, CHAN_E, etc.
const PRESETS = {};
const TS_SOURCES = {};

for (const [key, value] of Object.entries(process.env)) {
  if (!value) continue;

  if (key.startsWith('CHAN_')) {
    const raw = key.slice(5); // after CHAN_
    const name = canonicalName(raw); // CHAN_E! -> "e"
    if (name) {
      PRESETS[name] = value;
    }
  } else if (key.startsWith('TS_')) {
    const raw = key.slice(3); // after TS_
    const name = canonicalName(raw);
    if (name) {
      TS_SOURCES[name] = value;
    }
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
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
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

// For Philo "kick" cooldown
let lastPhiloKickAt = 0;

// Simple sleep helper
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
      ...process.env,
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

// ------------------ Generic fullscreen helper ------------------

async function forceFullscreen(page, streamId) {
  try {
    const url = page.url();
    console.log(
      `[fullscreen] trying to go fullscreen for ${streamId} on ${url}`
    );

    const selectorCandidates = [
      '.vjs-fullscreen-control',
      'button.vjs-fullscreen-control',
      'button[title="Fullscreen"]',
      'button[aria-label*="Full screen" i]',
      'button[aria-label*="Fullscreen" i]',
      'button[aria-label*="Full Screen" i]',
    ];

    for (const sel of selectorCandidates) {
      try {
        const btn = await page.waitForSelector(sel, {
          timeout: 5000,
          visible: true,
        });
        if (btn) {

          await btn.click();
          console.log(`[fullscreen] clicked ${sel} for ${streamId}`);
          return;
        }
      } catch {
        // try next selector
      }
    }

    try {
      await page.keyboard.press('f');
      console.log(`[fullscreen] pressed "f" key for ${streamId}`);
    } catch (err) {
      console.warn(
        `[fullscreen] could not press "f" for ${streamId}: ${err.message}`
      );
    }

    try {
      const ok = await page.evaluate(() => {
        const vid = document.querySelector('video');
        if (vid && vid.requestFullscreen) {
          vid.requestFullscreen();
          return true;
        }
        return false;
      });
      if (ok) {
        console.log(
          `[fullscreen] called video.requestFullscreen() for ${streamId}`
        );
      } else {
        console.log(
          `[fullscreen] no <video> element or requestFullscreen not available for ${streamId}`
        );
      }
    } catch (err) {
      console.warn(
        `[fullscreen] error while trying video.requestFullscreen() for ${streamId}: ${err.message}`
      );
    }
  } catch (err) {
    console.warn(
      `[fullscreen] could not force fullscreen for ${streamId}: ${err.message}`
    );
  }
}

// ----------------- Philo helper -----------------
// Wait for video to be ready, THEN fullscreen, THEN one click at 1800,540
async function ensurePhiloLive(p) {
  console.log(
    '[philo] ensurePhiloLive: wait for video, fullscreen, ONE click at 1800,540'
  );

  try {
    await p.bringToFront();

    const timeoutMs = 2000;
    const start = Date.now();
    let videoReady = false;

    while (Date.now() - start < timeoutMs) {
      videoReady = await p.evaluate(() => {
        const vids = Array.from(document.querySelectorAll('video'));
        return vids.some((v) => v.readyState >= 2);
      });

      if (videoReady) break;
      await sleep(900);
    }

    if (videoReady) {
      console.log('[philo] video element reported readyState >= 2');
    } else {
      console.log(
        '[philo] timeout waiting for video; continuing with fullscreen + click anyway'
      );
    }

    await ensureFullScreen(p);

    await sleep(500);

    const jumpX = 1800;
    const jumpY = 540;

    await p.mouse.move(jumpX, jumpY, { steps: 40 });
    await p.mouse.click(jumpX, jumpY, { button: 'left' });

    console.log(`[philo] clicked once at ${jumpX},${jumpY}`);
  } catch (err) {
    console.warn('[philo] ensurePhiloLive error:', err.message);
  }
}

// If we're on Philo and no video is currently playing, click (1800, 540) again
async function ensurePhiloStillPlaying(p) {
  try {
    if (!currentUrl || !currentUrl.toLowerCase().includes('philo.com')) {
      return;
    }

    const now = Date.now();
    if (now - lastPhiloKickAt < 1000) {
      return;
    }

    const needClick = await p.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      if (!vids.length) return false;

      const anyPlaying = vids.some(
        (v) => !v.paused && !v.ended && v.readyState >= 2
      );
      return !anyPlaying;
    });

    if (!needClick) {
      return;
    }

    lastPhiloKickAt = now;

    const jumpX = 1800;
    const jumpY = 540;

    await p.bringToFront();
    await p.mouse.move(jumpX, jumpY, { steps: 15 });
    await p.mouse.click(jumpX, jumpY, { button: 'left' });

    console.log(
      `[philo] video appears stopped/paused; clicked ${jumpX},${jumpY} to kick it`
    );
  } catch (err) {
    console.warn('[philo] ensurePhiloStillPlaying error:', err.message);
  }
}

// ----------------- ABC helper -----------------
// ABC: wait ~4s, click center, send "m" then "f", move mouse to top-right
async function ensureAbcCenterFullscreenUnmuted(p) {
  console.log('[abc] simple helper: wait 4s, center click, "m", "f", move mouse');

  try {
    await p.bringToFront();

    // Give ABC time to finish its initial ad / layout
    await sleep(50); //@@@@@@@@@@@@@@@@@@@@@@@@@ was 4s @@@@@@@@@@@@@@@@@@@@

    const centerX = VIDEO_WIDTH / 2;
    const centerY = VIDEO_HEIGHT / 2;
    await p.mouse.move(centerX, centerY, { steps: 25 });
    await p.mouse.click(centerX, centerY, { button: 'left' });
    console.log(`[abc] clicked center at ${centerX},${centerY}`);

    // Small gap, then mute toggle
    await sleep(100);
    await p.keyboard.press('m');
    console.log('[abc] sent "m" key to toggle mute');

    // Short wait, then fullscreen key
    await sleep(500);
    await p.keyboard.press('f');
    console.log('[abc] sent "f" key for player fullscreen');

    // Move mouse to top-right to let controls hide
    const topRightX = VIDEO_WIDTH - 10;
    const topRightY = 10;
    await p.mouse.move(topRightX, topRightY, { steps: 20 });
    console.log(
      `[abc] moved mouse to top-right at ${topRightX},${topRightY}`
    );
  } catch (err) {
    console.warn('[abc] ensureAbcCenterFullscreenUnmuted error:', err.message);
  }
}

// ----------------- Generic helper (FAST + play button) -----------------
// Make sure at least one <video> is actually playing.
// Tries center click AND common Video.js / "Play" buttons.
async function ensureGenericVideoPlaying(p, siteLabel) {
  console.log(
    '[generic] (FAST+PLAY) ensure video playing for',
    siteLabel || '(unknown)'
  );

  try {
    await p.bringToFront();

    const timeoutMs = 7000; // a little more time for stubborn players
    const start = Date.now();
    let clickedCenter = false;
    let clickedPlayButton = false;

    while (Date.now() - start < timeoutMs) {
      // Check current video state
      const state = await p.evaluate(() => {
        const vids = Array.from(document.querySelectorAll('video'));
        if (!vids.length) {
          return { hasVideo: false, anyPlaying: false };
        }
        const anyPlaying = vids.some(
          (v) => !v.paused && !v.ended && v.readyState >= 2
        );
        return { hasVideo: true, anyPlaying };
      });

      if (state.hasVideo && state.anyPlaying) {
        console.log('[generic] video appears to be playing');
        return;
      }

      // Try clicking a "Play" button once (Video.js / generic)
      if (!clickedPlayButton) {
        const playSel = await p.evaluate(() => {
          const selectors = [
            '.vjs-play-control.vjs-paused',
            '.vjs-big-play-button',
            'button[aria-label*="Play" i]',
            'button[title*="Play" i]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el instanceof HTMLElement) {
              el.click();
              return sel;
            }
          }
          return '';
        });

        if (playSel) {
          console.log(
            `[generic] clicked play button using selector "${playSel}"`
          );
          clickedPlayButton = true;
          await sleep(500); // give it half a second to react
        }
      }

      // Fallback: one center click if we see <video> but nothing's moving
      if (state.hasVideo && !clickedCenter) {
        const centerX = VIDEO_WIDTH / 2;
        const centerY = VIDEO_HEIGHT / 2;
        await p.mouse.move(centerX, centerY, { steps: 18 });
        await p.mouse.click(centerX, centerY, { button: 'left' });
        console.log(
          `[generic] no playback yet; clicked center at ${centerX},${centerY}`
        );
        clickedCenter = true;
      }

      await sleep(400);
    }

    console.warn('[generic] (FAST+PLAY) timeout waiting for video to start playing');
  } catch (err) {
    console.warn(
      '[generic] ensureGenericVideoPlaying (FAST+PLAY) error:',
      err.message
    );
  }
}

// ----------------- NBCU player helper (USA / SYFY / E!) -----------------
// Click center, press "f" for player fullscreen, then move mouse away
async function ensureNbcPlayerFullscreenAndHideBar(p) {
  console.log('[nbc] center click + f + move pointer to top-right');

  try {
    await p.bringToFront();

    await sleep(500);

    const centerX = VIDEO_WIDTH / 2;
    const centerY = VIDEO_HEIGHT / 2;
    await p.mouse.move(centerX, centerY, { steps: 25 });
    await p.mouse.click(centerX, centerY, { button: 'left' });
    console.log(`[nbc] clicked center at ${centerX},${centerY}`);

    await sleep(250);
    await p.keyboard.press('f');
    console.log('[nbc] sent "f" for player fullscreen');

    const topRightX = VIDEO_WIDTH - 10;
    const topRightY = 10;
    await sleep(250);
    await p.mouse.move(topRightX, topRightY, { steps: 25 });
    console.log(
      `[nbc] moved mouse to top-right at ${topRightX},${topRightY}`
    );
  } catch (err) {
    console.warn(
      '[nbc] ensureNbcPlayerFullscreenAndHideBar error:',
      err.message
    );
  }
}

// ----------------- SYFY / NBCU tile helper -----------------

async function clickSyfyTile(p) {
  try {
    console.log('[syfy] trying to click EPG tile for SYFY');

    await p.waitForSelector(
      '.epg-tile-container.selectable .tile-info[aria-label]',
      { timeout: 15000 }
    );

    const clicked = await p.evaluate(() => {
      const target = 'SYFY';
      const tiles = Array.from(
        document.querySelectorAll('.epg-tile-container.selectable')
      );

      for (const tile of tiles) {
        const info = tile.querySelector('.tile-info[aria-label]');
        if (!info) continue;

        const aria = (info.getAttribute('aria-label') || '').toUpperCase();
        if (aria.includes(target)) {
          const clickable =
            tile.closest('button, a, [role="button"]') || tile || info;
          if (clickable && clickable instanceof HTMLElement) {
            clickable.click();
            return true;
          }
        }
      }

      return false;
    });

    if (clicked) {
      console.log('[syfy] clicked EPG tile for SYFY');
    } else {
      console.warn('[syfy] no matching SYFY tile found');
    }
  } catch (err) {
    console.warn('[syfy] error while trying to click SYFY tile:', err.message);
  }
}

// ----------------- E! East tile helper on USA Network -----------------

async function clickE_EastTile(p) {
  try {
    console.log('[e] trying to click E!-East tile on NBCU grid');

    await p.waitForSelector('div.tile-info[aria-label]', {
      timeout: 15000,
    });

    const clicked = await p.evaluate(() => {
      const tiles = Array.from(
        document.querySelectorAll('div.tile-info[aria-label]')
      );

      console.log(
        '[e] sample aria-labels:',
        tiles.slice(0, 5).map((el) => el.getAttribute('aria-label') || '')
      );

      const target = tiles.find((el) => {
        const label = (el.getAttribute('aria-label') || '').toUpperCase();
        return label.includes('E!-EAST');
      });

      if (!target) {
        return false;
      }

      const clickable =
        target.closest('button, a, [role="button"]') || target;

      if (!clickable) return false;

      clickable.scrollIntoView({ block: 'center', inline: 'center' });

      const evt = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      clickable.dispatchEvent(evt);

      if (typeof clickable.click === 'function') {
        clickable.click();
      }

      return true;
    });

    if (clicked) {
      console.log('[e] clicked E!-East tile');
    } else {
      console.warn('[e] could not find E!-East tile by aria-label');
    }
  } catch (err) {
    console.warn('[e] clickE_EastTile error:', err.message);
  }
}

// ----------------- Site-specific post-navigate hook -----------------

async function postNavigateForChannel(p, logicalName, url) {
  try {
    if (!logicalName) return;

    const host = new URL(url).hostname.toLowerCase();
    const name = canonicalName(logicalName); // "e!" -> "e"

    if (host.includes('usanetwork.com')) {
      if (name === 'syfy') {
        console.log('[epg] post-navigate hook for SYFY on usanetwork.com');
        await sleep(3000);
        await clickSyfyTile(p);
        await sleep(1000);
      } else if (name === 'e') {
        console.log('[epg] post-navigate hook for E! East on usanetwork.com');
        await sleep(1000);
        await clickE_EastTile(p);
        await sleep(1000);
      }
    }
  } catch (err) {
    console.warn('[epg] postNavigateForChannel error:', err.message);
  }
}

// ---------------------- Tuning logic ----------------------

async function tuneTo(url, logicalNameRaw) {
  if (!url) {
    throw new Error('No URL provided and DEFAULT_URL is empty');
  }

  console.log(`tuning to ${url}`);
  const lowerUrl = url.toLowerCase();
  const shortName = logicalNameRaw ? canonicalName(logicalNameRaw) : null;

  const p = await getPage();

  await p.bringToFront();

  await p.goto(url, {
    waitUntil: ['load', 'networkidle2'],
    timeout: 90_000,
  });

  await postNavigateForChannel(p, shortName, url);

  if (lowerUrl.includes('philo.com')) {
    console.log(
      '[tuneTo] URL contains philo.com (wait video -> fullscreen -> one click)'
    );
    await ensurePhiloLive(p);
  } else {
    await ensureFullScreen(p);

    if (
      lowerUrl.includes('abc.com') ||
      lowerUrl.includes('abc.go.com') ||
      lowerUrl.includes('abc7ny.com')
    ) {
      console.log(
        '[tuneTo] URL looks like ABC (center click + m + f)'
      );
      await ensureAbcCenterFullscreenUnmuted(p);
    } else if (
      lowerUrl.includes('usanetwork.com') ||
      lowerUrl.includes('syfy.com') ||
      lowerUrl.includes('nbc.com')
    ) {
      console.log(
        '[tuneTo] URL looks like NBCU (center + f + hide bottom bar)'
      );
      await ensureNbcPlayerFullscreenAndHideBar(p);
    } else {
      await forceFullscreen(p, shortName || lowerUrl);
    }

    await ensureGenericVideoPlaying(p, shortName || lowerUrl);
  }

  currentUrl = url;
  lastTuneAt = new Date().toISOString();

  console.log(`page is now at ${url}`);
}

// Periodic watchdog
setInterval(async () => {
  try {
    if (!browser) return;

    if (!page || page.isClosed()) {
      console.warn('[watchdog] page missing, recreating');
      page = await getPage();
      return;
    }

    if (currentUrl && currentUrl.toLowerCase().includes('philo.com')) {
      await ensurePhiloStillPlaying(page);
    }
  } catch (err) {
    console.warn('[watchdog] error:', err.message);
  }
}, 10_000);

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
    await tuneTo(String(url), null);
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
  const rawName = String(req.params.name || '');
  const name = canonicalName(rawName);
  const url = PRESETS[name];

  if (!url) {
    res.status(404).json({
      ok: false,
      error: `Unknown preset ${rawName}. Set CHAN_${rawName.toUpperCase()} in env.`,
    });
    return;
  }

  try {
    await tuneTo(url, name);
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
  const rawName = String(req.params.name || '');
  const name = canonicalName(rawName);
  const tsUrl = TS_SOURCES[name];
  const chanUrl = PRESETS[name];

  if (!tsUrl) {
    res.status(404).json({
      ok: false,
      error: `No TS source for ${rawName}. Set TS_${rawName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')}=http://192.168.0.168/0.ts in env.`,
    });
    return;
  }

  const delayMs = Number(process.env.TUNE_DELAY_MS || 0);

  if (chanUrl) {
    console.log(`[stream/${rawName}] async tuning to ${chanUrl}`);
    (async () => {
      try {
        await tuneTo(chanUrl, name);
        if (delayMs > 0) {
          console.log(
            `[stream/${rawName}] async waiting ${delayMs}ms for encoder to catch up`
          );
          await sleep(delayMs);
        }
        console.log(`[stream/${rawName}] async tune complete`);
      } catch (err) {
        console.error(`[stream/${rawName}] async tune failed:`, err);
      }
    })();
  } else {
    console.warn(
      `[stream/${rawName}] no CHAN_${rawName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')} set, skipping tune step`
    );
  }

  console.log(`[stream/${rawName}] proxying TS from ${tsUrl}`);

  try {
    if (BLACKOUT_MS > 0) {
      console.log(`[stream/${rawName}] initial blackout ${BLACKOUT_MS}ms`);
      await sleep(BLACKOUT_MS);
    }

    const target = new URL(tsUrl);
    const client = target.protocol === 'https:' ? https : http;

    const upstreamReq = client.request(target, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode || 200;
      res.setHeader('Content-Type', 'video/mp2t');

      upstreamRes.on('error', (err) => {
        console.error(`[stream/${rawName}] upstream stream error:`, err);
        res.destroy(err);
      });

      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error(`[stream/${rawName}] upstream request error:`, err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end('upstream error');
      } else {
        res.destroy(err);
      }
    });

    upstreamReq.end();
  } catch (err) {
    console.error(`[stream/${rawName}] handler error:`, err);
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
