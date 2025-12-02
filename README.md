# HDMI Encoder Remote

A small Node.js service that drives a **real Chrome browser** on a dedicated HDMI box and proxies an MPEG-TS stream from a hardware HDMI encoder.

Typical setup:

- Mini PC with HDMI out running Linux + Chrome
- HDMI output goes to a hardware encoder (like a cheap HDMI → RTSP/HTTP TS box)
- This service:
  - Receives `/tune/...` requests to open streaming sites (Philo, ABC, USA, etc.)
  - Clicks the right buttons to go fullscreen / jump to live / unmute
  - Proxies the encoder’s TS as `/stream/:name` for Channels DVR

On top of that, there’s a **Channel Helper Web UI** that:

- Writes channel presets into `hdmi-channels.env` (CHAN_*, TS_*)
- Auto-builds a master M3U playlist for Channels DVR
- Lets you import and renumber provider M3Us (e.g. TVE-Philo)
- Exposes per-source playlists from a `/playlists` folder

The same repo runs both:

- Natively on Linux (with or without systemd)
- Inside Docker, still driving a real Chrome window on the host’s HDMI output

---

## Features

### Core HDMI Remote (main.js)

- Launches Chrome in kiosk or fullscreen mode at a fixed resolution
- Preset channels via env vars like:
  - `CHAN_MSNBC`, `CHAN_ABC`, `CHAN_PARAMOUNT`, `CHAN_MSNOW`, etc.
- TS sources via env vars like:
  - `TS_MSNBC=http://encoder/0.ts`
- Special handling:
  - **Philo**
    - Waits for video to be ready
    - Sends fullscreen
    - Clicks “Jump to live” once at `(1800,540)`
    - Watchdog: if video stops, taps `(1800,540)` again (throttled)
  - **ABC**
    - Clicks center of player
    - Sends `m` (unmute) and `f` (player fullscreen)
    - Moves cursor to top-right so controls hide
  - **NBCU sites (USA / SYFY / E! / NBC)**
    - Center-click + `f` + move mouse away to hide bottom bar
    - Helpers for clicking specific tiles (e.g. SYFY, E! East)
  - **ms.now**
    - Special “no click” mode: lets the player load without auto-play clicks
- Simple HTTP API:
  - `/tune?url=...` – tune to an arbitrary URL
  - `/tune/:name` – tune by preset name, using `CHAN_<NAME>`
  - `/stream/:name` – TS proxy using `TS_<NAME>` and optional async tune via `CHAN_<NAME>`
  - `/health`, `/status` – basic health/status JSON

### Channel Helper Web UI (channel-helper-web.js)

- Runs on **port 8010**
- “Add Channel” form:
  - Short name, channel number, player URL, TS URL, HDMI IP, remote port
  - On submit:
    - Updates `hdmi-channels.env` with `export CHAN_...` + `TS_...`
    - Appends a new `#EXTINF` entry to **master HDMI playlist**:
      - `playlists/hdmi-remote-playlist.m3u`
- Import + renumber provider M3Us:
  - Fetch a Channels DVR M3U (e.g. `TVE-Philo`)
  - Adjust New Channel # per row
  - Writes clean per-source playlist to:
    - `playlists/<source-name>.m3u`
- Channel list view:
  - `/channels/<name>` → pretty table of channel numbers + logos
- Restart button:
  - “🔄 Restart HDMI Remote”
  - On bare-metal systemd: `systemctl restart hdmi-encoder-remote.service`
  - In Docker / no systemd: no-op (but responds OK)

---

## Requirements

On the HDMI box (Linux):

- **Node.js** (LTS, e.g. 18+ or 20+)
- **npm**
- **Google Chrome** or Chromium
  - On Debian/Ubuntu, something like:
    ```bash
    sudo apt install google-chrome-stable
    # or:
    sudo apt install chromium
    ```
- A **hardware HDMI encoder** that exposes MPEG-TS over HTTP, e.g.:
  ```text
  http://192.168.0.168/0.ts

