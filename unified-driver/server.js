const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'devices.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Load config from disk
function loadConfigs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

// Save config to disk
function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
}

// Stats persistence
function loadStats() {
  try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) {}
  return { pv: 0, uvAll: [], daily: {} };
}
function saveStats(stats) {
  // Prune daily entries older than 90 days
  if (stats.daily) {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(stats.daily)) { if (d < cutoff) delete stats.daily[d]; }
  }
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
}

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // =================== API Routes ===================

  // GET /api/configs — list all device configs
  if (pathname === '/api/configs' && req.method === 'GET') {
    const configs = loadConfigs();
    return sendJSON(res, 200, { devices: Object.values(configs) });
  }

  // GET /api/configs/:key — get one device config
  if (pathname.startsWith('/api/configs/') && req.method === 'GET') {
    const key = decodeURIComponent(pathname.slice('/api/configs/'.length));
    const configs = loadConfigs();
    if (configs[key]) return sendJSON(res, 200, configs[key]);
    return sendJSON(res, 404, { error: 'Not found' });
  }

  // PUT /api/configs/:key — save/update device config
  if (pathname.startsWith('/api/configs/') && req.method === 'PUT') {
    try {
      const key = decodeURIComponent(pathname.slice('/api/configs/'.length));
      const body = await readBody(req);
      const configs = loadConfigs();
      configs[key] = { ...body, deviceKey: key, lastConnected: new Date().toISOString() };
      saveConfigs(configs);
      return sendJSON(res, 200, configs[key]);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/configs/:key — delete device config
  if (pathname.startsWith('/api/configs/') && req.method === 'DELETE') {
    const key = decodeURIComponent(pathname.slice('/api/configs/'.length));
    const configs = loadConfigs();
    delete configs[key];
    saveConfigs(configs);
    return sendJSON(res, 200, { ok: true });
  }

  // GET /api/status — health check
  if (pathname === '/api/status') {
    return sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  // ── UV / PV Stats ──

  // POST /api/stats/hit — record a page view
  if (pathname === '/api/stats/hit' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const uid = body.uid || '';
      const stats = loadStats();
      const today = new Date().toISOString().slice(0, 10);

      // PV: always increment
      stats.pv = (stats.pv || 0) + 1;
      if (!stats.daily) stats.daily = {};
      if (!stats.daily[today]) stats.daily[today] = { pv: 0, uvSet: [] };
      stats.daily[today].pv++;

      // UV: unique by uid per day
      if (uid && !stats.daily[today].uvSet.includes(uid)) {
        stats.daily[today].uvSet.push(uid);
      }

      // Total UV = all unique uids ever
      if (!stats.uvAll) stats.uvAll = [];
      if (uid && !stats.uvAll.includes(uid)) stats.uvAll.push(uid);

      saveStats(stats);
      return sendJSON(res, 200, { pv: stats.pv, uv: stats.uvAll.length, todayPv: stats.daily[today].pv, todayUv: stats.daily[today].uvSet.length });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // GET /api/stats — get current stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    const stats = loadStats();
    const today = new Date().toISOString().slice(0, 10);
    const d = stats.daily && stats.daily[today] ? stats.daily[today] : { pv: 0, uvSet: [] };
    return sendJSON(res, 200, {
      pv: stats.pv || 0,
      uv: (stats.uvAll || []).length,
      todayPv: d.pv,
      todayUv: d.uvSet.length,
    });
  }

  // =================== Static Files ===================
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (_) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Mouse Driver Server running on port ${PORT}`);
});
