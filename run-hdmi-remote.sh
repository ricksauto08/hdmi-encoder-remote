#!/usr/bin/env bash
set -e

# Use the HDMI/X display
export DISPLAY=:0

# Keep screen awake (no DPMS, no blank)
xset s off -dpms s noblank || true

# Make Chrome fill the screen
export FULLSCREEN=1
export KIOSK=1

# Default homepage (optional – used if /tune has no ?url=)
export DEFAULT_URL="https://www.wikipedia.org"

# ===== Channel presets =====
# Replace these example URLs with your REAL channel URLs
# For example: Philo MSNBC, CNN, etc.

export CHAN_MSNOW="https://www.ms.now/live"
export CHAN_PARAMOUNT="https://www.philo.com/player/player/channel/Q2hhbm5lbDo2MDg1NDg4OTk2NDg0Mzg0ODQ"
export CHAN_CC="https://www.philo.com/player/player/channel/Q2hhbm5lbDo2MDg1NDg4OTk2NDg0Mzg0OTk"
export CHAN_ABC="https://abc.com/watch-live/b2f23a6e-a2a4-4d63-bd3b-e330921b0942"
# TS streams coming from the HDMI encoder (raw MPEG-TS URLs)
# MSNOW comes from your encoder at /0.ts
export TS_MSNOW="http://192.168.0.168/0.ts"
export TS_PARAMOUNT="http://192.168.0.168/0.ts"
export TS_CC="http://192.168.0.168/0.ts"
export TS_ABC="http://192.168.0.168/0.ts"
# Optional: add more later if you know them, example:
# export TS_MSNBC="http://192.168.0.168/1.ts"
export BLACKOUT_MS=4500   # 4.5 seconds (original 2 seconds)
# How long to wait after tuning Chrome before proxying TS (ms)
export TUNE_DELAY_MS=0
# ============================

# Added by channel-helper on 2025-11-24T14:00:36.246Z
export CHAN_MTV="https://www.philo.com/player/player/channel/Q2hhbm5lbDo2MDg1NDg4OTk2NDg0Mzg2MDY"
export TS_MTV="http://192.168.0.168/0.ts"

# Added by channel-helper on 2025-11-24T17:08:31.764Z
export CHAN_MTVLIVE="https://www.philo.com/player/player/channel/Q2hhbm5lbDo2MDg1NDg4OTk2NDg0Mzg4NTU"
export TS_MTVLIVE="http://192.168.0.168/0.ts"

# Added by channel-helper-web on 2025-11-26T02:29:51.734Z
export CHAN_USA="https://www.usanetwork.com/live"
export TS_USA="http://192.168.0.168/0.ts"

# Added by channel-helper-web on 2025-11-26T15:15:01.574Z
export CHAN_USA="https://www.usanetwork.com/live"
export TS_USA="http://192.168.0.168/0.ts"

cd "$HOME/hdmi-encoder-remote"
node main.js
