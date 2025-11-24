# HDMI Encoder Remote

A small Node.js service that drives a **real Chrome browser** on a dedicated HDMI box and proxies an MPEG-TS stream from a hardware HDMI encoder.

Typical setup:

- Mini PC with HDMI out running Linux + Chrome
- HDMI output goes to a hardware encoder (like a cheap HDMI → RTSP/HTTP TS box)
- This service:
  - Receives `/tune/...` requests to open streaming sites (Philo, ABC, etc.)
  - Clicks the right buttons to go full screen / jump to live
  - Proxies the encoder’s TS as `/stream/:name` for Channels DVR

---

## Features

- Launches Chrome in kiosk or fullscreen mode at a fixed resolution
- Preset channels via env vars like `CHAN_ABC`, `CHAN_PARAMOUNT`
- TS sources via env vars like `TS_ABC=http://encoder/0.ts`
- Special handling:
  - **Philo**
    - Waits for video to be ready
    - Sends fullscreen
    - Clicks “Jump to live” at `(1800,540)` once
    - Watchdog: if video stops, taps `(1800,540)` again (throttled)
  - **ABC**
    - Clicks center of player
    - Sends `f` (fullscreen) and `m` (unmute)
    - Moves cursor to top-right so controls hide
- Simple HTTP API:
  - `/tune?url=...`
  - `/tune/:name`
  - `/stream/:name`
  - `/health`, `/status`

---

## Requirements

On the HDMI box (Linux):

- **Node.js** (LTS, e.g. 18+)
- **npm**
- **Google Chrome** or Chromium
  - On Debian/Ubuntu, something like:  
    `sudo apt install google-chrome-stable` *or* `sudo apt install chromium`
- A **hardware HDMI encoder** that exposes MPEG-TS over HTTP, e.g.:  
  `http://192.168.0.168/0.ts`

This project uses:

- `puppeteer-core`
- `express`
- `morgan`
- `console-stamp`

These get installed via `npm install`.

---

## Installation

```bash
# Clone this branch
git clone -b ts-proxy --single-branch https://github.com/ricksauto08/hdmi-encoder-remote.git
cd hdmi-encoder-remote

# Install Node dependencies
npm install
