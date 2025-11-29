const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');

// --- Defaults you can tweak here ---
const RUN_SCRIPT_PATH = path.join(__dirname, 'run-hdmi-remote.sh');

// Directory where per-source playlists will be written
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
if (!fs.existsSync(PLAYLISTS_DIR)) {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
}

// Master HDMI playlist name + path (now inside ./playlists)
const MASTER_PLAYLIST_NAME = 'hdmi-remote-playlist';
const PLAYLIST_PATH = path.join(PLAYLISTS_DIR, MASTER_PLAYLIST_NAME + '.m3u');

// One-time migration: if legacy ./hdmi-remote-playlist.m3u exists, copy into ./playlists
const LEGACY_PLAYLIST_PATH = path.join(__dirname, 'hdmi-remote-playlist.m3u');
try {
  if (fs.existsSync(LEGACY_PLAYLIST_PATH) && !fs.existsSync(PLAYLIST_PATH)) {
    fs.copyFileSync(LEGACY_PLAYLIST_PATH, PLAYLIST_PATH);
    console.log(
      `[startup] migrated legacy master playlist from ${LEGACY_PLAYLIST_PATH} to ${PLAYLIST_PATH}`
    );
  }
} catch (err) {
  console.warn('[startup] failed to migrate legacy master playlist:', err.message);
}

const DEFAULT_TS_URL =
  process.env.DEFAULT_TS_URL || 'http://192.168.0.168/0.ts';
const DEFAULT_HDMI_IP = process.env.HDMI_BOX_IP || '192.168.0.115';
const DEFAULT_PORT = Number(process.env.HDMI_REMOTE_PORT || 5589);

// In-memory state for the import tool
let importState = {
  sourceUrl: '',
  sourceName: '',
  entries: [],
  outputPlaylist: '',
};

// In-memory map of named playlists (for /playlist/:name.m3u)
const generatedPlaylists = {};

// ------------ load saved per-source playlists on startup ------------

function loadGeneratedPlaylistsFromDisk() {
  try {
    if (!fs.existsSync(PLAYLISTS_DIR)) {
      console.log('[import] no playlists directory yet');
      return;
    }

    const files = fs
      .readdirSync(PLAYLISTS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.m3u'));

    for (const file of files) {
      const name = path.basename(file, '.m3u');
      const fullPath = path.join(PLAYLISTS_DIR, file);
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        generatedPlaylists[name] = text;
        console.log(
          `[import] loaded saved playlist "${name}" from ${fullPath}`
        );
      } catch (err) {
        console.warn(
          `[import] failed to read saved playlist ${fullPath}:`,
          err.message
        );
      }
    }

    if (!files.length) {
      console.log('[import] no .m3u files in playlists directory yet');
    }
  } catch (err) {
    console.warn('[import] error scanning playlists dir:', err.message);
  }
}

// Call immediately so per-source /playlist/<name>.m3u works after reboot
loadGeneratedPlaylistsFromDisk();

// ---------------- helpers ----------------

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendToPlaylist(m3uSnippet) {
  let content = '';
  try {
    content = fs.readFileSync(PLAYLIST_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    content = '';
  }

  content = content.trim();

  // Ensure header
  if (!content) {
    content = '#EXTM3U\n';
  } else if (!content.startsWith('#EXTM3U')) {
    content = '#EXTM3U\n' + content + '\n';
  }

  const trimmedSnippet = m3uSnippet.trim();
  if (!content.includes(trimmedSnippet)) {
    content += '\n' + trimmedSnippet + '\n';
  }

  fs.writeFileSync(PLAYLIST_PATH, content, 'utf8');

  // keep in-memory master copy in sync so it shows as a saved source
  generatedPlaylists[MASTER_PLAYLIST_NAME] = content;
}

// Fetch text from an HTTP(S) URL
function fetchTextFromUrl(url) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      const u = new URL(url);
      client = u.protocol === 'https:' ? https : http;

      const req = client.get(u, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Parse #EXTINF line into attrs + displayName
function parseExtInfLine(line) {
  const match = line.match(/^#EXTINF:-1\s+(.*?),(.*)$/);
  if (!match) {
    return null;
  }
  const attrPart = match[1];
  const displayName = match[2].trim();

  const attrs = {};
  attrPart.replace(/([\w-]+)=("[^"]*"|\S+)/g, (m, key, value) => {
    let v = value || '';
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1);
    }
    attrs[key] = v;
    return m;
  });

  return { attrs, displayName };
}

// Parse an entire M3U into an array of entries
function parseM3UEntries(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF')) continue;

    const parsed = parseExtInfLine(line);
    if (!parsed) continue;

    const { attrs, displayName } = parsed;

    // Next non-empty, non-comment line is expected to be the URL
    let url = '';
    let j = i + 1;
    while (j < lines.length) {
      const uline = lines[j].trim();
      j++;
      if (!uline) continue;
      if (uline.startsWith('#')) continue;
      url = uline;
      break;
    }
    if (!url) continue;

    const channelId = attrs['channel-id'] || attrs['channel_id'] || '';
    const tvgName = attrs['tvg-name'] || attrs['tvg_name'] || '';
    const tvgId = attrs['tvg-id'] || attrs['tvg_id'] || '';
    const tvgChno = attrs['tvg-chno'] || attrs['tvg_chno'] || '';
    const tvgLogo = attrs['tvg-logo'] || attrs['tvg_logo'] || '';
    const origChno = tvgChno || channelId || '';

    entries.push({
      extinfLine: line,
      url,
      attrs,
      displayName,
      channelId,
      tvgName,
      tvgId,
      tvgChno,
      tvgLogo,
      origChno,
      newChno: '', // will be filled from the form
    });
  }

  return entries;
}

// Derive a "source name" from a Channels M3U URL, e.g.
// http://host:8090/devices/TVE-Philo/channels.m3u?... -> TVE-Philo
function deriveSourceNameFromUrl(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean); // ["devices","TVE-Philo","channels.m3u"]

    const idx = parts.indexOf('devices');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1]; // TVE-Philo
    }

    // Fallback: last path part without extension
    if (parts.length > 0) {
      const last = parts[parts.length - 1]; // e.g. "channels.m3u"
      return last.replace(/\.[^.]+$/, '') || 'playlist';
    }

    return 'playlist';
  } catch {
    return 'playlist';
  }
}

// ------------- Render main Add Channel page -------------

function renderMainPage({
  defaults,
  result,
  error,
  playlistUrl,
  savedSources,
}) {
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

  const playlistDisplayUrl =
    playlistUrl || `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`;

  const sources = Array.isArray(savedSources) ? savedSources : [];
  const sourcesHtml = sources.length
    ? sources
        .map((s) => {
          const encoded = encodeURIComponent(s);
          const playlistUrl = `/playlist/${encoded}.m3u`;
          const channelsUrl = `/channels/${encoded}`;
          const refreshAction = `/playlist/${encoded}/refresh`;
          const deleteAction = `/playlist/${encoded}/delete`;
          return `
        <li>
          <span class="source-name">${escapeHtml(s)}</span>
          <div class="source-actions">
            <a href="${playlistUrl}" target="_blank" class="playlist-btn">
              📄 M3U Playlist Link
            </a>
            <a href="${channelsUrl}" target="_blank" class="playlist-btn">
              📺 New Channel # List
            </a>
            <form method="post" action="${refreshAction}">
              <button type="submit" class="mini-btn">⟳ Reload from disk</button>
            </form>
            <form method="post" action="${deleteAction}" onsubmit="return confirm('Delete playlist ${escapeHtml(
              s
            )}? This cannot be undone.');">
              <button type="submit" class="mini-btn" style="border-color:#b91c1c;color:#fecaca;">
                🗑 Delete
              </button>
            </form>
          </div>
        </li>`;
        })
        .join('\n')
    : `<li><span style="opacity:0.6;">No per-source playlists saved yet.</span></li>`;

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
      max-width: 760px;
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
    select {
      width: 100%;
      padding: 7px 9px;
      border-radius: 8px;
      border: 1px solid #374151;
      background: #020617;
      color: #e5e7eb;
      font-size: 0.9rem;
      box-sizing: border-box;
    }
    select:focus {
      outline: none;
      border-color: #22c55e;
      box-shadow: 0 0 0 1px #22c55e33;
    }
    .url-row {
      display: flex;
      gap: 8px;
      margin-bottom: 6px;
      align-items: center;
    }
    .url-row select {
      flex: 1 1 auto;
    }
    .url-help {
      margin-top: 4px;
      font-size: 0.75rem;
      color: #9ca3af;
    }
    .button-row {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
      gap: 8px;
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
    .secondary-btn {
      background: transparent;
      color: #e5e7eb;
      border: 1px solid #4b5563;
    }
    .secondary-btn:hover {
      border-color: #a5b4fc;
      background: #020617;
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
    .playlist {
      margin-top: 16px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #020617;
      border: 1px dashed #4b5563;
      font-size: 0.85rem;
    }
    .playlist-url {
      margin-top: 4px;
      font-family: monospace;
      font-size: 0.8rem;
      background: #020617;
      padding: 5px 7px;
      border-radius: 6px;
      border: 1px solid #111827;
      overflow-wrap: anywhere;
    }
    .playlist-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .playlist-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid #4b5563;
      text-decoration: none;
      color: #e5e7eb;
      font-size: 0.8rem;
    }
    .playlist-btn:hover {
      border-color: #a5b4fc;
    }
    .source-list {
      list-style: none;
      padding-left: 0;
      margin: 6px 0 0 0;
    }
    .source-list li {
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .source-name {
      font-weight: 600;
      color: #e5e7eb;
      flex: 0 0 auto;
    }
    .source-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-left: auto;
      align-items: center;
    }
    .source-actions form {
      margin: 0;
    }
    .mini-btn {
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid #4b5563;
      background: transparent;
      color: #e5e7eb;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .mini-btn:hover {
      border-color: #a5b4fc;
    }
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px;">
      <h1>HDMI Encoder Remote – Channel Helper</h1>
      <a href="http://${escapeHtml(
        DEFAULT_HDMI_IP
      )}:8090" target="_blank" class="playlist-btn">
        🧠 Channels DVR Backend
      </a>
    </div>
    <div class="subtitle">
      Fill this out to update <code>run-hdmi-remote.sh</code> and auto-build an M3U playlist for Channels DVR.
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
        <div class="url-row">
          <select id="urlPresetSelect">
            <option value="">-- Choose preset --</option>
            <option value="https://www.philo.com/player/player/channel/">
              Philo – channel base
            </option>
            <option value="https://www.usanetwork.com/live">
              USA Network – usanetwork.com/live
            </option>
          </select>
          <button type="button" class="mini-btn" id="addPresetBtn">＋ Add</button>
          <button type="button" class="mini-btn" id="deletePresetBtn">🗑 Delete</button>
        </div>
        <input id="channelUrlInput" type="url" name="url" required
               value="${escapeHtml(url)}"
               placeholder="https://www.philo.com/player/player/channel/..." />
        <div class="url-help">
          Pick a preset to auto-fill the URL field. "Add" saves the current URL as a new preset in this browser; "Delete" removes the selected custom preset.
        </div>
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
               value="${escapeHtml(String(port))}"
               placeholder="${escapeHtml(String(DEFAULT_PORT))}" />
      </div>

      <div class="button-row">
        <button type="button" class="secondary-btn" onclick="window.location.href='/import'">
          📥 Import Playlist
        </button>
        <button type="submit">
          <span class="icon">➕</span>
          Add Channel
        </button>
      </div>
    </form>

    ${
      errorMsg
        ? `<div class="error">${escapeHtml(errorMsg)}</div>`
        : ''
    }

    ${
      snippet
        ? `<div class="result">
            <div><strong>Latest entry:</strong></div>
            <ul class="info-list">
              ${infoLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
            </ul>
            <div style="margin-top:8px;"><strong>M3U entry:</strong></div>
            <textarea readonly>${escapeHtml(snippet)}</textarea>
          </div>`
        : ''
    }

    <div class="playlist">
      <div><strong>Master M3U playlist for Channels DVR:</strong></div>
      <div class="playlist-url">${escapeHtml(playlistDisplayUrl)}</div>
      <div class="playlist-actions">
        <a href="/playlist.m3u" target="_blank" class="playlist-btn">
          🔗 Open / download playlist
        </a>
        <span style="font-size:0.8rem; color:#9ca3af;">
          In Channels DVR, add a new M3U source with this URL.
        </span>
      </div>
    </div>

    <div class="playlist" style="margin-top:12px;">
      <div><strong>Saved per-source playlists (from ./playlists):</strong></div>
      <div class="url-help" style="margin-top:4px;">
        HDMI master playlist URL:
        <code>http://${escapeHtml(DEFAULT_HDMI_IP)}:8010/playlist.m3u</code>
      </div>
      <ul class="source-list">
        ${sourcesHtml}
      </ul>
    </div>
  </div>

  <script>
    (function() {
      var STORAGE_KEY = 'channel-helper-url-presets';

      var builtInPresets = [
        {
          id: 'philo-base',
          label: 'Philo \\u2013 channel base',
          value: 'https://www.philo.com/player/player/channel/'
        },
        {
          id: 'usa-live',
          label: 'USA Network \\u2013 usanetwork.com/live',
          value: 'https://www.usanetwork.com/live'
        }
      ];

      function loadCustomPresets() {
        try {
          var raw = window.localStorage.getItem(STORAGE_KEY);
          if (!raw) return [];
          var arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return [];
          return arr;
        } catch (e) {
          console.warn('[channel-helper] failed to load custom URL presets', e);
          return [];
        }
      }

      function saveCustomPresets(list) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list || []));
        } catch (e) {
          console.warn('[channel-helper] failed to save custom URL presets', e);
        }
      }

      function rebuildSelect(select, customPresets) {
        while (select.firstChild) select.removeChild(select.firstChild);

        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '-- Choose preset --';
        select.appendChild(placeholder);

        builtInPresets.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p.value;
          opt.textContent = p.label;
          opt.setAttribute('data-preset-id', p.id);
          opt.setAttribute('data-built-in', 'true');
          select.appendChild(opt);
        });

        if (customPresets && customPresets.length) {
          var group = document.createElement('optgroup');
          group.label = 'Custom presets';
          customPresets.forEach(function(p) {
            var opt = document.createElement('option');
            opt.value = p.value;
            opt.textContent = p.label;
            opt.setAttribute('data-preset-id', p.id);
            group.appendChild(opt);
          });
          select.appendChild(group);
        }
      }

      function init() {
        var urlInput = document.getElementById('channelUrlInput');
        var select = document.getElementById('urlPresetSelect');
        var addBtn = document.getElementById('addPresetBtn');
        var delBtn = document.getElementById('deletePresetBtn');
        if (!urlInput || !select || !addBtn || !delBtn) return;

        var customPresets = loadCustomPresets();
        rebuildSelect(select, customPresets);

        select.addEventListener('change', function() {
          var val = select.value || '';
          if (val) {
            urlInput.value = val;
          }
        });

        addBtn.addEventListener('click', function() {
          var current = (urlInput.value || '').trim();
          if (!current) {
            window.alert('Enter a URL first, then click Add.');
            return;
          }
          var label = window.prompt('Name for this preset (e.g. Philo \\u2013 Paramount)?', current);
          if (!label) return;

          var id = 'custom-' + Date.now();
          customPresets.push({ id: id, label: label, value: current });
          saveCustomPresets(customPresets);
          rebuildSelect(select, customPresets);

          Array.prototype.forEach.call(select.options, function(opt) {
            if (opt.value === current && opt.textContent === label) {
              select.value = opt.value;
            }
          });
        });

        delBtn.addEventListener('click', function() {
          var selectedIndex = select.selectedIndex;
          if (selectedIndex < 0) {
            window.alert('Choose a custom preset to delete.');
            return;
          }
          var selectedOpt = select.options[selectedIndex];
          if (!selectedOpt || !selectedOpt.value) {
            window.alert('Choose a custom preset to delete.');
            return;
          }
          var presetId = selectedOpt.getAttribute('data-preset-id');
          var isBuiltIn = selectedOpt.getAttribute('data-built-in') === 'true';
          if (isBuiltIn) {
            window.alert('Built-in presets cannot be deleted.');
            return;
          }
          if (!presetId) return;

          if (!window.confirm('Delete preset "' + selectedOpt.textContent + '"?')) {
            return;
          }

          customPresets = customPresets.filter(function(p) {
            return p.id !== presetId;
          });
          saveCustomPresets(customPresets);
          rebuildSelect(select, customPresets);
        });
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  </script>
</body>
</html>
`;
}

// ------------- Render Import Playlist page -------------

function renderImportPage({
  sourceUrl,
  sourceName,
  entries,
  message,
  error,
  outputPlaylist,
}) {
  const safeSourceUrl = sourceUrl || '';
  const msg = message || '';
  const err = error || '';

  const currentSourceName = sourceName || 'TVE-Philo';
  const dynamicPlaylistUrl = `http://${DEFAULT_HDMI_IP}:8010/playlist/${currentSourceName}.m3u`;

  const rowsHtml = (entries || [])
    .map((e, idx) => {
      const rowNum = idx + 1;

      // render tvg-logo as an actual image
      const logoHtml = e.tvgLogo
        ? `<img src="${escapeHtml(e.tvgLogo)}"
                 alt="${escapeHtml(e.tvgName || 'logo')}"
                 style="height:32px;object-fit:contain;" />`
        : `<span style="opacity:0.6;">no logo</span>`;

      return `
      <tr>
        <td>${rowNum}</td>
        <td>${escapeHtml(e.tvgName || '')}</td>
        <td>${logoHtml}</td>
        <td>${escapeHtml(e.tvgChno || e.origChno || '')}</td>
        <td>
          <input class="small-input" type="text"
                 name="newChno_${idx}"
                 value="${escapeHtml(e.newChno || '')}" />
        </td>
      </tr>`;
    })
    .join('');

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Import Playlist – HDMI Channel Helper</title>
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
      max-width: 900px;
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
      margin-bottom: 14px;
    }
    a.back-link {
      font-size: 0.8rem;
      color: #a5b4fc;
      text-decoration: none;
    }
    a.back-link:hover {
      text-decoration: underline;
    }
    label {
      display: block;
      font-size: 0.8rem;
      color: #9ca3af;
      margin-bottom: 4px;
    }
    input[type="text"],
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
    .top-form {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .top-form > div {
      flex: 1;
    }
    .top-form button {
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
      margin-top: 22px;
      white-space: nowrap;
    }
    .top-form button:hover {
      background: #16a34a;
    }
    .msg, .error {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 0.8rem;
    }
    .msg {
      background: #022c22;
      border: 1px solid #16a34a;
    }
    .error {
      background: #450a0a;
      border: 1px solid #b91c1c;
      color: #fecaca;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 0.8rem;
    }
    th, td {
      padding: 6px 8px;
      border-bottom: 1px solid #1f2937;
      text-align: left;
      vertical-align: middle;
    }
    th {
      font-weight: 600;
      color: #9ca3af;
      background: #020617;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tbody tr:nth-child(odd) {
      background: #020617;
    }
    tbody tr:nth-child(even) {
      background: #020617;
    }
    .table-wrap {
      max-height: 320px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid #1f2937;
      margin-top: 8px;
    }
    .small-input {
      width: 80px;
      padding: 3px 6px;
      font-size: 0.8rem;
      border-radius: 6px;
      border: 1px solid #374151;
      background: #020617;
      color: #e5e7eb;
    }
    .update-row {
      margin-top: 10px;
      display: flex;
      justify-content: flex-end;
    }
    .update-row button {
      background: #22c55e;
      border: none;
      border-radius: 999px;
      color: #022c22;
      font-weight: 600;
      padding: 7px 16px;
      font-size: 0.85rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .update-row button:hover {
      background: #16a34a;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      margin-top: 10px;
      background: #020617;
      color: #e5e7eb;
      border-radius: 8px;
      border: 1px solid #374151;
      font-family: monospace;
      font-size: 0.8rem;
      padding: 8px;
      resize: vertical;
      min-height: 120px;
    }
    .dyn-url {
      margin-top: 8px;
      font-size: 0.8rem;
      color: #9ca3af;
    }
    .dyn-url code {
      font-family: monospace;
      background: #020617;
      padding: 3px 5px;
      border-radius: 6px;
      border: 1px solid #111827;
    }
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
      <h1>Import Playlist – HDMI Channel Helper</h1>
      <a class="back-link" href="/">← Back to Add Channel</a>
    </div>
    <div class="subtitle">
      Paste a Channels DVR M3U URL (e.g. TVE-Philo), tweak channel numbers, and get a rewritten M3U.
    </div>

    <form method="POST" action="/import/fetch" class="top-form">
      <div>
        <label>Playlist URL</label>
        <input type="url" name="sourceUrl"
               required
               value="${escapeHtml(
                 safeSourceUrl ||
                   'http://192.168.0.115:8090/devices/TVE-Philo/channels.m3u?format=ts&codec=copy'
               )}" />
      </div>
      <div style="flex:0 0 auto;">
        <button type="submit">
          📥 Fetch Playlist
        </button>
      </div>
    </form>

    ${
      err
        ? `<div class="error">${escapeHtml(err)}</div>`
        : msg
        ? `<div class="msg">${escapeHtml(msg)}</div>`
        : ''
    }

    <div class="dyn-url">
      <div><strong>When updated, this playlist will be served at:</strong></div>
      <div><code>${escapeHtml(dynamicPlaylistUrl)}</code></div>
    </div>

    ${
      entries && entries.length
        ? `
      <form method="POST" action="/import/update">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>tvg-name</th>
                <th>tvg-logo</th>
                <th>Current tvg-chno</th>
                <th>New Channel #</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
        <div class="update-row">
          <button type="submit">
            ✅ Update Playlist
          </button>
        </div>
      </form>
      `
        : ''
    }

    ${
      outputPlaylist
        ? `
      <div style="margin-top:14px; font-size:0.85rem;">
        <strong>Updated M3U playlist (copy this into a new file if you want):</strong>
      </div>
      <textarea readonly>${escapeHtml(outputPlaylist)}</textarea>
      `
        : ''
    }
  </div>
</body>
</html>
`;
}

function renderChannelListPage({ sourceName, entries }) {
  const safeName = sourceName || 'Unknown';

  // --- sort by channel number (tvg-chno/origChno), low -> high ---
  const sortedEntries = (entries || []).slice().sort((a, b) => {
    const getCh = (e) => (e.tvgChno || e.origChno || '').trim();

    const ca = getCh(a);
    const cb = getCh(b);

    const na = parseFloat(ca);
    const nb = parseFloat(cb);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);

    if (aNum && bNum && na !== nb) return na - nb;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;

    return ca.localeCompare(cb);
  });

  const rowsHtml = sortedEntries
    .map((e, idx) => {
      const rowNum = idx + 1;
      const chno = e.tvgChno || e.origChno || '';
      const name = e.tvgName || e.displayName || '';

      // 🔧 be extra defensive about where we pull logo from
      const logoUrl =
        e.tvgLogo ||
        (e.attrs && (e.attrs['tvg-logo'] || e.attrs['tvg_logo'])) ||
        '';

      const logoHtml = logoUrl
        ? `<img src="${escapeHtml(logoUrl)}"
           alt="${escapeHtml(name || 'logo')}"
           style="
             height:32px;
             object-fit:contain;
             border-radius:6px;
             background:#4b5563;   /* medium gray behind logo */
             padding:4px;
           "/>`
        : `<span style="opacity:0.6;">no logo</span>`;

      return `
        <tr>
          <td>${rowNum}</td>
          <td>${escapeHtml(chno)}</td>
          <td>${escapeHtml(name)}</td>
          <td>${logoHtml}</td>
        </tr>`;
    })
    .join('');

  const tableHtml =
    entries && entries.length
      ? `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Channel #</th>
              <th>tvg-name</th>
              <th>Logo</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>`
      : `
      <div class="msg">
        No channels found in this playlist.
      </div>`;

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Channels – ${escapeHtml(safeName)}</title>
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
      max-width: 900px;
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
      margin-bottom: 14px;
    }
    a.back-link {
      font-size: 0.8rem;
      color: #a5b4fc;
      text-decoration: none;
    }
    a.back-link:hover {
      text-decoration: underline;
    }
    .msg {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 0.8rem;
      background: #022c22;
      border: 1px solid #16a34a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 0.8rem;
    }
    th, td {
      padding: 6px 8px;
      border-bottom: 1px solid #1f2937;
      text-align: left;
      vertical-align: middle;
    }
    th {
      font-weight: 600;
      color: #9ca3af;
      background: #020617;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tbody tr:nth-child(odd) {
      background: #020617;
    }
    tbody tr:nth-child(even) {
      background: #020617;
    }
    .table-wrap {
      max-height: 420px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid #1f2937;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
      <h1>Channels – ${escapeHtml(safeName)}</h1>
      <a class="back-link" href="/">← Back to Channel Helper</a>
    </div>
    <div class="subtitle">
      Channel numbers and logos parsed from <code>${escapeHtml(
        safeName
      )}.m3u</code>.
    </div>

    ${tableHtml}
  </div>
</body>
</html>
`;
}

// ---------------- app ----------------

const app = express();
app.use(express.urlencoded({ extended: true }));

// --------- Main Add Channel / M3U builder ---------

app.get('/', (req, res) => {
  res.send(
    renderMainPage({
      defaults: {},
      result: null,
      error: null,
      playlistUrl: `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`,
      savedSources: Object.keys(generatedPlaylists).sort(),
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
      renderMainPage({
        defaults,
        result: null,
        error: 'Channel name is required.',
        playlistUrl: `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`,
        savedSources: Object.keys(generatedPlaylists).sort(),
      })
    );
  }

  if (!url) {
    return res.send(
      renderMainPage({
        defaults,
        result: null,
        error: 'Channel URL is required.',
        playlistUrl: `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`,
        savedSources: Object.keys(generatedPlaylists).sort(),
      })
    );
  }

  const chno = chnoRaw || '1';
  const tsUrl = tsUrlRaw || DEFAULT_TS_URL;
  const hdmiIp = hdmiIpRaw || DEFAULT_HDMI_IP;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;

  // 🔒 Make a safe short name for env vars + stream path
  const safeBase = nameRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!safeBase) {
    return res.send(
      renderMainPage({
        defaults,
        result: null,
        error:
          'Short channel name must contain at least one letter or number (A–Z, 0–9).',
        playlistUrl: `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`,
        savedSources: Object.keys(generatedPlaylists).sort(),
      })
    );
  }

  const upperName = safeBase; // e.g. "E!", "USA HD" -> "E", "USAHD"
  const lowerName = safeBase.toLowerCase(); // "e", "usahd"

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
    // --- rewrite run-hdmi-remote.sh, keep cd/node at bottom ---
    let existing = '';
    try {
      existing = fs.readFileSync(RUN_SCRIPT_PATH, 'utf8');
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') {
        throw readErr;
      }
      existing = '';
    }

    const lines = existing.split(/\r?\n/);
    const kept = [];
    const launchLines = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        kept.push(line);
        continue;
      }

      const isCd =
        trimmed.includes('cd') && trimmed.includes('hdmi-encoder-remote');
      const isNode = trimmed.includes('node') && trimmed.includes('main.js');

      if (isCd || isNode) {
        if (!launchLines.includes(line)) {
          launchLines.push(line);
        }
      } else {
        kept.push(line);
      }
    }

    if (launchLines.length === 0) {
      launchLines.push('cd "$HOME/hdmi-encoder-remote"', 'node main.js');
    }

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

  try {
    appendToPlaylist(m3uSnippet);
  } catch (plErr) {
    error = error
      ? error + ' | Playlist error: ' + plErr.message
      : 'Playlist error: ' + plErr.message;
  }

  res.send(
    renderMainPage({
      defaults,
      result: { m3uSnippet, infoLines },
      error,
      playlistUrl: `http://${DEFAULT_HDMI_IP}:8010/playlist.m3u`,
      savedSources: Object.keys(generatedPlaylists).sort(),
    })
  );
});

// Master playlist (the “HDMI playlist” we’ve always had)
app.get('/playlist.m3u', (req, res) => {
  let playlist;
  try {
    playlist = fs.readFileSync(PLAYLIST_PATH, 'utf8');
  } catch (err) {
    playlist = '#EXTM3U\n';
  }
  // Make browser show it as text
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(playlist);
});

// Per-source playlist: /playlist/TVE-Philo.m3u, /playlist/10A54A42.m3u, etc.
app.get('/playlist/:name.m3u', (req, res) => {
  const requestedName = req.params.name;
  const wantedLower = (requestedName + '.m3u').toLowerCase();

  console.log(`[playlist] request for "${requestedName}"`);

  let files = [];
  try {
    files = fs.readdirSync(PLAYLISTS_DIR);
    console.log('[playlist] available files:', files);
  } catch (err) {
    console.error('[playlist] error reading playlists dir:', err);
    res.status(500);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(
      `#EXTM3U\n# Error reading playlists dir: ${err.message}\n`
    );
  }

  const match = files.find((f) => f.toLowerCase() === wantedLower);

  if (!match) {
    res.status(404);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(
      `#EXTM3U\n# No playlist file found for ${requestedName}.\n# Have: ${files.join(
        ', '
      )}\n`
    );
  }

  const filePath = path.join(PLAYLISTS_DIR, match);
  console.log(`[playlist] serving "${match}" from ${filePath}`);

  let pl;
  try {
    pl = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[playlist] failed to read ${filePath}:`, err);
    res.status(500);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(
      `#EXTM3U\n# Error reading playlist "${requestedName}": ${err.message}\n`
    );
  }

  // keep UI cache in sync, but don't depend on it
  generatedPlaylists[requestedName] = pl;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(pl);
});

// Reload a per-source playlist from disk and update in-memory cache, then go back home
app.post('/playlist/:name/refresh', (req, res) => {
  const requestedName = req.params.name;
  const wantedLower = (requestedName + '.m3u').toLowerCase();

  console.log(`[playlist/refresh] request for "${requestedName}"`);

  let files = [];
  try {
    files = fs.readdirSync(PLAYLISTS_DIR);
    console.log('[playlist/refresh] available files:', files);
  } catch (err) {
    console.error('[playlist/refresh] error reading playlists dir:', err);
    // Just bounce back to the main page; the UI will still list whatever was loaded at startup
    return res.redirect(303, '/');
  }

  const match = files.find((f) => f.toLowerCase() === wantedLower);
  if (!match) {
    console.warn(`[playlist/refresh] no file found for "${requestedName}"`);
    return res.redirect(303, '/');
  }

  const filePath = path.join(PLAYLISTS_DIR, match);
  console.log(`[playlist/refresh] reloading "${match}" from ${filePath}`);

  try {
    const pl = fs.readFileSync(filePath, 'utf8');
    generatedPlaylists[requestedName] = pl;
  } catch (err) {
    console.error('[playlist/refresh] failed to read', filePath, err);
    // Ignore the error for the UI, just go home
  }

  // After refreshing the cache, send the user back to the main page
  return res.redirect(303, '/');
});

// Delete a per-source playlist (file + cache) then go back home
app.post('/playlist/:name/delete', (req, res) => {
  const requestedName = req.params.name;
  const wantedLower = (requestedName + '.m3u').toLowerCase();

  console.log(`[playlist/delete] request for "${requestedName}"`);

  let files = [];
  try {
    files = fs.readdirSync(PLAYLISTS_DIR);
    console.log('[playlist/delete] available files:', files);
  } catch (err) {
    console.error('[playlist/delete] error reading playlists dir:', err);
    return res.redirect(303, '/');
  }

  const match = files.find((f) => f.toLowerCase() === wantedLower);
  if (!match) {
    console.warn(`[playlist/delete] no file found for "${requestedName}"`);
    delete generatedPlaylists[requestedName];
    return res.redirect(303, '/');
  }

  const filePath = path.join(PLAYLISTS_DIR, match);
  try {
    fs.unlinkSync(filePath);
    console.log(`[playlist/delete] removed ${filePath}`);
  } catch (err) {
    console.error('[playlist/delete] failed to delete', filePath, err);
  }

  delete generatedPlaylists[requestedName];

  return res.redirect(303, '/');
});

// Simple channel + logo list page for a given playlist
app.get('/channels/:name', (req, res) => {
  const requestedName = req.params.name;
  const wantedLower = (requestedName + '.m3u').toLowerCase();

  let files = [];
  try {
    files = fs.readdirSync(PLAYLISTS_DIR);
  } catch (err) {
    console.error('[channels] error reading playlists dir:', err);
    res.status(500);
    return res.send(
      renderChannelListPage({
        sourceName: requestedName,
        entries: [],
      })
    );
  }

  const match = files.find((f) => f.toLowerCase() === wantedLower);
  if (!match) {
    res.status(404);
    return res.send(
      renderChannelListPage({
        sourceName: requestedName,
        entries: [],
      })
    );
  }

  const filePath = path.join(PLAYLISTS_DIR, match);
  let plText = '';
  try {
    plText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('[channels] failed to read', filePath, err);
    res.status(500);
    return res.send(
      renderChannelListPage({
        sourceName: requestedName,
        entries: [],
      })
    );
  }

  const entries = parseM3UEntries(plText);
  res.send(
    renderChannelListPage({
      sourceName: match.replace(/\.m3u$/i, ''),
      entries,
    })
  );
});

// --------- Import & rewrite provider M3U ---------

app.get('/import', (req, res) => {
  res.send(
    renderImportPage({
      sourceUrl: importState.sourceUrl,
      sourceName: importState.sourceName,
      entries: importState.entries,
      message: '',
      error: '',
      outputPlaylist: importState.outputPlaylist || '',
    })
  );
});

app.post('/import/fetch', async (req, res) => {
  const sourceUrl = (req.body.sourceUrl || '').trim();

  if (!sourceUrl) {
    return res.send(
      renderImportPage({
        sourceUrl: '',
        sourceName: '',
        entries: [],
        message: '',
        error: 'Playlist URL is required.',
        outputPlaylist: '',
      })
    );
  }

  try {
    const text = await fetchTextFromUrl(sourceUrl);
    const entries = parseM3UEntries(text);
    const sourceName = deriveSourceNameFromUrl(sourceUrl);

    // Repopulate New Channel # from previous state for same source (sticky renumbers)
    const prevEntries =
      importState.sourceName === sourceName ? importState.entries || [] : [];
    const prevMap = new Map();

    for (const e of prevEntries) {
      const key =
        e.tvgId ||
        e.channelId ||
        `${e.tvgName}|${e.origChno}|${e.displayName}`;
      if (!key) continue;
      if (e.newChno && e.newChno.trim() !== '') {
        prevMap.set(key, e.newChno.trim());
      }
    }

    for (const e of entries) {
      const key =
        e.tvgId ||
        e.channelId ||
        `${e.tvgName}|${e.origChno}|${e.displayName}`;
      if (key && prevMap.has(key)) {
        e.newChno = prevMap.get(key);
      }
    }

    importState = {
      sourceUrl,
      sourceName,
      entries,
      outputPlaylist: '',
    };

    res.send(
      renderImportPage({
        sourceUrl,
        sourceName,
        entries,
        message: `Loaded ${entries.length} channels from playlist "${sourceName}".`,
        error: '',
        outputPlaylist: '',
      })
    );
  } catch (err) {
    const sourceName = deriveSourceNameFromUrl(sourceUrl);
    importState = {
      sourceUrl,
      sourceName,
      entries: [],
      outputPlaylist: '',
    };

    res.send(
      renderImportPage({
        sourceUrl,
        sourceName,
        entries: [],
        message: '',
        error: `Failed to fetch/parse playlist: ${err.message}`,
        outputPlaylist: '',
      })
    );
  }
});

app.post('/import/update', (req, res) => {
  if (!importState.entries || !importState.entries.length) {
    return res.send(
      renderImportPage({
        sourceUrl: importState.sourceUrl || '',
        sourceName: importState.sourceName || '',
        entries: [],
        message: '',
        error: 'No imported playlist in memory. Fetch one first.',
        outputPlaylist: '',
      })
    );
  }

  const entries = importState.entries;

  // 1) Update each entry with the New Channel # from the form
  for (let idx = 0; idx < entries.length; idx++) {
    const fieldName = `newChno_${idx}`;
    const newChnoRaw = (req.body[fieldName] || '').trim();
    // store it back on the entry so the form stays filled when we re-render
    entries[idx].newChno = newChnoRaw;
  }

  // 2) Build updated M3U using ONLY entries that have a New Channel #
  const selected = entries.filter(
    (e) => e.newChno && e.newChno.trim() !== ''
  );

  let outputPlaylist = '#EXTM3U\n';

  for (const entry of selected) {
    const attrs = { ...(entry.attrs || {}) };

    const tvgName =
      attrs['tvg-name'] || entry.tvgName || entry.displayName || '';
    const tvgId = attrs['tvg-id'] || entry.tvgId || '';

    const origChno =
      entry.origChno || attrs['tvg-chno'] || attrs['channel-id'] || '';

    // New channel number from the UI
    const newChno = entry.newChno.trim();

    // Update attributes:
    // - tvg-chno = new channel number
    // - channel-id = original channel number
    if (newChno) {
      attrs['tvg-chno'] = newChno;
    }
    if (origChno) {
      attrs['channel-id'] = origChno;
    }

    // Rebuild attribute string: tvg-id, tvg-name, tvg-chno, channel-id, plus any others
    const attrOrder = ['tvg-id', 'tvg-name', 'tvg-chno', 'channel-id'];
    const parts = [];

    for (const key of attrOrder) {
      const val = attrs[key];
      if (val != null && val !== '') {
        parts.push(`${key}="${String(val)}"`);
      }
    }

    // include any other attributes (group-title, tvg-logo, etc.)
    for (const [key, val] of Object.entries(attrs)) {
      if (attrOrder.includes(key)) continue;
      if (val == null || val === '') continue;
      parts.push(`${key}="${String(val)}"`);
    }

    const displayName = tvgName || entry.displayName || '';
    const extinfLine = `#EXTINF:-1 ${parts.join(' ')},${displayName}`;
    const urlLine = entry.url || '';

    outputPlaylist += extinfLine + '\n' + urlLine + '\n';
  }

  // 3) Save in memory
  importState.outputPlaylist = outputPlaylist;

  // 4) Pick a source name (e.g. TVE-Philo) from state or URL
  const sourceName =
    importState.sourceName ||
    deriveSourceNameFromUrl(importState.sourceUrl || '');
  generatedPlaylists[sourceName] = outputPlaylist;

  // 5) Also write to disk: ./playlists/TVE-Philo.m3u
  try {
    const filePath = path.join(PLAYLISTS_DIR, `${sourceName}.m3u`);
    fs.writeFileSync(filePath, outputPlaylist, 'utf8');
    console.log(`[import] wrote playlist to ${filePath}`);
  } catch (err) {
    console.warn('[import] failed to write playlist file:', err.message);
  }

  const msg =
    selected.length === 0
      ? 'No rows had a New Channel #. Output playlist is just #EXTM3U.'
      : `Updated playlist built with ${selected.length} channels (only rows with a New Channel #).`;

  return res.send(
    renderImportPage({
      sourceUrl: importState.sourceUrl || '',
      sourceName,
      entries, // now with .newChno filled in
      message: msg,
      error: '',
      outputPlaylist, // shows in textarea
    })
  );
});

// Listen on port 8010
const UI_PORT = 8010;
app.listen(UI_PORT, () => {
  console.log(`Channel helper UI listening on http://0.0.0.0:${UI_PORT}`);
});
