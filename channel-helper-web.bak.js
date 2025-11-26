const fs = require('fs');
const path = require('path');
const express = require('express');

// --- Defaults you can tweak here ---
const RUN_SCRIPT_PATH = path.join(__dirname, 'run-hdmi-remote.sh');

// Same defaults as your CLI script
const DEFAULT_TS_URL = process.env.DEFAULT_TS_URL || 'http://192.168.0.168/0.ts';
const DEFAULT_HDMI_IP = process.env.HDMI_BOX_IP || '192.168.0.115';
const DEFAULT_PORT = Number(process.env.HDMI_REMOTE_PORT || 5589);

// ---------------- helpers ----------------

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage({ defaults, result, error }) {
  const {
    name = '',
    url = '',
    chno = '',
    tsUrl = DEFAULT_TS_URL,
    hdmiIp = DEFAULT_HDMI_IP,
    port = DEFAULT_PORT,
  } = defaults || {};

  const snippet = result?.m3uSnippet || '';
  const infoLines = result?.infoLines || [];
  const errorMsg = error || '';

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>HDMI Encoder Channel Helper</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      margin: 0;
      padding: 0;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #020617;
      border-radius: 16px;
      padding: 24px 28px;
      max-width: 720px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      border: 1px solid #1f2937;
    }
    h1 {
      margin-top: 0;
      margin-bottom: 4px;
      font-size: 1.4rem;
      color: #f9fafb;
    }
    .subtitle {
      font-size: 0.9rem;
      color: #9ca3af;
      margin-bottom: 18px;
    }
    form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
    }
    .full-row {
      grid-column: 1 / -1;
    }
    label {
      display: block;
      font-size: 0.8rem;
      color: #9ca3af;
      margin-bottom: 4px;
    }
    input[type="text"],
    input[type="number"],
    input[type="url"] {
      width: 100%;
      padding: 7px 9px;
      border-radius: 8px;
      border: 1px solid #374151;
      background: #020617;
      color: #e5e7eb;
      font-size: 0.9rem;
      box-sizing: border-box;
    }
    input::placeholder {
      color: #6b7280;
    }
    input:focus {
      outline: none;
      border-color: #22c55e;
      box-shadow: 0 0 0 1px #22c55e33;
    }
    .button-row {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
    }
    button {
      background: #22c55e;
      border: none;
      border-radius: 999px;
      color: #022c22;
      font-weight: 600;
      padding: 8px 18px;
      font-size: 0.9rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover {
      background: #16a34a;
    }
    button span.icon {
      font-size: 1.1rem;
    }
    .result, .error {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 0.85rem;
    }
    .result {
      background: #022c22;
      border: 1px solid #16a34a;
    }
    .error {
      background: #450a0a;
      border: 1px solid #b91c1c;
      color: #fecaca;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      margin-top: 8px;
      background: #020617;
      color: #e5e7eb;
      border-radius: 8px;
      border: 1px solid #374151;
      font-family: monospace;
      font-size: 0.8rem;
      padding: 8px;
      resize: vertical;
      min-height: 70px;
    }
    .info-list {
      margin: 0;
      padding-left: 18px;
      margin-top: 4px;
      color: #bbf7d0;
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>HDMI Encoder Remote – Channel Helper</h1>
    <div class="subtitle">
      Fill this out to append exports to <code>run-hdmi-remote.sh</code> and get a ready-to-paste M3U entry for Channels.
    </div>

    <form method="POST" action="/create">
      <div>
        <label>Short channel name (e.g. MSNOW)</label>
        <input type="text" name="name" required
               value="${escapeHtml(name)}"
               placeholder="MSNOW" />
      </div>

      <div>
        <label>Channel number (for Channels DVR)</label>
        <input type="text" name="chno"
               value="${escapeHtml(chno || '')}"
               placeholder="23" />
      </div>

      <div class="full-row">
        <label>Channel URL (Philo/whatever player URL)</label>
        <input type="url" name="url" required
               value="${escapeHtml(url)}"
               placeholder="https://www.philo.com/player/player/channel/..." />
      </div>

      <div>
        <label>TS URL from HDMI encoder</label>
        <input type="text" name="tsUrl"
               value="${escapeHtml(tsUrl)}"
               placeholder="${escapeHtml(DEFAULT_TS_URL)}" />
      </div>

      <div>
        <label>HDMI box IP (for M3U)</label>
        <input type="text" name="hdmiIp"
               value="${escapeHtml(hdmiIp)}"
               placeholder="${escapeHtml(DEFAULT_HDMI_IP)}" />
      </div>

      <div>
        <label>HDMI remote port (for M3U)</label>
        <input type="number" name="port"
               value="${escapeHtml(port)}"
               placeholder="${escapeHtml(String(DEFAULT_PORT))}" />
      </div>

      <div class="button-row">
        <button type="submit">
          <span class="icon">➕</span>
          Add Channel
        </button>
      </div>
    </form>

    ${errorMsg
      ? `<div class="error">${escapeHtml(errorMsg)}</div>`
      : ''}

    ${snippet
      ? `<div class="result">
          <div><strong>Appended to run-hdmi-remote.sh:</strong></div>
          <ul class="info-list">
            ${infoLines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}
          </ul>
          <div style="margin-top:8px;"><strong>M3U entry for Channels DVR:</strong></div>
          <textarea readonly>${escapeHtml(snippet)}</textarea>
        </div>`
      : ''}
  </div>
</body>
</html>
`;
}

// ---------------- app ----------------

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(
    renderPage({
      defaults: {},
      result: null,
      error: null,
    })
  );
});

app.post('/create', (req, res) => {
  const nameRaw = (req.body.name || '').trim();
  const url = (req.body.url || '').trim();
  const chnoRaw = (req.body.chno || '').trim();
  const tsUrlRaw = (req.body.tsUrl || '').trim();
  const hdmiIpRaw = (req.body.hdmiIp || '').trim();
  const portRaw = (req.body.port || '').trim();

  const defaults = {
    name: nameRaw,
    url,
    chno: chnoRaw,
    tsUrl: tsUrlRaw || DEFAULT_TS_URL,
    hdmiIp: hdmiIpRaw || DEFAULT_HDMI_IP,
    port: portRaw || DEFAULT_PORT,
  };

  if (!nameRaw) {
    return res.send(
      renderPage({
        defaults,
        result: null,
        error: 'Channel name is required.',
      })
    );
  }

  if (!url) {
    return res.send(
      renderPage({
        defaults,
        result: null,
        error: 'Channel URL is required.',
      })
    );
  }

  const chno = chnoRaw || '1';
  const tsUrl = tsUrlRaw || DEFAULT_TS_URL;
  const hdmiIp = hdmiIpRaw || DEFAULT_HDMI_IP;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;

  const upperName = nameRaw.toUpperCase();
  const lowerName = nameRaw.toLowerCase();

  const chanLine = `export CHAN_${upperName}="${url}"`;
  const tsLine = `export TS_${upperName}="${tsUrl}"`;

  const block =
    '\n# Added by channel-helper-web on ' +
    new Date().toISOString() +
    '\n' +
    chanLine +
    '\n' +
    tsLine +
    '\n';

  let error = null;
  const infoLines = [];

  try {
    // Read existing script (if it exists)
    let existing = '';
    try {
      existing = fs.readFileSync(RUN_SCRIPT_PATH, 'utf8');
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') {
        throw readErr; // real error
      }
      existing = ''; // new file
    }

    const lines = existing.split(/\r?\n/);
    const kept = [];
    const launchLines = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Keep empty lines as-is
      if (!trimmed) {
        kept.push(line);
        continue;
      }

      const isCd =
        trimmed.includes('cd') && trimmed.includes('hdmi-encoder-remote');
      const isNode =
        trimmed.includes('node') && trimmed.includes('main.js');

      if (isCd || isNode) {
        // Save launch lines to re-append at bottom, avoid duplicates
        if (!launchLines.includes(line)) {
          launchLines.push(line);
        }
      } else {
        kept.push(line);
      }
    }

    // If there were no launch lines yet, add our default pair
    if (launchLines.length === 0) {
      launchLines.push(
        'cd "$HOME/hdmi-encoder-remote"',
        'node main.js'
      );
    }

    // Rebuild file:
    // 1) everything except the old cd/node lines
    // 2) new export block
    // 3) cd/node at the very end
    let newContent = kept.join('\n').replace(/\s+$/, '') + '\n';
    newContent += block;
    newContent += '\n' + launchLines.join('\n') + '\n';

    fs.writeFileSync(RUN_SCRIPT_PATH, newContent, 'utf8');
    infoLines.push(chanLine, tsLine);
  } catch (err) {
    error = `Could not update ${RUN_SCRIPT_PATH}: ${err.message}`;
  }

  const m3uSnippet = `#EXTINF:-1 channel-id="${upperName}" tvg-name="${upperName}" tvg-chno="${chno}" group-title="HDMI",${upperName}
http://${hdmiIp}:${port}/stream/${lowerName}`;

  res.send(
    renderPage({
      defaults,
      result: { m3uSnippet, infoLines },
      error,
    })
  );
});

// Listen on port 8010
const PORT = 8010;
app.listen(PORT, () => {
  console.log(`Channel helper UI listening on http://0.0.0.0:${PORT}`);
});
