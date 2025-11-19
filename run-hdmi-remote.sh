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

# ============================

cd "$HOME/hdmi-encoder-remote"
node main.js
