const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const UAParser = require('ua-parser-js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- Tiny JSON-file store (sync writes; fine for low-volume) ----------------
function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      links: Array.isArray(parsed.links) ? parsed.links : [],
      visits: Array.isArray(parsed.visits) ? parsed.visits : [],
      nextVisitId: Number(parsed.nextVisitId) || 1,
    };
  } catch {
    return { links: [], visits: [], nextVisitId: 1 };
  }
}
const store = loadStore();
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

function makeId(len = 8) {
  return crypto.randomBytes(Math.ceil(len * 0.75)).toString('base64url').slice(0, len);
}

// --- App setup --------------------------------------------------------------
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip.replace('::ffff:', '');
}

function normalizeUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return 'https://' + trimmed;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip);
}

// --- Silent server-side IP geolocation --------------------------------------
// Uses ip-api.com (free, no key, ~45 req/min). City-level accuracy.
// Caches per-IP for 24h to stay within quota.
const geoCache = new Map(); // ip -> { at, data }
const GEO_TTL = 24 * 60 * 60 * 1000;

async function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) return { status: 'private' };
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_TTL) return cached.data;
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon,isp,query`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    if (j.status !== 'success') {
      const data = { status: 'fail' };
      geoCache.set(ip, { at: Date.now(), data });
      return data;
    }
    const data = {
      status: 'ok',
      country: j.country || null,
      region: j.regionName || null,
      city: j.city || null,
      latitude: typeof j.lat === 'number' ? j.lat : null,
      longitude: typeof j.lon === 'number' ? j.lon : null,
      isp: j.isp || null,
    };
    geoCache.set(ip, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { status: 'error', error: String(e.message || e) };
  }
}

// --- API: links -------------------------------------------------------------
app.post('/api/links', (req, res) => {
  const { title, url } = req.body || {};
  const cleanTitle = String(title || '').trim();
  const cleanUrl = normalizeUrl(url);
  if (!cleanTitle) return res.status(400).json({ error: 'Title is required' });
  if (!cleanUrl) return res.status(400).json({ error: 'URL is required' });
  try { new URL(cleanUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const id = makeId(8);
  const now = Date.now();
  const link = { id, title: cleanTitle, target_url: cleanUrl, created_at: now };
  store.links.unshift(link);
  save();

  const host = req.get('host');
  const proto = req.protocol;
  res.json({ ...link, short_url: `${proto}://${host}/r/${id}` });
});

app.get('/api/links', (req, res) => {
  const host = req.get('host');
  const proto = req.protocol;
  const out = store.links.map(l => {
    const visits = store.visits.filter(v => v.link_id === l.id);
    const last = visits.reduce((m, v) => v.visited_at > m ? v.visited_at : m, 0);
    return {
      ...l,
      short_url: `${proto}://${host}/r/${l.id}`,
      visit_count: visits.length,
      last_visit: last || null,
    };
  });
  res.json(out);
});

app.delete('/api/links/:id', (req, res) => {
  const { id } = req.params;
  const before = store.links.length;
  store.links = store.links.filter(l => l.id !== id);
  store.visits = store.visits.filter(v => v.link_id !== id);
  save();
  res.json({ deleted: store.links.length < before });
});

// --- API: visits ------------------------------------------------------------
app.get('/api/visits', (req, res) => {
  const linkId = req.query.link_id;
  const byId = Object.fromEntries(store.links.map(l => [l.id, l]));
  let list = store.visits;
  if (linkId) list = list.filter(v => v.link_id === linkId);
  const out = [...list]
    .sort((a, b) => b.visited_at - a.visited_at)
    .slice(0, 500)
    .map(v => {
      const link = byId[v.link_id] || {};
      return { ...v, title: link.title || '(deleted)', target_url: link.target_url || '#' };
    });
  res.json(out);
});

// --- /r/:id: log silently, redirect immediately ----------------------------
app.get('/r/:id', async (req, res) => {
  const { id } = req.params;
  const link = store.links.find(l => l.id === id);
  if (!link) return res.status(404).send('Link not found');

  const ua = req.get('user-agent') || '';
  const parsed = new UAParser(ua).getResult();
  const deviceType = parsed.device.type
    || (/mobile/i.test(ua) ? 'mobile' : 'desktop');
  const ip = getClientIp(req);

  // Redirect right away — no intermediate page, nothing visible.
  res.redirect(302, link.target_url);

  // Lookup geo asynchronously after the response is sent.
  const geo = await lookupGeo(ip);

  const visit = {
    id: store.nextVisitId++,
    link_id: id,
    ip,
    device_type: deviceType,
    os: [parsed.os.name, parsed.os.version].filter(Boolean).join(' ') || null,
    browser: [parsed.browser.name, parsed.browser.version].filter(Boolean).join(' ') || null,
    user_agent: ua,
    country: geo.country || null,
    region: geo.region || null,
    city: geo.city || null,
    latitude: geo.latitude ?? null,
    longitude: geo.longitude ?? null,
    isp: geo.isp || null,
    geo_status: geo.status,
    visited_at: Date.now(),
  };
  store.visits.push(visit);
  save();
});

app.listen(PORT, () => {
  console.log(`Link tracker running on http://localhost:${PORT}`);
});
