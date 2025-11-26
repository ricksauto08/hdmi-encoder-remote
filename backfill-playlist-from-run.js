const fs = require('fs');
const path = require('path');

const RUN_SCRIPT_PATH = path.join(__dirname, 'run-hdmi-remote.sh');
const PLAYLIST_PATH = path.join(__dirname, 'hdmi-remote-playlist.m3u');

const DEFAULT_TS_URL = process.env.DEFAULT_TS_URL || 'http://192.168.0.168/0.ts';
const HDMI_IP = process.env.HDMI_BOX_IP || '192.168.0.115';
const PORT = Number(process.env.HDMI_REMOTE_PORT || 5589);

function ensureHeader(content) {
  content = content.trim();
  if (!content) return '#EXTM3U\n';
  if (!content.startsWith('#EXTM3U')) {
    return '#EXTM3U\n' + content + '\n';
  }
  return content + '\n';
}

try {
  const runContent = fs.readFileSync(RUN_SCRIPT_PATH, 'utf8');

  // Build a map of TS_XXX -> URL
  const tsMap = {};
  let m;

  const tsRegex = /^export\s+TS_([A-Z0-9_]+)="([^"]*)"/gm;
  while ((m = tsRegex.exec(runContent)) !== null) {
    tsMap[m[1]] = m[2] || DEFAULT_TS_URL;
  }

  let playlist = '';
  try {
    playlist = fs.readFileSync(PLAYLIST_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    playlist = '';
  }
  playlist = ensureHeader(playlist);

  const added = [];

  // Find all CHAN_XXX exports
  const chanRegex = /^export\s+CHAN_([A-Z0-9_]+)="([^"]*)"/gm;
  while ((m = chanRegex.exec(runContent)) !== null) {
    const upper = m[1];        // e.g. USA
    const lower = upper.toLowerCase(); // usa

    // Default chno = "1" (you can edit in Channels later)
    const chno = '1';

    const tsUrl = tsMap[upper] || DEFAULT_TS_URL;

    const snippet = `#EXTINF:-1 channel-id="${upper}" tvg-name="${upper}" tvg-chno="${chno}" group-title="HDMI",${upper}
http://${HDMI_IP}:${PORT}/stream/${lower}`;

    // Avoid duplicates: if we already have a /stream/lower entry, skip
    if (!playlist.includes(`/stream/${lower}`)) {
      playlist += '\n' + snippet + '\n';
      added.push({ name: upper, tsUrl });
    }
  }

  fs.writeFileSync(PLAYLIST_PATH, playlist.trim() + '\n', 'utf8');

  console.log('Backfill complete.');
  if (added.length === 0) {
    console.log('No new channels were added (they may already be in the playlist).');
  } else {
    console.log('Added channels:');
    for (const ch of added) {
      console.log(`  ${ch.name}`);
    }
  }
} catch (err) {
  console.error('Error while backfilling playlist:', err);
  process.exit(1);
}
