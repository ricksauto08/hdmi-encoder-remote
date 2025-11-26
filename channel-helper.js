const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Defaults you can tweak here ---
const RUN_SCRIPT_PATH = path.join(__dirname, 'run-hdmi-remote.sh');

// These are just defaults; you can override inside the prompts if you want
const DEFAULT_TS_URL = process.env.DEFAULT_TS_URL || 'http://192.168.0.168/0.ts';
const DEFAULT_HDMI_IP = process.env.HDMI_BOX_IP || '192.168.0.115';
const DEFAULT_PORT = Number(process.env.HDMI_REMOTE_PORT || 5589);

// ---------------- helpers ----------------

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

(async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('=== HDMI Encoder Remote - Channel Helper ===');

    const nameRaw = await ask(rl, 'Short channel name (e.g. MSNOW): ');
    if (!nameRaw) {
      console.error('Channel name is required.');
      rl.close();
      process.exit(1);
    }

    const url = await ask(
      rl,
      'Channel URL (e.g. https://www.philo.com/player/player/channel/...): '
    );
    if (!url) {
      console.error('Channel URL is required.');
      rl.close();
      process.exit(1);
    }

    const chnoRaw = await ask(
      rl,
      'Channel number for Channels (e.g. 23): '
    );
    const chno = chnoRaw || '1';

    const tsUrlRaw = await ask(
      rl,
      `TS URL from HDMI encoder [${DEFAULT_TS_URL}]: `
    );
    const tsUrl = tsUrlRaw || DEFAULT_TS_URL;

    const hdmiIpRaw = await ask(
      rl,
      `HDMI box IP for M3U [${DEFAULT_HDMI_IP}]: `
    );
    const hdmiIp = hdmiIpRaw || DEFAULT_HDMI_IP;

    const portRaw = await ask(
      rl,
      `HDMI remote port for M3U [${DEFAULT_PORT}]: `
    );
    const port = portRaw ? Number(portRaw) : DEFAULT_PORT;

    const upperName = nameRaw.toUpperCase();
    const lowerName = nameRaw.toLowerCase();

    // ---------------- build exports ----------------
    const chanLine = `export CHAN_${upperName}="${url}"`;
    const tsLine = `export TS_${upperName}="${tsUrl}"`;

    const block =
      '\n# Added by channel-helper on ' +
      new Date().toISOString() +
      '\n' +
      chanLine +
      '\n' +
      tsLine +
      '\n';

    // Append to run-hdmi-remote.sh
    try {
      fs.appendFileSync(RUN_SCRIPT_PATH, block, { encoding: 'utf8' });
      console.log(
        `\n[OK] Appended to ${RUN_SCRIPT_PATH}:\n${chanLine}\n${tsLine}\n`
      );
    } catch (err) {
      console.error(
        `\n[ERROR] Could not append to ${RUN_SCRIPT_PATH}:`,
        err.message
      );
    }

    // ---------------- build M3U snippet ----------------
    const m3uSnippet = `#EXTINF:-1 channel-id="${upperName}" tvg-name="${upperName}" tvg-chno="${chno}" group-title="HDMI",${upperName}
http://${hdmiIp}:${port}/stream/${lowerName}`;

    console.log('M3U entry for Channels (copy/paste this):\n');
    console.log(m3uSnippet + '\n');
  } catch (err) {
    console.error('Unexpected error:', err);
  } finally {
    rl.close();
  }
})();
