const fs = require('fs');
const path = require('path');

const PLAYLIST_PATH = path.join(__dirname, 'hdmi-remote-playlist.m3u');

// EDIT THESE to the channel numbers you want in Channels DVR
const channelNumbers = {
  MSNOW: '23',      // change this
  PARAMOUNT: '41',  // change this
  CC: '50',         // change this
  ABC: '707',        // change this
  MTV: '53',        // change this
  MTVLIVE: '55',    // change this
};

try {
  let content = fs.readFileSync(PLAYLIST_PATH, 'utf8');

  for (const [name, chno] of Object.entries(channelNumbers)) {
    if (!chno) continue;

    // Match the #EXTINF line for this channel-id and replace tvg-chno="..."
    const re = new RegExp(
      '(#EXTINF:-1[^\\n]*channel-id="' +
        name +
        '"[^\\n]*tvg-chno=")([^"]*)',
      'g'
    );

    const before = content;
    content = content.replace(re, `$1${chno}`);

    if (before !== content) {
      console.log(`Updated tvg-chno for ${name} to ${chno}`);
    } else {
      console.log(`No #EXTINF line found for ${name} (skipped)`);
    }
  }

  fs.writeFileSync(PLAYLIST_PATH, content, 'utf8');
  console.log('Done updating playlist.');
} catch (err) {
  console.error('Error updating playlist:', err);
  process.exit(1);
}
