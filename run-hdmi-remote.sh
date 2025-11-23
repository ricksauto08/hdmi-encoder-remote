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
export BLACKOUT_MS=2000   # 2 seconds
# How long to wait after tuning Chrome before proxying TS (ms)
export TUNE_DELAY_MS=0
# ============================
