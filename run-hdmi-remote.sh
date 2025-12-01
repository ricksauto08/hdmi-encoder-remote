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

# Global timing defaults
export BLACKOUT_MS=4500   # 4.5 seconds
export TUNE_DELAY_MS=0

# --- Auto-managed channel exports (DO NOT EDIT BY HAND) ---
CHANNEL_ENV="$HOME/hdmi-encoder-remote/hdmi-channels.env"
if [ -f "$CHANNEL_ENV" ]; then
  . "$CHANNEL_ENV"
fi
# --- End auto-managed section ---

cd "$HOME/hdmi-encoder-remote"
node main.js
