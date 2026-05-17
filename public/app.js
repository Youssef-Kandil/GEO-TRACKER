const form = document.getElementById('link-form');
const createdBox = document.getElementById('created');
const createdLink = document.getElementById('created-link');
const copyBtn = document.getElementById('copy-btn');
const visitsBody = document.getElementById('visits-body');
const linksBody = document.getElementById('links-body');
const filterSelect = document.getElementById('filter-link');
const refreshBtn = document.getElementById('refresh-btn');

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadLinks() {
  const res = await fetch('/api/links');
  const links = await res.json();

  const prev = filterSelect.value;
  filterSelect.innerHTML = '<option value="">كل الروابط</option>'
    + links.map(l => `<option value="${l.id}">${escapeHtml(l.title)}</option>`).join('');
  if (links.some(l => l.id === prev)) filterSelect.value = prev;

  if (!links.length) {
    linksBody.innerHTML = '<tr><td colspan="6" class="muted center">لا توجد روابط بعد</td></tr>';
    return;
  }
  linksBody.innerHTML = links.map(l => `
    <tr>
      <td>${escapeHtml(l.title)}</td>
      <td><a href="${escapeHtml(l.short_url)}" target="_blank" rel="noreferrer">${escapeHtml(l.short_url)}</a></td>
      <td><a href="${escapeHtml(l.target_url)}" target="_blank" rel="noreferrer">${escapeHtml(l.target_url)}</a></td>
      <td><span class="pill">${l.visit_count}</span></td>
      <td>${fmtTime(l.last_visit)}</td>
      <td>
        <button class="ghost" data-copy="${escapeHtml(l.short_url)}">نسخ</button>
        <button class="danger" data-delete="${l.id}">حذف</button>
      </td>
    </tr>
  `).join('');
}

async function loadVisits() {
  const linkId = filterSelect.value;
  const url = linkId ? `/api/visits?link_id=${encodeURIComponent(linkId)}` : '/api/visits';
  const res = await fetch(url);
  const visits = await res.json();
  if (!visits.length) {
    visitsBody.innerHTML = '<tr><td colspan="10" class="muted center">لا توجد زيارات بعد</td></tr>';
    return;
  }
  visitsBody.innerHTML = visits.map(v => {
    const loc = [v.city, v.region, v.country].filter(Boolean).join('، ') || '-';
    const hasCoords = v.latitude != null && v.longitude != null;
    const isGps = v.geo_status === 'gps';
    const precision = isGps
      ? `<span class="pill" title="دقيق بـ${v.accuracy ? Math.round(v.accuracy) + ' م' : 'GPS'}">GPS ${v.accuracy ? '±' + Math.round(v.accuracy) + 'م' : ''}</span>`
      : `<span class="pill" title="مستوى المدينة">IP</span>`;
    const coordsCell = hasCoords
      ? `<a href="https://www.google.com/maps?q=${v.latitude},${v.longitude}" target="_blank" rel="noreferrer">${Number(v.latitude).toFixed(isGps ? 6 : 4)}, ${Number(v.longitude).toFixed(isGps ? 6 : 4)}</a> ${precision}`
      : `<span class="pill">${escapeHtml(v.geo_status || '-')}</span>`;
    return `
    <tr>
      <td>${fmtTime(v.visited_at)}</td>
      <td>${escapeHtml(v.title)}</td>
      <td><span class="pill">${escapeHtml(v.device_type || '-')}</span></td>
      <td>${escapeHtml(v.os || '-')}</td>
      <td>${escapeHtml(v.browser || '-')}</td>
      <td><code>${escapeHtml(v.ip || '-')}</code></td>
      <td>${escapeHtml(loc)}</td>
      <td>${coordsCell}</td>
      <td>${escapeHtml(v.isp || '-')}</td>
      <td><a href="${escapeHtml(v.target_url)}" target="_blank" rel="noreferrer">فتح</a></td>
    </tr>`;
  }).join('');
}

async function refreshAll() {
  await Promise.all([loadLinks(), loadVisits()]);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('title').value.trim();
  const url = document.getElementById('url').value.trim();
  const res = await fetch('/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, url }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'حصل خطأ');
    return;
  }
  createdLink.textContent = data.short_url;
  createdLink.href = data.short_url;
  createdBox.classList.remove('hidden');
  form.reset();
  await refreshAll();
});

copyBtn.addEventListener('click', async () => {
  const text = createdLink.textContent;
  try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'تم النسخ'; setTimeout(() => copyBtn.textContent = 'نسخ', 1200); }
  catch { /* ignore */ }
});

linksBody.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = 'تم النسخ'; setTimeout(() => t.textContent = 'نسخ', 1200); } catch {}
  } else if (t.dataset.delete) {
    if (!confirm('تأكيد حذف الرابط وكل زياراته؟')) return;
    await fetch(`/api/links/${t.dataset.delete}`, { method: 'DELETE' });
    await refreshAll();
  }
});

filterSelect.addEventListener('change', loadVisits);
refreshBtn.addEventListener('click', refreshAll);

refreshAll();
setInterval(refreshAll, 5000);
