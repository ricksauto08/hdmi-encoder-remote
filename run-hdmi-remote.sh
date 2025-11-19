#!/usr/bin/env bash
set -e

# Use the HDMI/X display
export DISPLAY=:0

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

# TS streams coming from the HDMI encoder (raw MPEG-TS URLs)
# MSNOW comes from your encoder at /0.ts
export TS_MSNOW="http://192.168.0.168/0.ts"
export TS_PARAMOUNT="http://192.168.0.168/0.ts"
# Optional: add more later if you know them, example:
# export TS_MSNBC="http://192.168.0.168/1.ts"

# How long to wait after tuning Chrome before proxying TS (ms)
export TUNE_DELAY_MS=5000
# ============================

cd "$HOME/hdmi-encoder-remote"
node main.js
