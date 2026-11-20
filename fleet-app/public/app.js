'use strict';
/* Driver Log Shalom — single-page front end (no framework). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }));
const money = (n) => (n === null || n === undefined ? '—' : '₹' + fmt(n, 2));
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const SERVICE_LABEL = { oil_change: 'Oil change', general_service: 'General service', tyre: 'Tyre', brake: 'Brake',
  battery: 'Battery (12V)', cng_kit: 'CNG kit', ev_battery: 'EV battery / charger', other: 'Other' };
// Fuel types: unit, icon, colour of the badge and wording used on the Fuel page.
const FUEL = {
  CNG:    { unit: 'kg',  icon: '🟢', station: 'CNG station',      placeholder: 'e.g. IGL Sector 18',    noun: 'CNG fill' },
  Petrol: { unit: 'L',   icon: '⛽', station: 'Petrol pump',      placeholder: 'e.g. Indian Oil, MG Road', noun: 'petrol fill' },
  Diesel: { unit: 'L',   icon: '🛢', station: 'Diesel pump',      placeholder: 'e.g. HP, Ring Road',      noun: 'diesel fill' },
  EV:     { unit: 'kWh', icon: '⚡', station: 'Charging station', placeholder: 'e.g. Tata Power, home',   noun: 'EV reading' },
};
const VEHICLE_FUELS = ['CNG', 'CNG + Petrol', 'Petrol', 'Diesel', 'EV', 'Petrol + EV (hybrid)'];
const primaryFuel = (vf) => (vf === 'EV' ? 'EV' : Object.keys(FUEL).find((k) => String(vf || '').startsWith(k)) || 'CNG');
/** km this month: trips, or odometer readings when they show more (EVs logged by odometer only) */
const monthKmCell = (v) => (v.month_odometer_km > v.month_km
  ? `${fmt(v.month_odometer_km, 1)}<br><small class="muted">from odometer</small>` : fmt(v.month_km, 1));
// Vehicle documents
const DOCS = [['insurance', '🛡 Insurance'], ['pucc', '💨 Pollution (PUC)'], ['fitness', '✅ Fitness'], ['tax', '🧾 Road tax'], ['permit', '📜 Permit']];
const DOC_SHORT = { insurance: 'Insurance', pucc: 'Pollution (PUC)', fitness: 'Fitness', tax: 'Road tax', permit: 'Permit' };
const niceDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const docCell = (s) => {
  if (!s || !s.upto) return '<span class="muted">—</span>';
  if (s.upto.startsWith('9999')) return '<b>Lifetime</b><br><span class="badge ok">LTT – no renewal</span>';
  const cls = s.status === 'expired' ? 'danger' : s.status === 'due' ? 'warn' : 'ok';
  const txt = s.status === 'expired' ? `Expired ${-s.days_left} day${s.days_left === -1 ? '' : 's'} ago`
    : s.days_left === 0 ? 'Expires today' : `${s.days_left} day${s.days_left === 1 ? '' : 's'} left`;
  return `<b>${niceDate(s.upto)}</b><br><span class="badge ${cls}">${txt}</span>`;
};
const docAlertText = (a) => `<b>${esc(a.reg_no)}</b>: ${esc(DOC_SHORT[a.doc] || a.label)} ${a.status === 'expired'
  ? `<b>expired ${-a.days_left} day(s) ago</b>` : a.days_left === 0 ? '<b>expires today</b>' : `expires in ${a.days_left} day(s)`} (${niceDate(a.upto)})`;
/** Link to a vehicle's own page */
const vlink = (id, reg) => `<a class="vlink" href="#/vehicle/${encodeURIComponent(id)}">${esc(reg)}</a>`;
const sourceBadge = (r) => (r.source === 'loyverse' ? '<span class="badge src-pos" title="Imported from Loyverse POS">🧾 Loyverse</span>' : '');
const fuelBadge = (t) => `<span class="badge fuel-${esc(t)}">${FUEL[t]?.icon || ''} ${esc(t)}</span>`;
/** "13 kg CNG · 20 L Petrol" from [{fuel_type, quantity, unit}] */
const fuelList = (rows) => (rows || []).filter((r) => r.quantity > 0).map((r) => `${fmt(r.quantity, 2)} ${esc(r.unit)} ${esc(r.fuel_type)}`).join('<br>') || '—';
const STATUS_LABEL = { reported: 'Reported', in_review: 'In review', insurance_claimed: 'Insurance claimed', closed: 'Closed' };

const state = { user: null, vehicles: [] };

// ------------------------------------------------------------------ api
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user && path !== '/api/login' && path !== '/api/me') { state.user = null; render(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3200);
}

// ------------------------------------------------------------------ photos
/** Resize + compress a photo in the browser so uploads stay small on mobile data. */
function compressImage(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

/** Photo picker field. Returns HTML; wire with bindPhotoPickers(form). */
function photoField(name, label, { multiple = false, required = false } = {}) {
  return `<div class="full"><label><span>${esc(label)}${required ? ' *' : ''}</span></label>
    <div class="photos" data-photos="${name}" data-multiple="${multiple}">
      <label class="photo-btn" title="Take / choose photo">📷
        <input type="file" accept="image/*" capture="environment" ${multiple ? 'multiple' : ''}></label>
    </div></div>`;
}
function bindPhotoPickers(form) {
  form._photos = {};
  for (const box of $$('[data-photos]', form)) {
    const name = box.dataset.photos;
    const multiple = box.dataset.multiple === 'true';
    form._photos[name] = [];
    const input = $('input[type=file]', box);
    const redraw = () => {
      $$('.ph', box).forEach((n) => n.remove());
      form._photos[name].forEach((src, i) => {
        const d = document.createElement('div');
        d.className = 'ph';
        d.innerHTML = `<img src="${src}" alt=""><button type="button" aria-label="Remove">✕</button>`;
        d.querySelector('button').onclick = () => { form._photos[name].splice(i, 1); redraw(); };
        box.insertBefore(d, box.lastElementChild);
      });
      box.lastElementChild.style.display = !multiple && form._photos[name].length ? 'none' : '';
    };
    input.onchange = async () => {
      try {
        for (const f of [...input.files].slice(0, 8)) {
          const data = await compressImage(f);
          if (multiple) form._photos[name].push(data); else form._photos[name] = [data];
        }
      } catch (e) { toast(e.message, true); }
      input.value = '';
      redraw();
    };
  }
}

function lightbox(src) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = `<img src="${esc(src)}" alt="">`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}
document.addEventListener('click', (e) => {
  const img = e.target.closest('img.thumb');
  if (img) lightbox(img.src);
});
const thumb = (file) => (file ? `<img class="thumb" src="/uploads/${esc(file)}" alt="photo" loading="lazy">` : '');

// ------------------------------------------------------------------ form helpers
const formData = (form) => Object.fromEntries(new FormData(form).entries());
async function submitting(form, fn) {
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}
function vehicleSelect(name = 'vehicle_id', { includeAll = false } = {}) {
  const activeVehicles = state.vehicles.filter((v) => v.active);
  const mine = state.vehicles.find((v) => v.assigned_driver_id === state.user.id) || (activeVehicles.length === 1 ? activeVehicles[0] : null);
  return `<select name="${name}" ${includeAll ? '' : 'required'}>
    ${includeAll ? '<option value="">All vehicles</option>' : '<option value="">Select vehicle</option>'}
    ${state.vehicles.filter((v) => includeAll || v.active).map((v) =>
      `<option value="${v.id}" ${!includeAll && mine?.id === v.id ? 'selected' : ''}>${esc(v.reg_no)}${v.model ? ' – ' + esc(v.model) : ''}</option>`).join('')}
  </select>`;
}
/** Pre-fill the odometer with the vehicle's last known reading whenever the vehicle changes. */
function bindOdometer(form, field = 'odometer') {
  const sel = $('select[name=vehicle_id]', form);
  const input = $(`input[name=${field}]`, form);
  const hint = $(`[data-hint=${field}]`, form);
  const update = () => {
    const v = state.vehicles.find((x) => String(x.id) === sel.value);
    if (hint) hint.textContent = v ? `Last recorded: ${fmt(v.current_km)} km` : '';
    if (input && v && !input.dataset.touched) input.placeholder = v.current_km;
  };
  input?.addEventListener('input', () => (input.dataset.touched = '1'));
  sel.addEventListener('change', update);
  update();
}
const kmField = (name, label, extra = '') =>
  `<label><span>${label} *</span><input name="${name}" type="number" inputmode="decimal" step="0.1" min="0" required ${extra}>
   <small class="muted" data-hint="${name}"></small></label>`;
async function refreshVehicles() { state.vehicles = await api('/api/vehicles'); }

function filtersBar(id, { dates = true, extra = '' } = {}) {
  return `<form class="filters" id="${id}">
    ${state.user.role === 'admin' ? `<label><span>Driver</span><select name="driver"><option value="">All drivers</option>${
      (state.drivers || []).filter((d) => d.role === 'driver').map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>` : ''}
    <label><span>Vehicle</span>${vehicleSelect('vehicle', { includeAll: true })}</label>
    ${extra}
    ${dates ? `<label><span>From</span><input type="date" name="from"></label><label><span>To</span><input type="date" name="to"></label>` : ''}
    <div class="row"><button type="submit">Filter</button><a class="btn" data-export>⬇ CSV</a></div>
  </form>`;
}
function bindFilters(form, kind, load) {
  const qs = () => new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v)).toString();
  const exportLink = $('[data-export]', form);
  const sync = () => (exportLink.href = `/api/export/${kind}.csv?${qs()}`);
  form.onsubmit = (e) => { e.preventDefault(); sync(); load(qs()); };
  form.onchange = sync;
  sync();
  load('');
}
const delBtn = (kind, id) => (state.user.role === 'admin' ? `<button class="small danger" data-del="${kind}:${id}">Delete</button>` : '');
function bindDeletes(root, reload) {
  for (const b of $$('[data-del]', root)) {
    b.onclick = async () => {
      if (!confirm('Delete this record permanently?')) return;
      const [kind, id] = b.dataset.del.split(':');
      try { await api(`/api/${kind}/${id}`, { method: 'DELETE' }); toast('Deleted'); reload(); } catch (e) { toast(e.message, true); }
    };
  }
}

// ------------------------------------------------------------------ pages
const pages = {};

pages.dashboard = async (main) => {
  const d = await api('/api/dashboard');
  const isAdmin = state.user.role === 'admin';
  const alerts = d.vehicles.filter((v) => v.oil_status === 'overdue' || v.oil_status === 'due_soon');
  const max = Math.max(1, ...d.daily.map((x) => x.km));
  main.innerHTML = `
    <h1>${isAdmin ? 'Fleet dashboard' : `Hello, ${esc(state.user.name)}`}</h1>
    ${alerts.map((v) => `<div class="alert ${v.oil_status === 'overdue' ? 'danger' : 'warn'}">
      🛢 <b>${esc(v.reg_no)}</b>: oil change ${v.oil_status === 'overdue'
        ? `<b>overdue by ${fmt(-v.oil_remaining_km)} km</b>` : `due in ${fmt(v.oil_remaining_km)} km`} (at ${fmt(v.oil_due_km)} km)</div>`).join('')}
    ${pushSupported() && Notification.permission === 'default' ? `<div class="alert" style="border-color:var(--brand-2)">🔔 Get reminders for insurance, PUC, fitness and warranty dates
      on this ${/Android|iPhone/.test(navigator.userAgent) ? 'phone' : 'device'}. <a href="#/notifications">Turn on notifications</a></div>` : ''}
    ${(d.checks_today || []).filter((c) => !c.done && (isAdmin || c.assigned_driver_id === state.user.id)).length && !isAdmin
      ? `<div class="alert warn">✅ Daily oil &amp; coolant check not done yet today. <a href="#/trips">Check now</a></div>` : ''}
    ${(d.fluid_alerts || []).map((c) => `<div class="alert ${c.oil === 'low' ? 'danger' : 'warn'}">🛢 <b>${esc(c.reg_no)}</b>: ${[c.oil === 'low' ? 'engine oil LOW' : '',
      c.coolant === 'low' ? 'coolant LOW' : ''].filter(Boolean).join(' and ')} (${niceDate(c.date)})${c.notes ? ` – ${esc(c.notes)}` : ''}</div>`).join('')}
    ${(d.part_alerts || []).map((p) => {
      const byKm = p.km_state === 'expired' || (p.km_state === 'due' && p.date_state !== 'expired');
      const what = `${esc(p.kind === 'battery' ? 'Battery' : p.name)}${p.serial_no ? ` (S/N ${esc(p.serial_no)})` : ''}`;
      const txt = byKm
        ? `${what} ${p.kind === 'battery' || p.kind === 'tyre' ? 'change' : 'replacement'} ${p.km_left <= 0 ? `<b>OVERDUE by ${fmt(-p.km_left)} km</b>` : `due in <b>${fmt(p.km_left)} km</b>`} (at ${fmt(p.due_km)} km)`
        : `${what} ${p.kind === 'battery' ? 'warranty ' : ''}${p.days_left < 0 ? `<b>expired ${-p.days_left} day(s) ago</b>` : `expires in ${p.days_left} day(s)`} (${niceDate(p.expiry_date)})`;
      return `<div class="alert ${p.state === 'expired' ? 'danger' : 'warn'}">${p.kind === 'tyre' ? '🛞' : '🔋'} <b>${esc(p.reg_no)}</b>: ${txt} · <a href="#/vehicle/${p.vehicle_id}">View</a></div>`;
    }).join('')}
    ${d.complaints_open ? `<div class="alert ${d.complaints_high ? 'danger' : 'warn'}">📣 ${d.complaints_open} open complaint(s)${
      d.complaints_high ? `, <b>${d.complaints_high} high priority</b>` : ''}. <a href="#/complaints">View</a></div>` : ''}
    ${(d.doc_alerts || []).map((a) => `<div class="alert ${a.status === 'expired' ? 'danger' : 'warn'}">📄 ${docAlertText(a)}${
      isAdmin ? ' · <a href="#/documents">Documents</a>' : ''}</div>`).join('')}
    ${d.pos_unmatched ? `<div class="alert warn">🧾 ${d.pos_unmatched} Loyverse fuel sale(s) need a vehicle. <a href="#/loyverse">Assign</a></div>` : ''}
    ${d.open_accidents ? `<div class="alert danger">⚠️ ${d.open_accidents} accident report(s) not closed. <a href="#/accidents">View</a></div>` : ''}
    <div class="grid">
      <div class="stat"><div class="v">${fmt(d.today.km, 1)}</div><div class="l">km today</div></div>
      <div class="stat"><div class="v">${fmt(isAdmin ? d.month.fleet_km : d.month.km, 1)}</div><div class="l">km this month</div></div>
      ${d.month.fuel.filter((x) => x.quantity > 0).map((x) => `<div class="stat"><div class="v">${fmt(x.quantity, 2)} ${esc(x.unit)}</div>
        <div class="l">${FUEL[x.fuel_type]?.icon || ''} ${esc(x.fuel_type)} this month · ${money(x.amount)}</div></div>`).join('')}
      <div class="stat"><div class="v">${money(d.month.fuel_amount)}</div><div class="l">Fuel &amp; charging spend this month</div></div>
      <div class="stat"><div class="v">${d.month.cost_per_km !== null ? money(d.month.cost_per_km) : '—'}</div><div class="l">Fuel cost / km</div></div>
      <div class="stat"><div class="v">${money(d.month.service_cost)}</div><div class="l">Service spend this month</div></div>
      <div class="stat"><div class="v">${d.month.accidents}</div><div class="l">Accidents this month</div></div>
      ${isAdmin && (d.checks_today || []).length ? `<div class="stat"><div class="v">${d.checks_today.filter((c) => c.done).length}/${d.checks_today.length}</div>
        <div class="l">Daily oil &amp; coolant checks today · <a href="#/trips">see</a></div></div>` : ''}
    </div>
    <div class="card"><h2>Kilometers – last 14 days</h2>
      ${d.daily.length ? `<div class="bars">${d.daily.map((x) => `<div class="b" title="${x.date}: ${fmt(x.km, 1)} km">
        <small>${fmt(x.km)}</small><i style="height:${(x.km / max) * 100}%"></i><span>${x.date.slice(8)}</span></div>`).join('')}</div>`
        : '<p class="muted">No completed trips yet.</p>'}
    </div>
    ${d.active_trips.length ? `<div class="card"><div class="row"><h2 style="margin:0">On the road now</h2><span class="spacer"></span>
      ${isAdmin ? '<a class="btn small primary" href="#/live">📍 Live map</a>' : ''}</div><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Driver</th><th>Started</th><th>Start km</th></tr>
      ${d.active_trips.map((t) => `<tr><td>${esc(t.reg_no)}</td><td>${esc(t.driver_name)}</td><td>${esc(t.started_at)} UTC</td><td>${fmt(t.start_km)}</td></tr>`).join('')}
      </table></div></div>` : ''}
    <div class="card"><h2>Vehicles</h2><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Driver</th><th>Odometer</th><th>Month km</th><th>Month fuel</th><th>Mileage</th><th>Oil change</th></tr>
      ${d.vehicles.map((v) => `<tr><td><b>${vlink(v.id, v.reg_no)}</b><br><small class="muted">${esc(v.model)}</small><br>${fuelBadge(primaryFuel(v.fuel_type))}</td>
        <td>${esc(v.driver_name || '—')}</td><td>${fmt(v.current_km)} km</td><td>${monthKmCell(v)}</td>
        <td>${fuelList(v.month_fuel)}<br><small class="muted">${money(v.month_fuel_amount)}</small></td>
        <td>${v.mileage ? fmt(v.mileage, 2) + ' ' + esc(v.mileage_unit) : '—'}</td>
        <td>${oilBadge(v)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No vehicles yet.</td></tr>'}
      </table></div></div>
    ${d.recent_accidents.length ? `<div class="card"><h2>Recent accidents</h2>${accidentTable(d.recent_accidents)}</div>` : ''}
    ${!isAdmin ? `<div class="row"><a class="btn" href="#/trips">🚗 Daily km</a><a class="btn" href="#/fuel">⛽ Fuel / charge</a>
      <a class="btn" href="#/services">🛢 Service</a><a class="btn" href="#/accidents">⚠️ Accident</a></div>` : ''}`;
};
const oilBadge = (v) => {
  if (v.oil_status === 'na') return '<span class="badge">Not needed (EV)</span>';
  const cls = v.oil_status === 'overdue' ? 'danger' : v.oil_status === 'due_soon' ? 'warn' : 'ok';
  const txt = v.oil_status === 'overdue' ? `Overdue ${fmt(-v.oil_remaining_km)} km` : `${fmt(v.oil_remaining_km)} km left`;
  return `<span class="badge ${cls}">${txt}</span><br><small class="muted">due at ${fmt(v.oil_due_km)} km</small>`;
};

// --- daily kilometers
pages.trips = async (main) => {
  await refreshVehicles();
  const open = await api('/api/trips/open');
  const checks = await api('/api/checks/today');
  main.innerHTML = `<h1>Daily kilometers</h1>
    ${checksTodayCard(state.user.role === 'admin' ? checks : checks.filter((c) => c.assigned_driver_id === state.user.id).length
      ? checks.filter((c) => c.assigned_driver_id === state.user.id) : checks)}
    ${open.map((t) => `<div class="card"><h2>🟢 Trip in progress – ${esc(t.reg_no)}</h2>
      <p class="muted">Started ${esc(t.date)} at <b>${fmt(t.start_km)} km</b>. Enter the odometer reading at the end of the day.</p>
      <form data-end="${t.id}"><div class="fields">
        ${kmField('end_km', 'Ending kilometer (odometer)', `min="${t.start_km}"`)}
        <label class="full"><span>Notes</span><textarea name="notes" placeholder="Route, toll, remarks…"></textarea></label>
        ${photoField('end_photo', 'Photo of odometer (end)')}
      </div><div class="actions"><button class="primary" type="submit">End trip</button></div></form></div>`).join('')}
    ${open.length ? '' : `<div class="card"><h2>Start your day</h2>
      <form id="start"><div class="fields">
        <label><span>Vehicle *</span>${vehicleSelect()}</label>
        <label><span>Date *</span><input type="date" name="date" value="${today()}" required></label>
        ${kmField('start_km', 'Starting kilometer (odometer)')}
        ${photoField('start_photo', 'Photo of odometer (start)')}
        <p class="full muted" style="margin:0">📍 When you start, your location is shared with the admin <b>only while this trip is running</b> (until End trip).
          Allow location when the phone asks, and keep the app open on screen while driving –
          or set up <a href="#/profile">background location (screen off)</a> once.</p>
      </div><div class="actions"><button class="primary" type="submit">Start trip</button></div></form></div>`}
    <div class="card"><h2>History</h2>${filtersBar('flt')}<div id="list"></div></div>`;

  for (const f of $$('form[data-end]', main)) {
    bindPhotoPickers(f);
    f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
      await flushGps();
      const pos = await getPosition(8000);
      const r = await api(`/api/trips/${f.dataset.end}/end`, { method: 'PUT', body: { ...formData(f), end_photo: f._photos.end_photo[0],
        ...(pos ? { end_lat: pos.coords.latitude, end_lng: pos.coords.longitude, end_accuracy: Math.round(pos.coords.accuracy) } : {}) } });
      await flushGps();
      if (String(tracker.tripId) === f.dataset.end) stopTracking(!tracker.queue.length);
      stopNativeTracking();
      toast(`Trip ended – ${fmt(r.distance_km, 1)} km driven. Location sharing stopped.`); route();
    }); };
  }
  const start = $('#start', main);
  if (start) {
    bindPhotoPickers(start); bindOdometer(start, 'start_km');
    start.onsubmit = (e) => { e.preventDefault(); submitting(start, async () => {
      const pos = await getPosition();
      const r = await api('/api/trips', { method: 'POST', body: { ...formData(start), start_photo: start._photos.start_photo[0],
        ...(pos ? { start_lat: pos.coords.latitude, start_lng: pos.coords.longitude, start_accuracy: Math.round(pos.coords.accuracy) } : {}) } });
      const reg = start.vehicle_id.selectedOptions[0]?.textContent.split(' – ')[0] || '';
      await startTripTracking(r.id, reg);
      toast(pos ? 'Trip started – location sharing is on. Drive safe!' : 'Trip started. Location was not shared – allow location to track the route.', !pos);
      route();
    }); };
  }
  const load = async (qs) => {
    const rows = await api('/api/trips?' + qs);
    const total = rows.reduce((s, r) => s + (r.distance_km || 0), 0);
    $('#list', main).innerHTML = `<p class="muted">${rows.length} trips · <b>${fmt(total, 1)} km</b> total</p><div class="table-wrap"><table>
      <tr><th>Date</th><th>Vehicle</th>${state.user.role === 'admin' ? '<th>Driver</th>' : ''}<th>Start km</th><th>End km</th><th>Distance</th><th>Photos</th><th>Notes</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.reg_no)}</td>${state.user.role === 'admin' ? `<td>${esc(r.driver_name)}</td>` : ''}
        <td>${fmt(r.start_km)}</td><td>${r.end_km === null ? '<span class="badge warn">open</span>' : fmt(r.end_km)}</td>
        <td><b>${r.distance_km === null ? '—' : fmt(r.distance_km, 1) + ' km'}</b></td>
        <td>${thumb(r.start_photo)} ${thumb(r.end_photo)}</td><td class="wrap">${esc(r.notes)}</td>
        <td style="white-space:nowrap">${r.gps_points ? `<a class="btn small" href="#/trip-map/${r.id}">🗺 Route</a> ` : ''}${delBtn('trips', r.id)}</td></tr>`).join('')}
      </table></div>`;
    bindDeletes($('#list', main), () => load(qs));
  };
  bindFilters($('#flt', main), 'trips', load);
  bindCheckButtons(main, checks);
};

// --- fuel & charging (CNG / Petrol / Diesel / EV)
pages.fuel = async (main) => {
  await refreshVehicles();
  main.innerHTML = `<h1>Fuel &amp; charging</h1>
    <div class="card"><h2 id="ftitle">Add fill</h2><form id="f"><div class="fields">
      <label><span>Vehicle *</span>${vehicleSelect()}</label>
      <div class="full"><label><span>Fuel type *</span></label><div class="seg" role="radiogroup">
        ${Object.keys(FUEL).map((k) => `<label><input type="radio" name="fuel_type" value="${k}"><span>${FUEL[k].icon} ${k}</span></label>`).join('')}
      </div></div>
      <label><span>Date *</span><input type="date" name="date" value="${today()}" required></label>
      ${kmField('odometer', 'Odometer (km)')}
      <div class="full alert" id="evhelp" style="display:none;margin:0">⚡ <b>EV:</b> just enter the <b>odometer</b> – that is enough to track km driven.
        Fill in kWh and cost only if you charged at a paid charger (needed for km/kWh and cost).</div>
      <label><span data-l="qty">Quantity *</span><input name="quantity" type="number" inputmode="decimal" step="0.01" min="0.01" required></label>
      <label><span data-l="price">Price per unit (₹)</span><input name="price_per_unit" type="number" inputmode="decimal" step="0.01" min="0"></label>
      <label><span>Total amount (₹)</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="auto = qty × price"></label>
      <label><span data-l="station">Station</span><input name="station"></label>
      <label data-ev><span>Battery % before</span><input name="battery_start_pct" type="number" inputmode="numeric" min="0" max="100"></label>
      <label data-ev><span>Battery % after</span><input name="battery_end_pct" type="number" inputmode="numeric" min="0" max="100"></label>
      <label class="full"><span>Notes</span><textarea name="notes"></textarea></label>
      ${photoField('photo', 'Bill / meter photo')}
    </div><div class="actions"><button class="primary" type="submit" id="fsave">Save</button></div></form></div>
    <div class="card"><h2>History</h2>${filtersBar('flt', { extra: `<label><span>Fuel</span><select name="fuel_type"><option value="">All fuels</option>${
      Object.keys(FUEL).map((k) => `<option>${k}</option>`).join('')}</select></label>` })}<div id="list"></div></div>`;
  const f = $('#f', main);
  bindPhotoPickers(f); bindOdometer(f);
  const qty = $('[name=quantity]', f), price = $('[name=price_per_unit]', f), amt = $('[name=amount]', f);
  const calc = () => { if (qty.value && price.value && !amt.dataset.touched) amt.value = (qty.value * price.value).toFixed(2); };
  qty.oninput = calc; price.oninput = calc; amt.oninput = () => (amt.dataset.touched = amt.value ? '1' : '');
  // Update labels/units for the chosen fuel
  const applyFuel = () => {
    const t = f.fuel_type.value || 'CNG', F = FUEL[t];
    const ev = t === 'EV';
    $('[data-l=qty]', f).textContent = ev ? 'Energy charged (kWh) – optional' : `Quantity (${F.unit}) *`;
    qty.required = !ev;
    $('#evhelp', main).style.display = ev ? '' : 'none';
    $('[data-l=price]', f).textContent = `Price per ${F.unit} (₹)`;
    $('[data-l=station]', f).textContent = F.station;
    f.station.placeholder = F.placeholder;
    $$('[data-ev]', f).forEach((el) => (el.style.display = t === 'EV' ? '' : 'none'));
    $('#ftitle', main).textContent = `Add ${F.noun}`;
    $('#fsave', main).textContent = `Save ${F.noun}`;
  };
  // Default the fuel type from the selected vehicle
  const pickFromVehicle = () => {
    const v = state.vehicles.find((x) => String(x.id) === f.vehicle_id.value);
    const t = primaryFuel(v?.fuel_type);
    const radio = $(`[name=fuel_type][value="${t}"]`, f);
    if (radio) radio.checked = true;
    applyFuel();
  };
  f.vehicle_id.addEventListener('change', pickFromVehicle);
  $$('[name=fuel_type]', f).forEach((r) => (r.onchange = applyFuel));
  pickFromVehicle();
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/fuel', { method: 'POST', body: { ...formData(f), photo: f._photos.photo[0] } });
    toast(`${FUEL[f.fuel_type.value].noun[0].toUpperCase() + FUEL[f.fuel_type.value].noun.slice(1)} saved`); route();
  }); };
  const load = async (qs) => {
    const rows = await api('/api/fuel?' + qs);
    const totals = {};
    for (const r of rows) {
      totals[r.fuel_type] ??= { fuel_type: r.fuel_type, unit: r.unit, quantity: 0 };
      totals[r.fuel_type].quantity += r.quantity;
      totals[r.fuel_type].readings = (totals[r.fuel_type].readings || 0) + 1;
    }
    const amount = rows.reduce((s, r) => s + r.amount, 0);
    $('#list', main).innerHTML = `<p class="muted">${rows.length} records · ${Object.values(totals).map((t) => (t.quantity > 0 ? `<b>${fmt(t.quantity, 2)} ${esc(t.unit)}</b> ${esc(t.fuel_type)}` : `<b>${t.readings}</b> EV reading(s)`)).join(' · ') || '—'} · <b>${money(amount)}</b></p>
      <div class="table-wrap"><table>
      <tr><th>Date</th><th>Vehicle</th><th>Fuel</th>${state.user.role === 'admin' ? '<th>Driver</th>' : ''}<th>Odometer</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Station</th><th>Photo</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${vlink(r.vehicle_id, r.reg_no)}</td><td>${fuelBadge(r.fuel_type)}<br>${sourceBadge(r)}</td>
        ${state.user.role === 'admin' ? `<td>${esc(r.driver_name)}</td>` : ''}
        <td>${odoCell(r)}</td><td>${r.quantity > 0 ? `${fmt(r.quantity, 2)} ${esc(r.unit)}` : '<small class="muted">📍 odometer only</small>'}${r.fuel_type === 'EV' && r.battery_end_pct !== null
          ? `<br><small class="muted">🔋 ${r.battery_start_pct ?? '?'}% → ${r.battery_end_pct}%</small>` : ''}</td>
        <td>${r.price_per_unit ? `₹${fmt(r.price_per_unit, 2)}/${esc(r.unit)}` : '—'}</td><td><b>${r.amount ? money(r.amount) : '—'}</b></td>
        <td>${esc(r.station)}</td><td>${thumb(r.photo)}</td><td>${delBtn('fuel', r.id)}</td></tr>`).join('')}
      </table></div>`;
    bindDeletes($('#list', main), () => load(qs));
    bindOdoButtons($('#list', main), () => load(qs));
  };
  bindFilters($('#flt', main), 'fuel', load);
};

// Fills without an odometer reading (Loyverse imports) get an "Add km" button
const odoCell = (r) => (r.odometer === null || r.odometer === undefined
  ? `<button class="small" data-odo="${r.id}" title="Add the odometer reading for this fill">➕ Add km</button>` : fmt(r.odometer));
function bindOdoButtons(root, reload) {
  for (const b of $$('[data-odo]', root)) b.onclick = async () => {
    const km = prompt('Odometer reading (km) at this fill:');
    if (km === null || km.trim() === '') return;
    try { await api(`/api/fuel/${b.dataset.odo}/odometer`, { method: 'PUT', body: { odometer: km.trim() } }); toast('Odometer saved'); reload(); }
    catch (e) { toast(e.message, true); }
  };
}

// --- one vehicle: profile with tabs (everyone; details editable by drivers and admin)
const VTABS = [['overview', '🏠 Overview'], ['details', '🪪 Details & papers'], ['upkeep', '🔧 Upkeep'], ['usage', '⛽ Fuel & km'], ['issues', '📣 Complaints & accidents']];
const vPhoto = (photo, fuel, cls = 'vphoto') => `<div class="${cls}">${photo
  ? `<img src="/uploads/${encodeURIComponent(photo)}" alt="Vehicle photo" loading="lazy">` : `<span aria-hidden="true">${fuel === 'EV' ? '⚡' : '🚐'}</span>`}</div>`;
const chip = (cls, text) => `<span class="chip ${cls}">${text}</span>`;
const daysText = (n) => (n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`);
const dateTime = (iso) => new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Status chips from the /api/fleet shape */
function fleetChips(v) {
  const out = [];
  for (const k of v.papers_expired) out.push(chip('danger', `${DOC_SHORT[k]} expired`));
  for (const p of v.papers_due) out.push(chip('warn', `${DOC_SHORT[p.doc]} ${daysText(p.days_left)}`));
  if (!v.papers_expired.length && !v.papers_due.length) out.push(v.papers_known ? chip('ok', '📄 Papers OK') : chip('', '📄 Papers not added'));
  if (v.oil_status === 'overdue') out.push(chip('danger', '🛢 Oil change overdue'));
  else if (v.oil_status === 'due_soon') out.push(chip('warn', `🛢 Oil change in ${fmt(v.oil_remaining_km)} km`));
  if (v.battery?.km_state === 'expired') out.push(chip('danger', `🔋 Battery change OVERDUE ${fmt(-v.battery.km_left)} km`));
  else if (v.battery?.km_state === 'due') out.push(chip('warn', `🔋 Battery change in ${fmt(v.battery.km_left)} km`));
  if (v.battery?.state === 'due') out.push(chip('warn', `🔋 Battery warranty ${daysText(v.battery.days_left)}`));
  if (v.check_today.done) out.push(v.check_today.low ? chip('danger', '🔴 Oil/coolant LOW') : chip('ok', '✅ Checked today'));
  else if (v.active) out.push(chip('', '⏳ Not checked today'));
  if (v.open_complaints) out.push(chip('warn', `📣 ${v.open_complaints} open complaint${v.open_complaints === 1 ? '' : 's'}`));
  return out.join('');
}
const needsAttention = (v) => v.papers_expired.length || v.papers_due.length || ['overdue', 'due_soon'].includes(v.oil_status)
  || v.battery?.state === 'due' || ['due', 'expired'].includes(v.battery?.km_state) || (v.check_today.done && v.check_today.low) || v.open_complaints;

// --- Vehicles: everyone sees all vehicles as cards; the admin also manages the fleet here
pages.vehicles = async (main) => {
  const admin = state.user.role === 'admin';
  const list = await api('/api/fleet');
  const att = list.filter(needsAttention).length;
  const mine = list.filter((v) => v.assigned_driver_id === state.user.id).length;
  main.innerHTML = `<div class="row"><h1 style="margin:0">🚐 Vehicles</h1><span class="spacer"></span>
      ${admin ? '<button class="primary" id="addv">➕ Add vehicle</button>' : ''}</div>
    <div class="row" style="margin:14px 0">
      <input id="vsearch" type="search" placeholder="🔍 Search number, model, driver, colour…" style="flex:1;min-width:220px">
      <div class="seg" id="vfilter" style="margin:0">
        <label><input type="radio" name="vf" value="all" checked><span>All (${list.length})</span></label>
        <label><input type="radio" name="vf" value="att"><span>⚠️ Needs attention (${att})</span></label>
        ${mine ? `<label><input type="radio" name="vf" value="mine"><span>👤 Mine (${mine})</span></label>` : ''}
      </div></div>
    <div class="vgrid" id="vgrid">${list.map((v) => `<a class="vcard${v.active ? '' : ' inactive'}" href="#/vehicle/${v.id}"
        data-text="${esc([v.reg_no, v.model, v.maker_model, v.driver_name, v.color, v.fuel_type].filter(Boolean).join(' ').toLowerCase())}"
        data-att="${needsAttention(v) ? 1 : 0}" data-mine="${v.assigned_driver_id === state.user.id ? 1 : 0}">
        ${vPhoto(v.photo, v.main_fuel)}
        <div class="vbody">
          <div class="row" style="gap:6px"><b class="vreg">${esc(v.reg_no)}</b>${fuelBadge(v.main_fuel)}${v.active ? '' : '<span class="badge">inactive</span>'}</div>
          <div class="muted small">${esc(v.model || v.maker_model || '—')}${v.color ? ` · ${esc(v.color)}` : ''}${v.seating ? ` · ${esc(v.seating)} seats` : ''}</div>
          <div class="small">👤 ${esc(v.driver_name || 'No driver')} · 🛣 ${fmt(v.current_km)} km</div>
          <div class="chips">${fleetChips(v)}</div>
        </div></a>`).join('') || '<p class="muted">No vehicles yet.</p>'}</div>
    <p class="muted" id="vnone" style="display:none">No vehicles match.</p>
    ${admin ? `<details class="card" id="manage" ${list.length ? '' : 'open'}><summary><b>⚙️ Manage fleet</b>
      <span class="muted">– add vehicles, assign drivers, fuel, oil interval, active</span></summary><div id="managebox"></div></details>` : ''}`;
  const apply = () => {
    const q = $('#vsearch', main).value.trim().toLowerCase();
    const mode = ($('[name=vf]:checked', main) || {}).value;
    let shown = 0;
    for (const c of $$('.vcard', main)) {
      const ok = (!q || c.dataset.text.includes(q)) && (mode !== 'att' || c.dataset.att === '1') && (mode !== 'mine' || c.dataset.mine === '1');
      c.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    $('#vnone', main).style.display = shown || !list.length ? 'none' : '';
  };
  $('#vsearch', main).oninput = apply;
  $('#vfilter', main).onchange = apply;
  if (admin) {
    await manageVehicles($('#managebox', main));
    $('#addv', main).onclick = () => {
      const box = $('#manage', main);
      box.open = true;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('#managebox [name=reg_no]', main)?.focus(), 300);
    };
  }
};

/** Key facts table for the overview tab */
function keyFacts(doc, battery, id) {
  const d = doc.docs || {};
  const row = (label, html) => `<tr><th>${label}</th><td>${html}</td></tr>`;
  const rows = [
    ...DOCS.filter(([k]) => d[k]?.upto).map(([k, l]) => row(l, `${docCell(d[k]).replace('<br>', ' ')}${k === 'insurance' && doc.insurance_company ? ` <small class="muted">${esc(doc.insurance_company)}</small>` : ''}`)),
    battery ? row('🔋 Battery', `${esc([battery.brand, battery.serial_no && `S/N ${battery.serial_no}`].filter(Boolean).join(' · ') || 'Battery')}${
      battery.expiry_date ? ` – warranty till ${partExpiry(battery).replace('<br>', ' ')}` : ''}${partKm(battery).replace('<br>', ' ')}`) : '',
    doc.registration_date ? row('Registered', `${niceDate(doc.registration_date)}${doc.registered_at ? ` · ${esc(doc.registered_at)}` : ''}`) : '',
    doc.chassis_no ? row('Chassis no.', esc(doc.chassis_no)) : '',
    doc.engine_no ? row('Engine no.', esc(doc.engine_no)) : '',
    doc.owner_name ? row('Owner', esc(doc.owner_name)) : '',
  ].filter(Boolean).join('');
  return `<div class="card"><div class="row"><h2 style="margin:0">📋 Key facts</h2><span class="spacer"></span>
      <a class="btn small" href="#/vehicle-edit/${id}">✏️ ${rows ? 'Edit' : 'Add details'}</a></div>
    ${rows ? `<div class="table-wrap" style="margin-top:8px"><table class="facts">${rows}</table></div>`
      : '<p class="muted">No insurance, PUC, fitness, battery or RC details yet. Anyone can add them with <b>Edit details</b>.</p>'}</div>`;
}
function historyCard(log, limit = 50, more = false) {
  const items = (log || []).slice(0, limit);
  return `<div class="card"><h2>🕘 Change history</h2>${items.length ? `<ul class="history">${items.map((l) => `<li>
      <small class="muted">${dateTime(l.at)} · <b>${esc(l.by_name || 'system')}</b></small><br>${esc(l.text)}</li>`).join('')}</ul>
      ${more && log.length > limit ? '<p><button class="small" data-tabgo="details">See full history</button></p>' : ''}`
    : '<p class="muted">No changes recorded yet.</p>'}</div>`;
}

pages.vehicle = async (main, id) => {
  const d = await api(`/api/vehicles/${encodeURIComponent(id)}/summary`);
  const v = d.vehicle, admin = state.user.role === 'admin', doc = d.documents || {};
  const missingOdo = d.fuel.filter((f) => f.odometer === null).length;
  const tab = VTABS.some(([k]) => k === state.vtab) ? state.vtab : 'overview';
  const battery = (d.parts || []).find((p) => p.kind === 'battery' && p.status === 'active');
  const docsS = doc.docs || {};
  const chipData = {
    papers_known: DOCS.filter(([k]) => docsS[k]?.upto).length,
    papers_expired: DOCS.filter(([k]) => docsS[k]?.status === 'expired').map(([k]) => k),
    papers_due: DOCS.filter(([k]) => docsS[k]?.status === 'due').map(([k]) => ({ doc: k, days_left: docsS[k].days_left })),
    oil_status: v.oil_status, oil_remaining_km: v.oil_remaining_km, active: v.active,
    battery: battery ? { state: battery.date_state, days_left: battery.days_left, km_state: battery.km_state, km_left: battery.km_left } : null,
    check_today: (() => { const c = (d.checks || []).find((x) => x.date === today()); return c ? { done: true, low: c.oil === 'low' || c.coolant === 'low' } : { done: false }; })(),
    open_complaints: (d.complaints || []).filter((c) => c.status === 'open' || c.status === 'in_progress').length,
  };
  const panel = (k, html) => `<section class="tabpanel" data-panel="${k}" role="tabpanel" ${k === tab ? '' : 'hidden'}>${html}</section>`;
  main.innerHTML = `
    <div class="row"><a class="btn small" href="#/vehicles">← All vehicles</a></div>
    <div class="card vhead" style="margin-top:12px">
      ${vPhoto(doc.vehicle_photo, v.main_fuel, 'vphoto vhead-photo')}
      <div class="vhead-info">
        <div class="row" style="gap:8px"><h1 style="margin:0">${esc(v.reg_no)}</h1>${fuelBadge(v.main_fuel)}${v.active ? '' : '<span class="badge">inactive</span>'}</div>
        <div class="muted">${esc(v.model || doc.maker_model || '')}${doc.color ? ` · ${esc(doc.color)}` : ''}${doc.seating ? ` · ${esc(doc.seating)} seats` : ''} · ${esc(v.fuel_type)}</div>
        <div>👤 Driver: <b>${esc(v.driver_name || '—')}</b>${v.driver_phone ? ` · <a href="tel:${esc(v.driver_phone)}">📞 ${esc(v.driver_phone)}</a>` : ''}
          · 🛣 <b>${fmt(v.current_km)}</b> km${v.loyverse_customer_id ? ' · 🧾 Loyverse' : ''}</div>
        <div class="chips">${fleetChips(chipData)}</div>
        <div class="row" style="margin-top:10px;gap:8px">
          <a class="btn small primary" href="#/vehicle-edit/${v.id}">✏️ Edit details</a>
          <button class="small" data-checkveh>✅ Daily check</button>
          <a class="btn small" href="#/fuel">⛽ Add fuel</a>
          <button class="small" data-newc>📣 Raise complaint</button>
        </div>
      </div>
    </div>
    <div class="tabs" role="tablist">${VTABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>

    ${panel('overview', `
      ${['overdue', 'due_soon'].includes(v.oil_status) ? `<div class="alert ${v.oil_status === 'overdue' ? 'danger' : 'warn'}">🛢 Oil change ${
        v.oil_status === 'overdue' ? `<b>overdue by ${fmt(-v.oil_remaining_km)} km</b>` : `due in ${fmt(v.oil_remaining_km)} km`}</div>` : ''}
      ${missingOdo ? `<div class="alert warn">${missingOdo} fuel record(s) have no odometer reading – see <b>Fuel &amp; km</b> and tap <b>➕ Add km</b>.</div>` : ''}
      <div class="grid">
        <div class="stat"><div class="v">${fmt(v.current_km)}</div><div class="l">Odometer (km)</div></div>
        <div class="stat"><div class="v">${v.mileage ? fmt(v.mileage, 2) : '—'}</div><div class="l">Mileage (${esc(v.mileage_unit)})${
          v.main_fuel === 'EV' && !v.mileage ? '<br><small>add kWh when charging to see this</small>' : ''}</div></div>
        <div class="stat"><div class="v">${fmt(Math.max(d.month_km, d.month_odometer_km), 1)}</div><div class="l">km this month${
          d.month_odometer_km > d.month_km ? ' (from odometer)' : ''}</div></div>
        <div class="stat"><div class="v">${money(d.month_fuel_amount)}</div><div class="l">Fuel this month<br>${fuelList(d.month_fuel)}</div></div>
        <div class="stat"><div class="v">${money(d.month_service_cost)}</div><div class="l">Service this month</div></div>
        <div class="stat"><div class="v" style="font-size:1rem">${oilBadge(v)}</div><div class="l">Oil change</div></div>
      </div>
      ${keyFacts(doc, battery, v.id)}
      <div class="card"><h2>All time</h2><p style="margin:0">${fmt(d.totals.km, 1)} km driven · ${money(d.totals.fuel_amount)} fuel · ${money(d.totals.service_cost)} service · ${d.totals.accidents} accident(s)</p></div>
      ${historyCard(d.log, 5, true)}`)}

    ${panel('details', `
      ${regCard(doc, true, v.id)}
      <div class="card"><div class="row"><h2 style="margin:0">📄 Documents</h2><span class="spacer"></span><a class="btn small" href="#/vehicle-edit/${v.id}">✏️ Edit</a></div>
        <div class="grid" style="margin:10px 0 0">${DOCS.map(([k, l]) => `<div class="stat"><div class="l">${l}</div><div style="margin-top:6px">${docCell(docsS[k])}</div>
          ${k === 'insurance' && doc.insurance_company ? `<small class="muted" style="overflow-wrap:anywhere">${esc(doc.insurance_company)}${doc.insurance_policy ? ' · ' + esc(doc.insurance_policy) : ''}</small>` : ''}
          ${k === 'pucc' && doc.pucc_number ? `<small class="muted">No. ${esc(doc.pucc_number)}</small>` : ''}
          ${doc[`${k}_file`] ? `<div style="margin-top:6px">${fileLink(doc[`${k}_file`])}</div>` : ''}</div>`).join('')}</div>
        <p class="muted" style="margin-bottom:0">${doc.fetched_at ? `Updated online ${dateTime(doc.fetched_at)}` : doc.source === 'manual' ? 'Entered by hand' : 'No document details yet'}${
          admin ? ' · <a href="#/documents">All vehicles\' documents</a>' : ''}</p></div>
      ${historyCard(d.log)}`)}

    ${panel('upkeep', `
      ${partsCard(d, admin)}${wheelsCard(d, admin)}${checksHistoryCard(d)}
      <div class="card"><h2>🛢 Service &amp; oil change</h2><div class="table-wrap"><table>
        <tr><th>Date</th><th>Type</th><th>Odometer</th><th>Next due</th><th>Cost</th><th>Garage</th><th>Details</th><th>Bill</th></tr>
        ${d.services.map((r) => `<tr><td>${esc(r.date)}</td><td>${SERVICE_LABEL[r.type] || esc(r.type)}</td><td>${fmt(r.odometer)}</td>
          <td>${fmt(r.next_due_km)}</td><td>${money(r.cost)}</td><td>${esc(r.garage)}</td><td class="wrap">${esc(r.notes)}</td><td>${thumb(r.photo)}</td></tr>`).join('')
          || '<tr><td colspan="8" class="muted">No service records yet.</td></tr>'}
      </table></div><p style="margin-bottom:0"><a class="btn small" href="#/services">+ Add service record</a></p></div>`)}

    ${panel('usage', `
      <div class="card"><div class="row"><h2 style="margin:0">⛽ Fuel &amp; charging <small class="muted">(last 30)</small></h2><span class="spacer"></span>
        <a class="btn small" href="#/reports/${v.id}">📊 Monthly report / PDF</a></div><div class="table-wrap" id="vfuel" style="margin-top:8px"><table>
        <tr><th>Date</th><th>Fuel</th><th>Odometer</th><th>Qty</th><th>Amount</th><th>Station</th><th>By</th><th>Bill</th></tr>
        ${d.fuel.map((r) => `<tr><td>${esc(r.date)}</td><td>${fuelBadge(r.fuel_type)} ${sourceBadge(r)}</td><td>${odoCell(r)}</td>
          <td>${r.quantity > 0 ? `${fmt(r.quantity, 2)} ${esc(r.unit)}` : '<small class="muted">📍 reading</small>'}</td><td><b>${r.amount ? money(r.amount) : '—'}</b></td><td>${esc(r.station)}</td><td>${esc(r.driver_name)}</td><td>${thumb(r.photo)}</td></tr>`).join('')
          || '<tr><td colspan="8" class="muted">No fuel records yet.</td></tr>'}
      </table></div></div>
      <div class="card"><h2>🚗 Daily km <small class="muted">(last 30)</small></h2><div class="table-wrap"><table>
        <tr><th>Date</th><th>Driver</th><th>Start</th><th>End</th><th>Distance</th><th>Photos</th></tr>
        ${d.trips.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.driver_name)}</td><td>${fmt(r.start_km)}</td>
          <td>${r.end_km === null ? '<span class="badge warn">open</span>' : fmt(r.end_km)}</td>
          <td><b>${r.distance_km === null ? '—' : fmt(r.distance_km, 1) + ' km'}</b></td><td>${thumb(r.start_photo)} ${thumb(r.end_photo)}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No trips yet.</td></tr>'}
      </table></div></div>`)}

    ${panel('issues', `
      <div class="card"><div class="row"><h2 style="margin:0">📣 Complaints</h2><span class="spacer"></span><button class="small" data-newc>+ Raise a complaint</button></div>
        <div style="margin-top:10px">${complaintTable(d.complaints || [], admin, { showVehicle: false })}</div></div>
      <div class="card"><h2>⚠️ Accidents</h2>${d.accidents.length ? accidentTable(d.accidents) : '<p class="muted">No accidents. 👍</p>'}
        <p style="margin-bottom:0"><a class="btn small" href="#/accidents">+ Report an accident</a></p></div>`)}`;

  const show = (k) => {
    state.vtab = k;
    $$('[data-tab]', main).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
    $$('[data-panel]', main).forEach((p) => (p.hidden = p.dataset.panel !== k));
  };
  $$('[data-tab]', main).forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  $$('[data-tabgo]', main).forEach((b) => (b.onclick = () => { show(b.dataset.tabgo); window.scrollTo(0, 0); }));
  bindOdoButtons(main, () => route());
  bindUpkeep(main, d);
};

// Scanned papers: photo thumbnail or PDF link
const fileLink = (f) => (!f ? '' : /\.pdf$/i.test(f)
  ? `<a class="btn small" href="/uploads/${encodeURIComponent(f)}" target="_blank" rel="noopener">📄 Open PDF</a>` : thumb(f));
const REG_FIELDS = [
  ['owner_name', 'Owner name'], ['maker_model', 'Make / model (as on RC)'], ['vehicle_class', 'Vehicle class', 'e.g. MOTOR CAR (LMV)'],
  ['registration_date', 'Registration date', '', 'date'], ['registered_at', 'Registered at (RTO)', 'e.g. CHENNAI (SOUTH) RTO'],
  ['chassis_no', 'Chassis number'], ['engine_no', 'Engine number'], ['manufacture', 'Manufactured (month/year)', 'MM/YYYY'],
  ['color', 'Colour'], ['seating', 'Seating capacity', '', 'number'], ['financer', 'Financer / hypothecation'], ['rc_status', 'RC status', 'ACTIVE'],
];
function regCard(docs, admin, id) {
  const rows = REG_FIELDS.filter(([k]) => docs?.[k]).map(([k, l]) => `<tr><th style="width:40%">${esc(l)}</th><td>${
    k === 'registration_date' ? niceDate(docs[k]) : esc(docs[k])}</td></tr>`).join('');
  if (!rows && !docs?.rc_file && !docs?.notes) {
    return `<div class="card"><h2>🪪 Registration details</h2><p class="muted">Not filled in yet. <a href="#/vehicle-edit/${id}">Add details</a></p></div>`;
  }
  return `<div class="card"><div class="row"><h2 style="margin:0">🪪 Registration details</h2><span class="spacer"></span>
    <a class="btn small" href="#/vehicle-edit/${id}">✏️ Edit</a></div>${rows ? `<div class="table-wrap" style="margin-top:8px"><table class="facts">${rows}</table></div>` : ''}
    ${docs.rc_file ? `<p><b>RC copy:</b> ${fileLink(docs.rc_file)}</p>` : ''}${docs.notes ? `<p class="muted">📝 ${esc(docs.notes)}</p>` : ''}</div>`;
}

/** File picker for a scanned paper (photo or PDF). Keeps the choice in form._files[name] (data URL, or null = remove). */
function paperField(name, label, current) {
  return `<div class="paper" data-paper="${name}"><span class="muted" style="font-size:.85rem">${esc(label)}</span>
    <div class="row" style="margin-top:4px"><span data-cur>${current ? fileLink(current) : '<small class="muted">no file</small>'}</span>
      <label class="btn small">📎 ${current ? 'Replace' : 'Add'} photo / PDF<input type="file" accept="image/*,application/pdf" hidden></label>
      ${current ? '<button type="button" class="small danger" data-rm>Remove</button>' : ''}</div></div>`;
}
function bindPaperFields(form) {
  form._files = {};
  for (const box of $$('[data-paper]', form)) {
    const name = box.dataset.paper, cur = $('[data-cur]', box);
    $('input[type=file]', box).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (file.type === 'application/pdf') {
          if (name === 'vehicle_photo') throw new Error('Choose a photo of the vehicle, not a PDF');
          if (file.size > 8 * 1024 * 1024) throw new Error('PDF must be under 8 MB');
          form._files[name] = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
          cur.innerHTML = `<small>📄 ${esc(file.name)} <span class="badge warn">not saved yet</span></small>`;
        } else {
          form._files[name] = await compressImage(file, 2000, 0.85);
          cur.innerHTML = `<img class="thumb" src="${form._files[name]}" alt=""> <span class="badge warn">not saved yet</span>`;
        }
      } catch (err) { toast(err.message, true); }
    };
    const rm = $('[data-rm]', box);
    if (rm) rm.onclick = () => { form._files[name] = null; cur.innerHTML = '<small class="muted">will be removed when you save</small>'; rm.remove(); };
  }
}

// --- edit everything about one vehicle by hand (drivers and admin; basics admin-only)
pages['vehicle-edit'] = async (main, id) => {
  const d = await api(`/api/vehicles/${encodeURIComponent(id)}/summary`);
  const v = d.vehicle, doc = d.documents || {};
  const admin = state.user.role === 'admin';
  const drivers = (state.drivers || []).filter((x) => x.role === 'driver' && (x.active || x.id === v.assigned_driver_id));
  const val = (k) => esc(doc[k] ?? '');
  const lifetimeTax = (doc.tax_upto || '').startsWith('9999');
  const field = ([k, l, ph = '', type = 'text']) => `<label><span>${esc(l)}</span><input name="${k}" type="${type}" value="${val(k)}" placeholder="${esc(ph)}"${type === 'number' ? ' min="1" max="100"' : ''}></label>`;
  main.innerHTML = `
    <div class="row"><a class="btn small" href="#/vehicle/${v.id}">← Back to ${esc(v.reg_no)}</a></div>
    <h1 style="margin-top:12px">✏️ ${esc(v.reg_no)} – vehicle details</h1>
    <p class="muted">Fill in what you have; everything is optional. Every change is saved in the vehicle's history with your name.
      ${doc.fetched_at ? 'Online updates fill in the same fields – typed values are kept where the lookup has nothing.' : ''}</p>
    <form id="vf">
      <div class="card"><h2>📷 Vehicle photo</h2>${paperField('vehicle_photo', 'A clear photo of the whole vehicle (shown on the Vehicles page)', doc.vehicle_photo)}</div>
      ${admin ? '' : `<div class="card"><h2>🚐 Basic</h2><p style="margin:0">${esc(v.model || '—')} · ${esc(v.fuel_type)} · Driver: <b>${esc(v.driver_name || '—')}</b>
        · Oil change every ${fmt(v.oil_interval_km)} km</p><p class="muted" style="margin-bottom:0">Only the admin can change these.</p></div>`}
      <div class="card" ${admin ? '' : 'hidden'}><h2>🚐 Basic</h2><div class="fields">
        <label><span>Registration no.</span><input value="${esc(v.reg_no)}" disabled></label>
        <label><span>Make / model</span><input name="model" value="${esc(v.model || '')}"></label>
        <label><span>Fuel</span><select name="fuel_type">${VEHICLE_FUELS.map((x) => `<option ${x === v.fuel_type ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label><span>Starting odometer (km)</span><input name="initial_km" type="number" min="0" step="0.1" value="${v.initial_km}">
          <small class="muted">Can only be changed before any km, fuel or service is recorded.</small></label>
        <label><span>Oil change every (km)</span><input name="oil_interval_km" type="number" min="100" value="${v.oil_interval_km}"></label>
        <label><span>Assigned driver</span><select name="assigned_driver_id"><option value="">— none —</option>${drivers.map((x) =>
          `<option value="${x.id}" ${x.id === v.assigned_driver_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (in use)</label>
      </div></div>

      <div class="card"><h2>🪪 Registration (RC)</h2><div class="fields">
        ${REG_FIELDS.map(field).join('')}
        <div class="full">${paperField('rc_file', 'RC copy', doc.rc_file)}</div>
      </div></div>

      <div class="card"><h2>🛡 Insurance</h2><div class="fields">
        <label><span>Insurance company</span><input name="insurance_company" value="${val('insurance_company')}"></label>
        <label><span>Policy number</span><input name="insurance_policy" value="${val('insurance_policy')}"></label>
        <label><span>Valid till</span><input name="insurance_upto" type="date" value="${val('insurance_upto')}"></label>
        <div class="full">${paperField('insurance_file', 'Insurance policy copy', doc.insurance_file)}</div>
      </div></div>

      <div class="card"><h2>💨 Pollution (PUC)</h2><div class="fields">
        <label><span>PUC certificate number</span><input name="pucc_number" value="${val('pucc_number')}"></label>
        <label><span>Valid till</span><input name="pucc_upto" type="date" value="${val('pucc_upto')}"></label>
        <div class="full">${paperField('pucc_file', 'PUC certificate', doc.pucc_file)}</div>
      </div></div>

      <div class="card"><h2>✅ Fitness</h2><div class="fields">
        <label><span>Fitness valid till</span><input name="fitness_upto" type="date" value="${val('fitness_upto')}">
          <small class="muted">Private cars: usually 15 years from registration. Commercial vehicles: renewed every 1–2 years.</small></label>
        <div class="full">${paperField('fitness_file', 'Fitness certificate', doc.fitness_file)}</div>
      </div></div>

      <div class="card"><h2>🧾 Road tax</h2><div class="fields">
        <label class="check"><input type="checkbox" name="tax_lifetime" ${lifetimeTax ? 'checked' : ''}> Lifetime tax (LTT) – no renewal</label>
        <label data-taxdate><span>Tax valid till</span><input name="tax_upto" type="date" value="${lifetimeTax ? '' : val('tax_upto')}"></label>
        <div class="full">${paperField('tax_file', 'Tax receipt', doc.tax_file)}</div>
      </div></div>

      <div class="card"><h2>📜 Permit <small class="muted">(commercial / taxi vehicles)</small></h2><div class="fields">
        <label><span>Permit valid till</span><input name="permit_upto" type="date" value="${val('permit_upto')}"></label>
        <div class="full">${paperField('permit_file', 'Permit copy', doc.permit_file)}</div>
      </div></div>

      <div class="card"><h2>📝 Notes</h2><textarea name="notes" placeholder="Anything else: second key location, battery warranty, GPS tracker…">${val('notes')}</textarea></div>
      <div class="actions savebar"><button class="primary" type="submit">💾 Save all details</button>
        <a class="btn" href="#/vehicle/${v.id}">Cancel</a></div>
    </form>`;
  const f = $('#vf', main);
  bindPaperFields(f);
  const taxToggle = () => ($('[data-taxdate]', f).style.display = f.tax_lifetime.checked ? 'none' : '');
  f.tax_lifetime.onchange = taxToggle; taxToggle();
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    if (admin) {
      const basic = { model: f.model.value, fuel_type: f.fuel_type.value, oil_interval_km: f.oil_interval_km.value,
        assigned_driver_id: f.assigned_driver_id.value || null, active: f.active.checked };
      if (Number(f.initial_km.value) !== v.initial_km) basic.initial_km = f.initial_km.value;
      await api(`/api/vehicles/${v.id}`, { method: 'PUT', body: basic });
    }
    const body = { notes: f.notes.value, files: f._files };
    for (const [k] of REG_FIELDS) body[k] = f[k].value;
    for (const k of ['insurance_company', 'insurance_policy', 'insurance_upto', 'pucc_number', 'pucc_upto', 'fitness_upto', 'permit_upto']) body[k] = f[k].value;
    body.tax_upto = f.tax_lifetime.checked ? 'LTT' : f.tax_upto.value;
    await api(`/api/documents/${v.id}`, { method: 'PUT', body });
    state.vehicles = [];
    toast('Vehicle details saved');
    location.hash = `#/vehicle/${v.id}`;
  }); };
};

// ================================================================== upkeep: parts, wheels, daily checks, complaints
const CHECK_LABEL = { ok: '✅ OK', topped_up: '🟡 Topped up', low: '🔴 Low' };
const WHEEL_KINDS = { alignment: 'Wheel alignment', balancing: 'Wheel balancing', rotation: 'Tyre rotation', pressure: 'Air pressure check',
  puncture: 'Puncture repair', damage: 'Tyre / wheel damage', replacement: 'Tyre replacement', other: 'Other' };
const WHEEL_POS = [['FL', 'Front left'], ['FR', 'Front right'], ['RL', 'Rear left'], ['RR', 'Rear right'], ['SPARE', 'Spare'], ['ALL', 'All wheels']];
const COMPLAINT_CATS = { mechanical: 'Mechanical / running problem', damage_found: 'Damage found on vehicle', other_driver: 'Damage / misuse by another driver',
  electrical: 'Electrical / AC / lights', tyres: 'Tyres / wheels', cleanliness: 'Cleanliness', missing_item: 'Missing item / tool', other: 'Other' };
const COMPLAINT_STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', rejected: 'Rejected' };
const WARRANTY_OPTS = [['', '— none / use expiry date —'], ['6', '6 months'], ['12', '1 year'], ['18', '18 months'], ['24', '2 years'],
  ['36', '3 years'], ['48', '4 years'], ['60', '5 years'], ['72', '6 years']];

/**
 * Small form in a pop-up. fields: [{ name, label, type, options:[[value,label]], required, hint, placeholder, multiple, showIf(form) }]
 * types: text | number | date | select | textarea | photo | checks (several boxes) | seg (one of several buttons)
 */
function formDialog({ title, intro = '', fields, values = {}, submit = 'Save', onSubmit }) {
  const v = (n) => esc(values[n] ?? '');
  const html = (fd) => {
    const { name, label, type = 'text', options = [], required, hint, placeholder = '' } = fd;
    const req = required ? ' required' : '';
    const star = required ? ' *' : '';
    const small = hint ? `<small class="muted">${hint}</small>` : '';
    if (type === 'photo') return `<div data-fd="${name}" class="full">${photoField(name, label, { multiple: fd.multiple, required })}${small}</div>`;
    if (type === 'select') {
      return `<label data-fd="${name}"${fd.full ? ' class="full"' : ''}><span>${esc(label)}${star}</span><select name="${name}"${req}>${options.map(([ov, ol]) =>
        `<option value="${esc(ov)}" ${String(values[name] ?? '') === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>${small}</label>`;
    }
    if (type === 'textarea') return `<label data-fd="${name}" class="full"><span>${esc(label)}${star}</span><textarea name="${name}" placeholder="${esc(placeholder)}"${req}>${v(name)}</textarea>${small}</label>`;
    if (type === 'checks' || type === 'seg') {
      const multi = type === 'checks';
      const cur = multi ? String(values[name] || '').split(',') : [String(values[name] ?? '')];
      return `<div data-fd="${name}" class="full"><label><span>${esc(label)}${star}</span></label><div class="seg">${options.map(([ov, ol]) =>
        `<label><input type="${multi ? 'checkbox' : 'radio'}" name="${name}" value="${esc(ov)}" ${cur.includes(String(ov)) ? 'checked' : ''}${!multi && required ? ' required' : ''}><span>${esc(ol)}</span></label>`).join('')}</div>${small}</div>`;
    }
    return `<label data-fd="${name}"${fd.full ? ' class="full"' : ''}><span>${esc(label)}${star}</span><input name="${name}" type="${type}" value="${v(name)}" placeholder="${esc(placeholder)}"${
      type === 'number' ? ' step="any" min="0"' : ''}${req}>${small}</label>`;
  };
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form><h2>${esc(title)}</h2>${intro ? `<p class="muted" style="margin-top:0">${intro}</p>` : ''}<div class="fields">${fields.map(html).join('')}</div>
    <div class="actions"><button class="primary" type="submit">${esc(submit)}</button><button type="button" data-cancel>Cancel</button></div></form>`;
  document.body.appendChild(dlg);
  const f = dlg.querySelector('form');
  bindPhotoPickers(f);
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  const update = () => fields.forEach((fd) => {
    if (!fd.showIf) return;
    const show = fd.showIf(f), box = f.querySelector(`[data-fd="${fd.name}"]`);
    box.style.display = show ? '' : 'none';
    box.querySelectorAll('input,select,textarea').forEach((el) => { if (fd.required) el.required = show; });
  });
  f.addEventListener('change', update);
  update();
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    const out = {};
    for (const fd of fields) {
      if (fd.showIf && !fd.showIf(f)) continue;
      if (fd.type === 'photo') out[fd.name] = fd.multiple ? f._photos[fd.name] : f._photos[fd.name][0];
      else if (fd.type === 'checks') out[fd.name] = $$(`[name="${fd.name}"]:checked`, f).map((x) => x.value);
      else if (fd.type === 'seg') out[fd.name] = ($(`[name="${fd.name}"]:checked`, f) || {}).value;
      else out[fd.name] = f.elements[fd.name].value;
    }
    await onSubmit(out);
    dlg.close();
  }); };
  dlg.showModal();
  return f;
}

// ---- parts with warranty / expiry
const partExpiry = (p) => (p.status === 'replaced'
  ? `<span class="badge">Replaced ${niceDate(p.replaced_on)}</span>`
  : docCell(p.expiry_date ? { upto: p.expiry_date, status: p.state === 'unknown' ? 'ok' : p.state, days_left: p.days_left } : null));
/** "Replace at 15,060 km" with a badge: 90 km left / OVERDUE by 40 km */
const partKm = (p) => {
  if (p.status === 'replaced' || p.due_km === null || p.due_km === undefined) return '';
  const left = p.km_left;
  const cls = p.km_state === 'expired' ? 'danger' : p.km_state === 'due' ? 'warn' : 'ok';
  return `<div style="margin-top:4px"><small>🛣 replace at <b>${fmt(p.due_km)} km</b></small>${left === null ? '' : `<br><span class="badge ${cls}">${
    left <= 0 ? `OVERDUE by ${fmt(-left)} km` : `${fmt(left)} km left`}</span>`}</div>`;
};
function partDialog(vehicle, kind, part) {
  const isBattery = kind === 'battery', isTyre = kind === 'tyre';
  formDialog({
    title: `${part ? 'Edit' : 'Add'} ${isBattery ? 'battery' : isTyre ? 'tyre' : 'part'} – ${vehicle.reg_no}`,
    intro: `${isBattery && !part ? 'Adding a new battery marks the previous one as replaced. ' : ''}Give a date (warranty / expiry), a distance (replace every … km), or both – reminders come before whichever is first.`,
    values: part || { installed_on: today(), name: isBattery ? 'Battery' : '' },
    fields: [
      ...(isBattery ? [] : [{ name: 'name', label: isTyre ? 'Tyre (size / model)' : 'Part name', required: true,
        placeholder: isTyre ? 'e.g. 185/65 R15' : 'e.g. Fire extinguisher, wiper blades, FASTag, GPS tracker, first-aid kit' }]),
      { name: 'brand', label: 'Brand', placeholder: isBattery ? 'e.g. Exide, Amaron' : '' },
      { name: 'serial_no', label: 'Serial number', placeholder: isBattery ? 'printed on the battery' : '' },
      ...(isTyre ? [{ name: 'position', label: 'Position', type: 'select', options: [['', '—'], ...WHEEL_POS.filter(([k]) => k !== 'ALL')] }] : []),
      { name: 'installed_on', label: 'Installed / bought on', type: 'date' },
      { name: 'installed_km', label: 'Odometer when installed (km)', type: 'number' },
      { name: 'warranty_months', label: 'Warranty', type: 'select', options: WARRANTY_OPTS },
      { name: 'expiry_date', label: isBattery ? 'Warranty till (optional)' : 'Expiry / valid till', type: 'date', hint: 'Leave empty to use installed date + warranty' },
      { name: 'life_km', label: isBattery ? 'Change battery every (km)' : isTyre ? 'Change tyre every (km)' : 'Replace every (km)', type: 'number',
        placeholder: isBattery ? 'e.g. 60000' : isTyre ? 'e.g. 40000' : '', hint: 'Needs the odometer when installed. You get a warning ~500 km and ~100 km before.' },
      { name: 'due_km', label: 'or: replace at odometer (km)', type: 'number', hint: 'Leave empty to use installed km + "every"' },
      { name: 'cost', label: 'Cost (₹)', type: 'number' },
      { name: 'vendor', label: 'Shop / vendor' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
      { name: 'photo', label: part?.photo ? 'Photo (adds a new one)' : 'Photo (serial number / warranty card)', type: 'photo' },
    ],
    onSubmit: async (b) => {
      if (!b.photo) delete b.photo;
      if (part) await api(`/api/parts/${part.id}`, { method: 'PUT', body: b });
      else await api('/api/parts', { method: 'POST', body: { ...b, kind, vehicle_id: vehicle.id } });
      toast('Saved'); route();
    },
  });
}
function partsCard(d, admin) {
  const v = d.vehicle;
  const rows = d.parts || [];
  return `<div class="card"><div class="row"><h2 style="margin:0">🔋 Battery &amp; parts with warranty / expiry</h2><span class="spacer"></span>
    <button class="small" data-addpart="battery">+ Battery</button><button class="small" data-addpart="tyre">+ Tyre</button>
      <button class="small" data-addpart="other">+ Other part</button></div>
    ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table>
      <tr><th>Part</th><th>Brand / serial no.</th><th>Installed</th><th>Warranty / replace at</th><th>Cost</th><th>Photo</th><th></th></tr>
      ${rows.map((p) => `<tr style="${p.status === 'replaced' ? 'opacity:.55' : ''}"><td><b>${esc(p.kind === 'battery' ? '🔋 ' + p.name : p.kind === 'tyre' ? '🛞 ' + p.name : '🧩 ' + p.name)}</b>
          ${p.position ? `<br><small class="muted">${esc(p.position)}</small>` : ''}${p.notes ? `<br><small class="muted">${esc(p.notes)}</small>` : ''}</td>
        <td>${esc(p.brand || '—')}${p.serial_no ? `<br><small>S/N <b>${esc(p.serial_no)}</b></small>` : ''}</td>
        <td>${niceDate(p.installed_on)}${p.installed_km ? `<br><small class="muted">at ${fmt(p.installed_km)} km</small>` : ''}${p.vendor ? `<br><small class="muted">${esc(p.vendor)}</small>` : ''}</td>
        <td>${p.expiry_date || p.status === 'replaced' || !p.due_km ? partExpiry(p) : ''}${p.warranty_months ? `<br><small class="muted">${p.warranty_months % 12 === 0 ? `${p.warranty_months / 12} yr` : `${p.warranty_months} months`} warranty</small>` : ''}${partKm(p)}</td>
        <td>${p.cost ? money(p.cost) : '—'}</td><td>${thumb(p.photo)}</td>
        <td style="white-space:nowrap"><button class="small" data-editpart="${p.id}">Edit</button>
          ${p.status === 'active' ? `<button class="small" data-replpart="${p.id}">Replaced</button>` : ''}${admin ? `<button class="small danger" data-delpart="${p.id}">Delete</button>` : ''}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">No battery or parts recorded yet. Add the battery with its serial number and warranty.</p>'}</div>`;
}

// ---- wheels & tyres
function wheelDialog(vehicle) {
  formDialog({
    title: `Wheel / tyre work – ${vehicle.reg_no}`,
    values: { date: today() },
    fields: [
      { name: 'kind', label: 'What was done', type: 'select', required: true, options: [['', 'Choose…'], ...Object.entries(WHEEL_KINDS)] },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'positions', label: 'Which wheel(s)', type: 'checks', options: WHEEL_POS },
      { name: 'odometer', label: 'Odometer (km)', type: 'number' },
      { name: 'cost', label: 'Cost (₹)', type: 'number' },
      { name: 'garage', label: 'Garage / shop' },
      { name: 'notes', label: 'Details', type: 'textarea', placeholder: 'e.g. sidewall cut, replaced with MRF ZVTV, alignment was off' },
      { name: 'photo', label: 'Photo', type: 'photo' },
    ],
    onSubmit: async (b) => { await api('/api/wheels', { method: 'POST', body: { ...b, vehicle_id: vehicle.id } }); toast('Wheel work saved'); route(); },
  });
}
function wheelsCard(d, admin) {
  const rows = d.wheels || [];
  return `<div class="card"><div class="row"><h2 style="margin:0">🛞 Wheels &amp; tyres</h2><span class="spacer"></span><button class="small" data-addwheel>+ Log wheel / tyre work</button></div>
    ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table>
      <tr><th>Date</th><th>Work</th><th>Wheels</th><th>Odometer</th><th>Cost</th><th>Garage</th><th>Details</th><th>Photo</th><th>By</th>${admin ? '<th></th>' : ''}</tr>
      ${rows.map((w) => `<tr><td>${niceDate(w.date)}</td><td><b>${esc(w.kind_label)}</b></td><td>${esc((w.positions || '—').replaceAll(',', ', '))}</td>
        <td>${w.odometer ? fmt(w.odometer) : '—'}</td><td>${w.cost ? money(w.cost) : '—'}</td><td>${esc(w.garage || '')}</td>
        <td class="wrap">${esc(w.notes || '')}</td><td>${thumb(w.photo)}</td><td>${esc(w.by_name)}</td>
        ${admin ? `<td><button class="small danger" data-delwheel="${w.id}">Delete</button></td>` : ''}</tr>`).join('')}
    </table></div>` : '<p class="muted">No wheel or tyre work recorded yet (alignment, balancing, puncture, replacement…).</p>'}</div>`;
}

// ---- daily oil & coolant check
const CHECK_OPTS = [['ok', '✅ OK'], ['topped_up', '🟡 Topped up'], ['low', '🔴 Low']];
function checkDialog(vehicle, existing) {
  const ev = vehicle.fuel_type === 'EV';
  formDialog({
    title: `✅ Daily check – ${vehicle.reg_no}`,
    intro: ev ? 'Electric vehicle: check the coolant level only.' : 'Check with the engine cold, on level ground.',
    values: existing || {},
    fields: [
      ...(ev ? [] : [{ name: 'oil', label: 'Engine oil level', type: 'seg', options: CHECK_OPTS, required: true }]),
      { name: 'coolant', label: 'Coolant level', type: 'seg', options: CHECK_OPTS, required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', placeholder: 'e.g. topped up 200 ml oil' },
      { name: 'photo', label: 'Photo (optional)', type: 'photo' },
    ],
    submit: 'Save check',
    onSubmit: async (b) => {
      const r = await api('/api/checks', { method: 'POST', body: { ...b, vehicle_id: vehicle.id } });
      toast(r.oil === 'low' || r.coolant === 'low' ? 'Saved – the admin will see the low level' : 'Daily check saved ✅'); route();
    },
  });
}
function checksTodayCard(list, title = '✅ Daily check – engine oil & coolant') {
  if (!list.length) return '';
  const mine = list.filter((c) => c.assigned_driver_id === state.user.id);
  const rows = state.user.role === 'admin' ? list : [...mine, ...list.filter((c) => c.assigned_driver_id !== state.user.id)];
  const done = list.filter((c) => c.done).length;
  return `<div class="card"><h2>${title}</h2><p class="muted" style="margin-top:0">Today: <b>${done} of ${list.length}</b> vehicles checked.</p>
    <div class="table-wrap"><table><tr><th>Vehicle</th><th>Engine oil</th><th>Coolant</th><th>Checked by</th></tr>
    ${rows.map((c) => `<tr><td><b>${vlink(c.vehicle_id, c.reg_no)}</b>${c.assigned_driver_id === state.user.id ? ' <span class="badge">yours</span>' : ''}
      <br><button class="small ${c.done ? '' : 'primary'}" style="margin-top:6px" data-check="${c.vehicle_id}">${c.done ? 'Update' : '✅ Check now'}</button></td>
      <td>${c.done ? (c.fuel_type === 'EV' ? '<small class="muted">EV</small>' : CHECK_LABEL[c.oil] || '—') : '—'}</td><td>${c.done ? CHECK_LABEL[c.coolant] || '—' : '—'}</td>
      <td>${c.done ? `${esc(c.checked_by)}${c.notes ? `<br><small class="muted">${esc(c.notes)}</small>` : ''}` : '<span class="badge warn">not checked</span>'}</td></tr>`).join('')}
    </table></div></div>`;
}
function bindCheckButtons(root, list) {
  for (const b of $$('[data-check]', root)) b.onclick = () => {
    const c = list.find((x) => String(x.vehicle_id) === b.dataset.check);
    checkDialog({ id: c.vehicle_id, reg_no: c.reg_no, fuel_type: c.fuel_type }, c.done ? c : null);
  };
}
function checksHistoryCard(d) {
  const rows = d.checks || [];
  return `<div class="card"><div class="row"><h2 style="margin:0">✅ Daily oil &amp; coolant checks <small class="muted">(last 14)</small></h2><span class="spacer"></span>
    <button class="small primary" data-checkveh>Check today</button></div>
    ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table><tr><th>Date</th><th>Engine oil</th><th>Coolant</th><th>By</th><th>Notes</th><th>Photo</th></tr>
      ${rows.map((c) => `<tr><td>${niceDate(c.date)}</td><td>${c.oil ? CHECK_LABEL[c.oil] : '<small class="muted">—</small>'}</td><td>${CHECK_LABEL[c.coolant] || '—'}</td>
        <td>${esc(c.checked_by)}</td><td class="wrap">${esc(c.notes || '')}</td><td>${thumb(c.photo)}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">No checks yet.</p>'}</div>`;
}

// ---- complaints
let peopleCache = null;
async function people() { return (peopleCache ??= await api('/api/people')); }
async function complaintDialog(vehicleId) {
  const ppl = (await people()).filter((p) => p.id !== state.user.id);
  await refreshVehicles();
  const mine = state.vehicles.find((v) => v.assigned_driver_id === state.user.id);
  formDialog({
    title: '📣 Raise a complaint',
    intro: 'Report a problem, damage you found, or damage / misuse by someone who used the vehicle before you.',
    values: { vehicle_id: vehicleId || mine?.id || '', occurred_on: today(), priority: 'normal' },
    fields: [
      { name: 'vehicle_id', label: 'Vehicle', type: 'select', required: true, options: [['', 'Choose…'], ...state.vehicles.filter((v) => v.active).map((v) => [v.id, v.reg_no])] },
      { name: 'category', label: 'Type of complaint', type: 'select', required: true, options: [['', 'Choose…'], ...Object.entries(COMPLAINT_CATS)] },
      { name: 'other_user_id', label: 'Who used the vehicle before you?', type: 'select', required: true,
        options: [['', 'Choose…'], ...ppl.map((p) => [p.id, p.name]), ['__other', 'Someone else (type the name)']],
        showIf: (f) => f.category.value === 'other_driver' },
      { name: 'other_user_name', label: 'Their name', required: true, placeholder: 'e.g. guest driver, mechanic, pastor',
        showIf: (f) => f.category.value === 'other_driver' && f.other_user_id.value === '__other' },
      { name: 'title', label: 'Short title', placeholder: 'e.g. Rear bumper dent, AC not cooling' },
      { name: 'occurred_on', label: 'Noticed on', type: 'date' },
      { name: 'odometer', label: 'Odometer (km)', type: 'number' },
      { name: 'priority', label: 'Priority', type: 'seg', options: [['low', 'Low'], ['normal', 'Normal'], ['high', '🔴 High – unsafe / urgent']] },
      { name: 'description', label: 'What is the problem?', type: 'textarea', required: true, placeholder: 'Describe what you saw, when, and where on the vehicle' },
      { name: 'photos', label: 'Photos (needed for damage)', type: 'photo', multiple: true },
    ],
    submit: 'Send complaint',
    onSubmit: async (b) => {
      if (b.other_user_id === '__other') delete b.other_user_id;
      await api('/api/complaints', { method: 'POST', body: b });
      toast('Complaint sent to the admin'); route();
    },
  });
}
const complaintStatusBadge = (s) => `<span class="badge ${s === 'resolved' ? 'ok' : s === 'rejected' ? '' : s === 'in_progress' ? 'warn' : 'danger'}">${COMPLAINT_STATUS[s] || esc(s)}</span>`;
function complaintTable(rows, admin, { showVehicle = true } = {}) {
  if (!rows.length) return '<p class="muted">No complaints. 👍</p>';
  return `<div class="table-wrap"><table><tr><th>Date</th>${showVehicle ? '<th>Vehicle</th>' : ''}<th>Complaint</th><th>Reported by</th><th>Used before by</th><th>Photos</th><th>Status</th>${admin ? '<th></th>' : ''}</tr>
    ${rows.map((c) => `<tr><td>${niceDate(c.occurred_on || c.created_at.slice(0, 10))}</td>${showVehicle ? `<td>${vlink(c.vehicle_id, c.reg_no)}</td>` : ''}
      <td class="wrap">${c.priority === 'high' ? '<span class="badge danger">HIGH</span> ' : ''}<b>${esc(c.title || c.category_label)}</b>
        <br><small class="muted">${esc(c.category_label)}${c.odometer ? ` · ${fmt(c.odometer)} km` : ''}</small><br>${esc(c.description)}
        ${c.admin_notes ? `<br><small><b>Admin:</b> ${esc(c.admin_notes)}</small>` : ''}</td>
      <td>${esc(c.reported_by_name)}</td><td>${c.other_user ? `<b>${esc(c.other_user)}</b>` : '—'}</td>
      <td><div class="photos">${c.photos.map(thumb).join('')}</div></td><td>${complaintStatusBadge(c.status)}</td>
      ${admin ? `<td style="white-space:nowrap"><button class="small" data-cupd="${c.id}">Update</button> <button class="small danger" data-cdel="${c.id}">Delete</button></td>` : ''}</tr>`).join('')}
  </table></div>`;
}
function bindComplaintButtons(root, rows) {
  for (const b of $$('[data-cupd]', root)) b.onclick = () => {
    const c = rows.find((x) => String(x.id) === b.dataset.cupd);
    formDialog({
      title: `Update complaint – ${c.reg_no}`, intro: esc(c.title || c.category_label), values: c, submit: 'Save',
      fields: [
        { name: 'status', label: 'Status', type: 'seg', options: Object.entries(COMPLAINT_STATUS) },
        { name: 'priority', label: 'Priority', type: 'seg', options: [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']] },
        { name: 'admin_notes', label: 'Notes / action taken', type: 'textarea', placeholder: 'e.g. spoke to the driver, repaired at ₹1,200' },
      ],
      onSubmit: async (body) => { await api(`/api/complaints/${c.id}`, { method: 'PUT', body }); toast('Complaint updated'); route(); },
    });
  };
  for (const b of $$('[data-cdel]', root)) b.onclick = async () => {
    if (!confirm('Delete this complaint permanently?')) return;
    try { await api(`/api/complaints/${b.dataset.cdel}`, { method: 'DELETE' }); route(); } catch (e) { toast(e.message, true); }
  };
}
pages.complaints = async (main) => {
  const admin = state.user.role === 'admin';
  const [rows, ppl] = await Promise.all([api('/api/complaints'), people()]);
  void ppl;
  const open = rows.filter((c) => c.status === 'open' || c.status === 'in_progress');
  main.innerHTML = `<h1>📣 Complaints</h1>
    <p class="muted">${admin ? 'Problems and damage reported by drivers.' : 'Report a problem or damage – including damage left by someone who used the vehicle before you.'}</p>
    <div class="actions" style="margin:0 0 16px"><button class="primary" id="newc">+ Raise a complaint</button></div>
    <div class="card"><h2>Open (${open.length})</h2>${complaintTable(open, admin)}</div>
    <div class="card"><h2>Closed (${rows.length - open.length})</h2>${complaintTable(rows.filter((c) => !open.includes(c)), admin)}</div>`;
  $('#newc', main).onclick = () => complaintDialog();
  bindComplaintButtons(main, rows);
};

// ---- vehicle page: all upkeep cards + buttons
function upkeepCards(d, admin) {
  return `${partsCard(d, admin)}${wheelsCard(d, admin)}${checksHistoryCard(d)}
    <div class="card"><div class="row"><h2 style="margin:0">📣 Complaints</h2><span class="spacer"></span><button class="small" data-newc>+ Raise a complaint</button></div>
      <div style="margin-top:10px">${complaintTable(d.complaints || [], admin, { showVehicle: false })}</div></div>`;
}
function bindUpkeep(main, d) {
  const v = d.vehicle;
  for (const b of $$('[data-addpart]', main)) b.onclick = () => partDialog(v, b.dataset.addpart);
  for (const b of $$('[data-editpart]', main)) b.onclick = () => { const p = d.parts.find((x) => String(x.id) === b.dataset.editpart); partDialog(v, p.kind, p); };
  for (const b of $$('[data-replpart]', main)) b.onclick = async () => {
    if (!confirm('Mark this part as replaced today?')) return;
    await api(`/api/parts/${b.dataset.replpart}`, { method: 'PUT', body: { status: 'replaced' } }).catch((e) => toast(e.message, true)); route();
  };
  for (const b of $$('[data-delpart]', main)) b.onclick = async () => {
    if (!confirm('Delete this part record?')) return;
    await api(`/api/parts/${b.dataset.delpart}`, { method: 'DELETE' }).catch((e) => toast(e.message, true)); route();
  };
  $('[data-addwheel]', main).onclick = () => wheelDialog(v);
  for (const b of $$('[data-delwheel]', main)) b.onclick = async () => {
    if (!confirm('Delete this wheel record?')) return;
    await api(`/api/wheels/${b.dataset.delwheel}`, { method: 'DELETE' }).catch((e) => toast(e.message, true)); route();
  };
  $$('[data-checkveh]', main).forEach((b) => (b.onclick = () => checkDialog(v, (d.checks || []).find((c) => c.date === today()))));
  $$('[data-newc]', main).forEach((b) => (b.onclick = () => complaintDialog(v.id)));
  bindComplaintButtons(main, d.complaints || []);
}

// --- vehicle documents (admin): insurance, pollution, fitness, tax, permit
pages.documents = async (main) => {
  const { vehicles, settings: st } = await api('/api/documents');
  const t = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const counts = { expired: 0, due: 0 };
  for (const v of vehicles) for (const [k] of DOCS) if (v.docs[k].status in counts) counts[v.docs[k].status]++;
  const ls = st.last_sync;
  main.innerHTML = `<h1>📄 Vehicle documents</h1>
    <p class="muted">Insurance, pollution (PUC), fitness, road tax and permit expiry for every vehicle.
      ${st.has_key && st.enabled ? `Updated online every morning at ${String(st.hour).padStart(2, '0')}:00 (${st.mode === 'all' ? 'every vehicle' : 'smart sync'}).` : 'Enter dates by hand, or add an online lookup key below to update them automatically.'}</p>
    <div class="grid">
      <div class="stat"><div class="v" style="color:var(--danger)">${counts.expired}</div><div class="l">Expired</div></div>
      <div class="stat"><div class="v" style="color:var(--warn)">${counts.due}</div><div class="l">Expiring within 30 days</div></div>
      <div class="stat"><div class="v">${vehicles.length}</div><div class="l">Vehicles</div></div>
      <div class="stat"><div class="l">Last online update</div><div style="margin-top:6px"><b>${ls ? t(ls.at) : 'never'}</b>${ls ? `<br><small class="muted">${
        ls.checked ?? ls.updated} looked up${ls.skipped ? `, ${ls.skipped} skipped` : ''}${ls.failed.length ? `, ${ls.failed.length} failed` : ''}</small>` : ''}</div></div>
      ${st.has_key ? `<div class="stat"><div class="l">Next morning</div><div style="margin-top:6px"><b>${st.next_run.lookups} lookup(s)</b><br><small class="muted">of ${st.next_run.vehicles} vehicles
        ${st.provider === 'rtosarthi' ? ` · ≈ ₹${fmt(st.next_run.lookups * 1.5, 2)}` : ''}</small></div></div>` : ''}
      ${st.usage ? `<div class="stat"><div class="v">${fmt(st.usage.remaining)}</div><div class="l">Prepaid searches left${st.usage.limit ? ` of ${fmt(st.usage.limit)}` : ''}</div></div>` : ''}
    </div>
    ${st.usage && st.usage.remaining !== null && st.usage.remaining < 50 ? `<div class="alert warn">Only ${st.usage.remaining} prepaid searches left – recharge with your provider.</div>` : ''}
    <div class="actions" style="margin:0 0 16px">
      <button class="primary" id="syncsmart" ${st.has_key ? '' : 'disabled title="Add an API key first"'} title="Only vehicles with documents expired / expiring, never checked, or not checked for 30 days">🔄 Smart sync now (${st.next_run.lookups})</button>
      <button id="syncall" ${st.has_key ? '' : 'disabled title="Add an API key first"'}>Sync all ${st.next_run.vehicles} vehicles</button></div>
    ${st.has_key && st.mode !== 'all' ? `<details class="card"><summary><b>Why each vehicle is / isn't checked tomorrow</b></summary><div class="table-wrap"><table>
      ${st.next_run.plan.map((x) => `<tr><td>${vlink(x.vehicle_id, x.reg_no)}</td><td>${x.lookup ? '🔎 ' : '⏭ '}${esc(x.reason)}</td></tr>`).join('')}</table></div></details>` : ''}
    <div class="card"><div class="table-wrap"><table>
      <tr><th>Vehicle</th>${DOCS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Updated</th><th></th></tr>
      ${vehicles.map((v) => `<tr><td><b>${vlink(v.vehicle_id, v.reg_no)}</b><br><small class="muted">${esc(v.maker_model || v.model || '')}</small>
          ${v.owner_name ? `<br><small class="muted">Owner: ${esc(v.owner_name)}</small>` : ''}${v.rc_status ? `<br><small class="muted">RC: ${esc(v.rc_status)}</small>` : ''}</td>
        ${DOCS.map(([k]) => `<td>${docCell(v.docs[k])}${k === 'insurance' && v.insurance_company ? `<br><small class="muted">${esc(v.insurance_company)}</small>` : ''}</td>`).join('')}
        <td><small>${v.fetched_at ? `🌐 ${t(v.fetched_at)}` : v.source === 'manual' ? '✍️ manual' : '—'}</small>
          ${v.last_error ? `<br><small style="color:var(--danger)" title="${esc(v.last_error)}">⚠ ${esc(v.last_error.slice(0, 60))}</small>` : ''}</td>
        <td style="white-space:nowrap"><button class="small" data-sync="${v.vehicle_id}" ${st.has_key ? '' : 'disabled'}>🔄 Sync</button>
          <button class="small" data-edit="${v.vehicle_id}">✏️ Edit</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No vehicles yet.</td></tr>'}
    </table></div></div>
    <details class="card" ${st.has_key ? '' : 'open'}><summary><b>⚙️ Online lookup settings</b> ${st.has_key ? `<span class="badge ok">key ${esc(st.key_hint)}</span>` : '<span class="badge warn">not set up</span>'}</summary>
      <p class="muted">Details come from VAHAN (Parivahan) through a licensed <b>RC-verification API</b> – there is no free official API. Each lookup is paid.</p>
      <div class="alert" data-help="rtosarthi" style="display:none"><b>RTO Sarthi</b> – from <b>₹1.5 per successful search</b>, prepaid, no monthly fee.
        Contact them (WhatsApp/phone <a href="https://wa.me/916264682508" target="_blank" rel="noopener">+91 62646 82508</a>, rtosarthi@gmail.com) for a <b>Vahan API key</b>.
        They send an <b>integration guide</b> – copy the <b>API URL</b>, the <b>header name</b> for the key, and the request body from it into the fields below.</div>
      <form id="sf"><div class="fields">
        <label><span>Provider</span><select name="provider">${st.presets.map((p) => `<option value="${p}" ${p === st.provider ? 'selected' : ''}>${
          { rtosarthi: 'RTO Sarthi (from ₹1.5/search)', surepass: 'Surepass (RC full)', custom: 'Other provider (custom)' }[p] || p}</option>`).join('')}</select></label>
        <label><span>API key / token</span><input name="key" autocomplete="off" placeholder="${st.has_key ? 'leave blank to keep ' + esc(st.key_hint) : 'paste key'}"></label>
        <label><span>Daily update time</span><select name="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === st.hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
        <label><span>Which vehicles each morning</span><select name="mode">
          <option value="smart" ${st.mode !== 'all' ? 'selected' : ''}>Smart – only when needed (recommended, ~90% cheaper)</option>
          <option value="all" ${st.mode === 'all' ? 'selected' : ''}>Every vehicle, every day</option></select>
          <small class="muted">Smart: vehicles with a document expired or expiring within 30 days (to catch the renewal), never checked, or not checked for 30 days.</small></label>
        <label class="check"><input type="checkbox" name="enabled" ${st.enabled ? 'checked' : ''}> Update automatically every morning</label>
        <div class="full" data-custom style="display:none"><div class="fields">
          <label class="full"><span>API URL (use {vehicle_number} if it goes in the URL)</span><input name="url" value="${esc(st.editable ? st.url : '')}" placeholder="https://… (from the provider's guide)"></label>
          <label><span>Method</span><select name="method">${['POST', 'GET'].map((m) => `<option ${m === st.method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <label><span>Auth header</span><input name="auth_header" value="${esc(st.auth_header)}"></label>
          <label><span>Key prefix</span><input name="auth_prefix" value="${esc(st.auth_prefix)}" placeholder="Bearer "></label>
          <label class="full"><span>Request body (JSON)</span><input name="body" value="${esc(st.body)}"></label>
        </div></div>
      </div><div class="actions"><button class="primary" type="submit">Save settings</button>
        ${st.has_key ? '<button type="button" class="danger" id="rmkey">Remove key</button>' : ''}</div></form></details>
`;

  const sf = $('#sf', main);
  const showCustom = () => {
    const pv = sf.provider.value;
    $('[data-custom]', sf).style.display = pv === 'custom' || pv === 'rtosarthi' ? '' : 'none';
    $$('[data-help]', sf.closest('details')).forEach((el) => (el.style.display = el.dataset.help === pv ? '' : 'none'));
  };
  sf.provider.onchange = showCustom; showCustom();
  sf.onsubmit = (e) => { e.preventDefault(); submitting(sf, async () => {
    const b = { provider: sf.provider.value, hour: Number(sf.hour.value), enabled: sf.enabled.checked, mode: sf.mode.value };
    if (sf.key.value.trim()) b.key = sf.key.value.trim();
    if (b.provider === 'custom' || b.provider === 'rtosarthi') Object.assign(b, { url: sf.url.value.trim(), method: sf.method.value, auth_header: sf.auth_header.value.trim(),
      auth_prefix: sf.auth_prefix.value, body: sf.body.value.trim() });
    await api('/api/documents/settings', { method: 'PUT', body: b });
    toast('Settings saved'); route();
  }); };
  const busy = async (btn, fn) => { btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Updating…';
    try { await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = old; } };
  const runSync = (smart) => (e) => busy(e.target, async () => {
    if (!smart && !confirm(`Look up all ${st.next_run.vehicles} vehicles now? Each lookup is charged by your provider.`)) return;
    const r = await api('/api/documents/sync', { method: 'POST', body: { smart } });
    toast(r.checked === 0 ? 'Everything is up to date – no lookups needed'
      : `${r.updated} vehicle(s) updated${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`, r.failed.length > 0 && !r.updated);
    route();
  });
  $('#syncsmart', main).onclick = runSync(true);
  $('#syncall', main).onclick = runSync(false);
  const rm = $('#rmkey', main);
  if (rm) rm.onclick = async () => { if (!confirm('Remove the API key? Automatic updates will stop.')) return;
    await api('/api/documents/settings', { method: 'PUT', body: { key: '' } }); route(); };
  for (const b of $$('[data-sync]', main)) b.onclick = () => busy(b, async () => {
    const r = await api('/api/documents/sync', { method: 'POST', body: { vehicle_id: b.dataset.sync } });
    if (r.ok) toast(`${r.reg_no} updated`); else toast(r.error, true);
    setTimeout(route, r.ok ? 0 : 2500);
  });
  for (const b of $$('[data-edit]', main)) b.onclick = () => (location.hash = `#/vehicle-edit/${b.dataset.edit}`);
};

// --- Loyverse POS (admin)
pages.loyverse = async (main) => {
  const st = await api('/api/loyverse');
  const pending = st.connected ? await api('/api/loyverse/unmatched') : [];
  const ago = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const r = st.last_result;
  main.innerHTML = `<h1>🧾 Loyverse POS</h1>
    <p class="muted">Petrol, diesel and CNG sold in Loyverse are added to the website automatically (every ${st.interval_minutes} minutes).</p>
    <div class="card"><h2>1. Connect</h2>
      ${st.connected ? `<p>✅ Connected (token ${esc(st.token_hint)}) · Auto-sync <b>${st.enabled ? 'on' : 'off'}</b></p>` : `
      <ol class="muted"><li>Open <b>Loyverse Back Office</b> (r.loyverse.com) on a computer.</li>
        <li>Go to <b>Settings → Access tokens → + Add access token</b>, name it "Driver Log Shalom", Save.</li>
        <li>Copy the token and paste it here.</li></ol>`}
      <form id="cf"><div class="fields">
        <label><span>${st.connected ? 'Replace access token' : 'Access token'}</span><input name="token" autocomplete="off" placeholder="paste token here"></label>
        <label><span>Import sales from (first sync)</span><input type="date" name="since" value="${esc((st.since || '').slice(0, 10))}"></label>
        <label class="check"><input type="checkbox" name="enabled" ${st.enabled ? 'checked' : ''}> Auto-sync every ${st.interval_minutes} min</label>
      </div><div class="actions"><button class="primary" type="submit">${st.connected ? 'Save' : 'Connect'}</button>
        ${st.connected ? '<button type="button" id="disc" class="danger">Disconnect</button>' : ''}</div></form></div>
    ${st.connected ? `
    <div class="card"><h2>2. Sync</h2>
      <p>Last sync: <b>${ago(st.last_sync)}</b>${r ? ` – ${r.receipts} receipts read, <b>${r.imported}</b> fuel sales added, ${r.unmatched} without vehicle, ${r.removed} removed (refund/cancel)` : ''}</p>
      ${st.last_error ? `<div class="alert danger">Last error (${ago(st.last_error.at)}): ${esc(st.last_error.message)}</div>` : ''}
      <div class="actions"><button class="primary" id="sync">🔄 Sync now</button></div></div>
    <div class="card"><h2>3. Vehicle numbers in Loyverse</h2>
      <p>The cashier must tell Loyverse which vehicle is being filled. Either:</p>
      <ul><li><b>Best:</b> add every vehicle to Loyverse as a <b>customer</b> named by its number, then the cashier just selects the customer.
        <br><button id="push" class="primary" style="margin-top:8px">➕ Add / update ${st.linked_vehicles ? '' : 'all '}vehicles in Loyverse</button>
        <small class="muted">${st.linked_vehicles} vehicle(s) linked</small></li>
        <li style="margin-top:10px"><b>Or:</b> type the vehicle number in the <b>receipt comment</b> (e.g. "TN01AB1234" or just the last 4 digits "1234").</li></ul>
      <p class="muted">Fuel items are recognised by name: <b>Petrol</b> / Power / Speed / XP95 → Petrol, <b>Diesel</b> / HSD → Diesel, <b>CNG</b> → CNG.
        Odometer readings are not in Loyverse – drivers can add them with <b>➕ Add km</b> on the Fuel page.</p></div>
    <div class="card"><h2>Sales without a vehicle (${pending.length})</h2>
      ${pending.length ? `<div class="table-wrap"><table>
        <tr><th>Date</th><th>Receipt</th><th>Item</th><th>Qty</th><th>Amount</th><th>Info</th><th>Vehicle</th><th></th></tr>
        ${pending.map((u) => `<tr><td>${esc(u.receipt_date)}</td><td>${esc(u.receipt_number)}</td><td>${fuelBadge(u.fuel_type)}<br><small>${esc(u.item_name)}</small></td>
          <td>${fmt(u.quantity, 2)}</td><td>${money(u.amount)}</td><td class="wrap">${esc(u.info || '—')}</td>
          <td><select data-um="${u.id}"><option value="">Choose…</option>${state.vehicles.filter((v) => v.active)
            .map((v) => `<option value="${v.id}">${esc(v.reg_no)}</option>`).join('')}</select></td>
          <td class="row"><button class="small primary" data-assign="${u.id}">Assign</button><button class="small" data-ignore="${u.id}" title="Not a fleet vehicle">Ignore</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted">Nothing to assign. 👍</p>'}</div>` : ''}`;

  const cf = $('#cf', main);
  cf.onsubmit = (e) => { e.preventDefault(); submitting(cf, async () => {
    const body = { enabled: cf.enabled.checked };
    if (cf.token.value.trim()) body.token = cf.token.value.trim();
    if (cf.since.value !== (st.since || '').slice(0, 10)) body.since = cf.since.value || null;
    if (!st.connected && !body.token) throw new Error('Paste the access token first');
    await api('/api/loyverse', { method: 'PUT', body });
    toast(body.token ? 'Connected to Loyverse' : 'Saved');
    if (body.token || body.since) { toast('Connected – reading sales…'); await api('/api/loyverse/sync', { method: 'POST' }).catch((err) => toast(err.message, true)); }
    route();
  }); };
  const btn = (sel, fn) => { const b = $(sel, main); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (err) { toast(err.message, true); } finally { b.disabled = false; } }; };
  btn('#disc', async () => { if (!confirm('Disconnect Loyverse? Already imported sales stay.')) return; await api('/api/loyverse', { method: 'PUT', body: { token: '' } }); route(); });
  btn('#sync', async () => { const s = await api('/api/loyverse/sync', { method: 'POST' }); toast(`${s.imported} fuel sale(s) added, ${s.unmatched} without vehicle`); route(); });
  btn('#push', async () => { const s = await api('/api/loyverse/push-vehicles', { method: 'POST' });
    toast(`Loyverse customers: ${s.created} created, ${s.linked} linked, ${s.updated} updated`); state.vehicles = []; route(); });
  for (const b of $$('[data-assign]', main)) b.onclick = async () => {
    const sel = $(`[data-um="${b.dataset.assign}"]`, main);
    if (!sel.value) return toast('Choose the vehicle first', true);
    try { await api(`/api/loyverse/unmatched/${b.dataset.assign}/assign`, { method: 'POST', body: { vehicle_id: sel.value } }); toast('Added to ' + sel.selectedOptions[0].text); route(); }
    catch (err) { toast(err.message, true); }
  };
  for (const b of $$('[data-ignore]', main)) b.onclick = async () => {
    try { await api(`/api/loyverse/unmatched/${b.dataset.ignore}/ignore`, { method: 'POST' }); route(); } catch (err) { toast(err.message, true); }
  };
};

// --- oil change / service
pages.services = async (main) => {
  await refreshVehicles();
  main.innerHTML = `<h1>Oil change &amp; service</h1>
    <div class="card"><h2>Add service record</h2><form id="f"><div class="fields">
      <label><span>Vehicle *</span>${vehicleSelect()}</label>
      <label><span>Type *</span><select name="type" required>${Object.entries(SERVICE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <small class="muted" id="evnote"></small></label>
      <label><span>Date *</span><input type="date" name="date" value="${today()}" required></label>
      ${kmField('odometer', 'Odometer at service (km)')}
      <label><span>Cost (₹)</span><input name="cost" type="number" inputmode="decimal" step="0.01" min="0"></label>
      <label><span>Garage / workshop</span><input name="garage"></label>
      <label><span>Next due at (km)</span><input name="next_due_km" type="number" inputmode="decimal" min="0">
        <small class="muted" id="nexthint"></small></label>
      <label class="full"><span>Work done / parts replaced</span><textarea name="notes" placeholder="Engine oil 5W-30, oil filter, air filter…"></textarea></label>
      ${photoField('photo', 'Bill photo')}
    </div><div class="actions"><button class="primary" type="submit">Save service</button></div></form></div>
    <div class="card"><h2>Oil change status</h2><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Odometer</th><th>Last oil change</th><th>Status</th></tr>
      ${state.vehicles.filter((v) => v.active).map((v) => `<tr><td>${esc(v.reg_no)}</td><td>${fmt(v.current_km)} km</td>
        <td>${v.last_oil_change_km !== null ? `${fmt(v.last_oil_change_km)} km<br><small class="muted">${esc(v.last_oil_change_date)}</small>` : '—'}</td>
        <td>${oilBadge(v)}</td></tr>`).join('')}</table></div></div>
    <div class="card"><h2>History</h2>${filtersBar('flt')}<div id="list"></div></div>`;
  const f = $('#f', main);
  bindPhotoPickers(f); bindOdometer(f);
  const hint = () => {
    const v = state.vehicles.find((x) => String(x.id) === $('[name=vehicle_id]', f).value);
    const odo = Number($('[name=odometer]', f).value);
    // Electric vehicles have no engine oil
    const isEV = v?.fuel_type === 'EV';
    const oilOpt = $('[name=type] option[value=oil_change]', f);
    oilOpt.disabled = isEV;
    if (isEV && f.type.value === 'oil_change') f.type.value = 'general_service';
    $('#evnote', f).textContent = isEV ? 'Electric vehicle – no oil change needed' : '';
    $('#nexthint', f).textContent = f.type.value === 'oil_change' && v && odo
      ? `Leave blank for default: ${fmt(odo + v.oil_interval_km)} km (every ${fmt(v.oil_interval_km)} km)` : '';
  };
  f.oninput = hint; f.onchange = hint; hint();
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/services', { method: 'POST', body: { ...formData(f), photo: f._photos.photo[0] } });
    toast('Service record saved'); route();
  }); };
  const load = async (qs) => {
    const rows = await api('/api/services?' + qs);
    $('#list', main).innerHTML = `<p class="muted">${rows.length} records · <b>${money(rows.reduce((s, r) => s + r.cost, 0))}</b></p><div class="table-wrap"><table>
      <tr><th>Date</th><th>Vehicle</th><th>Type</th>${state.user.role === 'admin' ? '<th>Driver</th>' : ''}<th>Odometer</th><th>Next due</th><th>Cost</th><th>Garage</th><th>Details</th><th>Bill</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.reg_no)}</td><td>${SERVICE_LABEL[r.type] || esc(r.type)}</td>
        ${state.user.role === 'admin' ? `<td>${esc(r.driver_name)}</td>` : ''}<td>${fmt(r.odometer)}</td><td>${fmt(r.next_due_km)}</td>
        <td>${money(r.cost)}</td><td>${esc(r.garage)}</td><td class="wrap">${esc(r.notes)}</td><td>${thumb(r.photo)}</td><td>${delBtn('services', r.id)}</td></tr>`).join('')}
      </table></div>`;
    bindDeletes($('#list', main), () => load(qs));
  };
  bindFilters($('#flt', main), 'services', load);
};

// --- accidents
function accidentTable(rows) {
  const admin = state.user.role === 'admin';
  return `<div class="table-wrap"><table>
    <tr><th>When</th><th>Vehicle</th>${admin ? '<th>Driver</th>' : ''}<th>Odometer</th><th>Severity</th><th>Location</th><th>Description</th><th>Photos</th><th>Status</th><th></th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.occurred_at.replace('T', ' '))}</td><td>${esc(r.reg_no)}</td>${admin ? `<td>${esc(r.driver_name)}</td>` : ''}
      <td>${fmt(r.odometer)} km</td>
      <td><span class="badge ${r.severity === 'major' ? 'danger' : r.severity === 'moderate' ? 'warn' : ''}">${esc(r.severity)}</span>${r.injuries ? '<br><span class="badge danger">injuries</span>' : ''}</td>
      <td class="wrap">${esc(r.location)}${r.lat !== null ? `<br><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${r.lat},${r.lng}">📍 map</a>` : ''}</td>
      <td class="wrap">${esc(r.description)}${r.third_party ? `<br><small class="muted">Other party: ${esc(r.third_party)}</small>` : ''}
        ${r.police_report ? `<br><small class="muted">FIR/Report: ${esc(r.police_report)}</small>` : ''}
        ${r.admin_notes ? `<br><small><b>Admin:</b> ${esc(r.admin_notes)}</small>` : ''}</td>
      <td><div class="photos">${r.photos.map(thumb).join('')}</div></td>
      <td><span class="badge ${r.status === 'closed' ? 'ok' : 'warn'}">${STATUS_LABEL[r.status] || esc(r.status)}</span></td>
      <td>${admin ? `<button class="small" data-acc="${r.id}">Update</button> ${delBtn('accidents', r.id)}` : ''}</td></tr>`).join('')}
    </table></div>`;
}
pages.accidents = async (main) => {
  await refreshVehicles();
  main.innerHTML = `<h1>Accident reports</h1>
    <div class="card"><h2>Report an accident</h2>
      <p class="muted">Make sure everyone is safe first. Take clear photos of the damage, the number plates, and the odometer.</p>
      <form id="f"><div class="fields">
      <label><span>Vehicle *</span>${vehicleSelect()}</label>
      <label><span>Date &amp; time *</span><input type="datetime-local" name="occurred_at" value="${nowLocal()}" required></label>
      ${kmField('odometer', 'Odometer reading (km)')}
      <label><span>Severity *</span><select name="severity"><option value="minor">Minor (scratch/dent)</option>
        <option value="moderate">Moderate</option><option value="major">Major</option></select></label>
      <label class="full"><span>Location</span><div class="row"><input name="location" style="flex:1" placeholder="Road / landmark">
        <button type="button" id="gps">📍 Use my location</button></div>
        <input type="hidden" name="lat"><input type="hidden" name="lng"><small class="muted" id="gpsinfo"></small></label>
      <label class="full"><span>What happened? *</span><textarea name="description" required></textarea></label>
      <label><span>Other vehicle / party details</span><input name="third_party" placeholder="Vehicle no., name, phone"></label>
      <label><span>Police report / FIR no.</span><input name="police_report"></label>
      <label class="check full"><input type="checkbox" name="injuries" value="1"> Someone was injured</label>
      ${photoField('photos', 'Accident photos (up to 8)', { multiple: true, required: true })}
    </div><div class="actions"><button class="primary" type="submit">Submit accident report</button></div></form></div>
    <div class="card"><h2>All reports</h2>${filtersBar('flt')}<div id="list"></div></div>
    <dialog id="dlg"><form method="dialog" id="df"><h2>Update accident</h2><div class="fields">
      <label class="full"><span>Status</span><select name="status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="full"><span>Admin notes</span><textarea name="admin_notes" placeholder="Insurance claim no., repair cost, action taken…"></textarea></label>
    </div><div class="actions"><button class="primary" type="submit">Save</button><button type="button" id="dc">Cancel</button></div></form></dialog>`;
  const f = $('#f', main);
  bindPhotoPickers(f); bindOdometer(f);
  $('#gps', f).onclick = () => {
    if (!navigator.geolocation) return toast('Location not available on this device', true);
    $('#gpsinfo', f).textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition((p) => {
      f.lat.value = p.coords.latitude.toFixed(6); f.lng.value = p.coords.longitude.toFixed(6);
      $('#gpsinfo', f).textContent = `GPS: ${f.lat.value}, ${f.lng.value} (±${Math.round(p.coords.accuracy)} m)`;
      if (!f.location.value) f.location.value = `GPS ${f.lat.value}, ${f.lng.value}`;
    }, (err) => { $('#gpsinfo', f).textContent = ''; toast('Could not get location: ' + err.message, true); },
    { enableHighAccuracy: true, timeout: 15000 });
  };
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    if (!f._photos.photos.length) throw new Error('Please attach at least one photo');
    await api('/api/accidents', { method: 'POST', body: { ...formData(f), injuries: f.injuries.checked, photos: f._photos.photos } });
    toast('Accident report submitted. The admin has been notified on the dashboard.'); route();
  }); };
  let rows = [];
  const dlg = $('#dlg', main), df = $('#df', main);
  $('#dc', main).onclick = () => dlg.close();
  const load = async (qs) => {
    rows = await api('/api/accidents?' + qs);
    $('#list', main).innerHTML = rows.length ? accidentTable(rows) : '<p class="muted">No accident reports. 👍</p>';
    bindDeletes($('#list', main), () => load(qs));
    for (const b of $$('[data-acc]', main)) b.onclick = () => {
      const r = rows.find((x) => String(x.id) === b.dataset.acc);
      df.status.value = r.status; df.admin_notes.value = r.admin_notes || '';
      df.onsubmit = async (e) => { e.preventDefault();
        try { await api(`/api/accidents/${r.id}`, { method: 'PUT', body: formData(df) }); dlg.close(); toast('Updated'); load(qs); }
        catch (err) { toast(err.message, true); } };
      dlg.showModal();
    };
  };
  bindFilters($('#flt', main), 'accidents', load);
};

// --- manage fleet (admin part of the Vehicles page)
const manageVehicles = async (main) => {
  await refreshVehicles();
  const drivers = (state.drivers = await api('/api/drivers')).filter((d) => d.role === 'driver' && d.active);
  const driverOpts = (sel) => `<option value="">— none —</option>${drivers.map((d) => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`;
  main.innerHTML = `
    <div class="card"><h2>➕ Add vehicle</h2><form id="f"><div class="fields">
      <label><span>Registration no. *</span><input name="reg_no" required placeholder="DL01AB1234" style="text-transform:uppercase"></label>
      <label><span>Make / model</span><input name="model" placeholder="Maruti WagonR CNG"></label>
      <label><span>Fuel</span><select name="fuel_type">${VEHICLE_FUELS.map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label><span>Current odometer (km)</span><input name="initial_km" type="number" min="0" step="0.1" value="0"></label>
      <label><span>Oil change every (km)</span><input name="oil_interval_km" type="number" min="100" value="5000"></label>
      <label><span>Assigned driver</span><select name="assigned_driver_id">${driverOpts()}</select></label>
    </div><div class="actions"><button class="primary" type="submit">Add vehicle</button></div></form></div>
    <div class="card"><h2>🛠 Fleet settings <small class="muted">(changes save straight away)</small></h2><div class="table-wrap"><table>
      <tr><th>Reg. no.</th><th>Model</th><th>Fuel</th><th>Odometer</th><th>Oil interval</th><th>Driver</th><th>Oil change</th><th>Active</th></tr>
      ${state.vehicles.map((v) => `<tr data-v="${v.id}"><td><b>${vlink(v.id, v.reg_no)}</b>${v.loyverse_customer_id ? '<br><small class="muted">🧾 in Loyverse</small>' : ''}
        <br><a class="small" href="#/vehicle-edit/${v.id}">✏️ Edit details</a></td><td>${esc(v.model)}</td><td><select data-k="fuel_type">${VEHICLE_FUELS.map((x) => `<option ${x === v.fuel_type ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
        <td>${fmt(v.current_km)} km</td>
        <td><input type="number" min="100" value="${v.oil_interval_km}" data-k="oil_interval_km" style="width:100px"></td>
        <td><select data-k="assigned_driver_id">${driverOpts(v.assigned_driver_id)}</select></td>
        <td>${oilBadge(v)}</td><td><input type="checkbox" data-k="active" ${v.active ? 'checked' : ''}></td></tr>`).join('')}
    </table></div></div>`;
  const f = $('#f', main);
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    const r = await api('/api/vehicles', { method: 'POST', body: formData(f) });
    state.vehicles = [];
    toast('Vehicle added – now fill in its details (optional)');
    location.hash = `#/vehicle-edit/${r.id}`;
  }); };
  for (const input of $$('[data-k]', main)) input.onchange = async () => {
    const id = input.closest('tr').dataset.v;
    const val = input.type === 'checkbox' ? input.checked : input.value;
    try { await api(`/api/vehicles/${id}`, { method: 'PUT', body: { [input.dataset.k]: val } }); toast('Saved'); }
    catch (e) { toast(e.message, true); }
  };
};

// --- drivers (admin)
pages.drivers = async (main) => {
  const users = (state.drivers = await api('/api/drivers'));
  main.innerHTML = `<h1>Drivers &amp; users</h1>
    <div class="card"><h2>Add driver</h2><form id="f"><div class="fields">
      <label><span>Full name *</span><input name="name" required></label>
      <label><span>Username (for login) *</span><input name="username" required autocapitalize="off"></label>
      <label><span>Password *</span><input name="password" type="text" minlength="6" required></label>
      <label><span>Phone</span><input name="phone" type="tel"></label>
      <label><span>Driving licence no.</span><input name="license_no"></label>
      <label><span>Role</span><select name="role"><option value="driver">Driver</option><option value="admin">Admin / supervisor</option></select></label>
    </div><div class="actions"><button class="primary" type="submit">Create login</button></div></form></div>
    <div class="card"><h2>All users</h2><div class="table-wrap"><table>
      <tr><th>Name</th><th>Username</th><th>Role</th><th>Phone</th><th>Licence</th><th>Status</th><th>📡 GPS app</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.phone)}</td>
        <td>${esc(u.license_no)}</td><td><span class="badge ${u.active ? 'ok' : ''}">${u.active ? 'active' : 'disabled'}</span></td>
        <td>${u.tracking_last_at ? `<small>last seen<br>${dateTime(u.tracking_last_at)}</small>` : '<small class="muted">not set up</small>'}</td>
        <td class="row"><button class="small" data-pw="${u.id}">Reset password</button>
        ${u.id !== state.user.id ? `<button class="small ${u.active ? 'danger' : ''}" data-act="${u.id}:${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`).join('')}
    </table></div></div>`;
  const f = $('#f', main);
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/drivers', { method: 'POST', body: formData(f) }); toast('Login created'); route();
  }); };
  for (const b of $$('[data-pw]', main)) b.onclick = async () => {
    const pw = prompt('New password (min 6 characters):');
    if (!pw) return;
    try { await api(`/api/drivers/${b.dataset.pw}`, { method: 'PUT', body: { password: pw } }); toast('Password changed'); } catch (e) { toast(e.message, true); }
  };
  for (const b of $$('[data-act]', main)) b.onclick = async () => {
    const [id, active] = b.dataset.act.split(':');
    try { await api(`/api/drivers/${id}`, { method: 'PUT', body: { active: active === '1' } }); route(); } catch (e) { toast(e.message, true); }
  };
};

// --- profile
pages.profile = async (main) => {
  const u = state.user;
  main.innerHTML = `<h1>My profile</h1>
    <div class="card"><p><b>${esc(u.name)}</b> (${esc(u.username)}) · ${esc(u.role)}</p>
      ${u.phone ? `<p>📞 ${esc(u.phone)}</p>` : ''}${u.license_no ? `<p>🪪 ${esc(u.license_no)}</p>` : ''}</div>
    <div class="card"><h2>Change password</h2><form id="f"><div class="fields">
      <label><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label><span>New password</span><input type="password" name="next" minlength="6" required autocomplete="new-password"></label>
    </div><div class="actions"><button class="primary" type="submit">Update password</button></div></form></div>
    <div class="card" id="bgtrack"><h2>📡 Background location (screen off)</h2><p class="muted">Loading…</p></div>`;
  const f = $('#f', main);
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/me/password', { method: 'POST', body: formData(f) }); toast('Password updated'); f.reset();
  }); };
  renderBgTracking($('#bgtrack', main), await api('/api/me/tracking'));
};

/** Set-up card for Traccar Client – free GPS app that keeps sending the location with the screen off. */
function renderBgTracking(box, t) {
  const app = nativeApp();
  if (app) {
    const st = nativeStatus();
    const optimised = (() => { try { return app.batteryOptimised(); } catch { return false; } })();
    box.innerHTML = `<h2>📡 Background location</h2>
      <p>✅ You are using the <b>Driver Log Shalom app</b> (version ${esc(app.version())}). During a trip your location is shared
        <b>with the screen off</b> too – a notification "Driver Log Shalom – sharing location" shows while it runs, and it stops at <b>End trip</b>.</p>
      <p>Now: ${st.active ? `<span class="badge ok">sharing</span> ${st.sent || 0} points sent${st.queued ? `, ${st.queued} waiting for signal` : ''}` : '<span class="badge">not on a trip</span>'}</p>
      ${optimised ? `<div class="alert warn">Battery saving may stop the app in the background on some phones (Xiaomi, Oppo, Vivo, Samsung…).
        <button class="small primary" id="batt" style="margin-left:6px">Allow background use</button></div>` : '<p class="muted">✅ Battery optimisation is off for the app.</p>'}`;
    const b = $('#batt', box);
    if (b) b.onclick = () => app.openBatterySettings();
    return;
  }
  const server = `${location.origin}/api/osmand`;
  const android = /Android/.test(navigator.userAgent), ios = /iPhone|iPad/.test(navigator.userAgent);
  const copy = (txt) => `<button type="button" class="small" data-copy="${esc(txt)}">📋 Copy</button>`;
  const isAndroid = /Android/.test(navigator.userAgent);
  box.innerHTML = `<h2>📡 Background location (screen off)</h2>
    <div class="alert" style="border-color:var(--brand-2)"><b>📱 Recommended: the Driver Log Shalom app${isAndroid ? '' : ' (Android)'}.</b>
      It opens this website and shares your trip location with the screen off – nothing to set up.<br>
      <a class="btn small primary" style="margin-top:8px" href="${APP_APK_URL}">⬇ Download the Android app (APK)</a>
      <small class="muted" style="display:block;margin-top:6px">Open the downloaded file and allow "Install unknown apps" when the phone asks. iPhone: use Traccar Client below.</small></div>
    <p class="muted"><b>Or</b> use the free Traccar Client app:</p>
    <p>A website can only use GPS while it is open on the screen – phones block it in the background. To keep sharing your location
      with the <b>screen off</b> during trips, install the free <b>Traccar Client</b> app once:</p>
    <ol class="steps">
      <li>Install <b>Traccar Client</b> from the ${ios ? '<a href="https://apps.apple.com/app/traccar-client/id843156974" target="_blank" rel="noopener">App Store</a>'
        : '<a href="https://play.google.com/store/apps/details?id=org.traccar.client" target="_blank" rel="noopener">Play Store</a>'}${android || ios ? '' : ' (Android) or App Store (iPhone)'}.</li>
      <li>Open it and enter:
        <div class="kv"><span>Device identifier</span><code>${esc(t.device_id)}</code>${copy(t.device_id)}</div>
        <div class="kv"><span>Server URL</span><code>${esc(server)}</code>${copy(server)}</div>
        <div class="kv"><span>Location accuracy</span><b>High</b></div>
        <div class="kv"><span>Frequency</span><b>30</b> seconds · Distance <b>50</b> m (or 0)</div></li>
      <li>Allow location <b>"All the time"</b> (${ios ? 'Settings → Traccar Client → Location → Always' : 'Android: Permissions → Location → Allow all the time'})
        ${ios ? '' : 'and set Battery → <b>Unrestricted</b> / turn off battery optimisation for Traccar Client'}.</li>
      <li>Switch the service <b>on</b> in Traccar Client. Keep using <b>Start trip / End trip</b> here as usual.</li>
    </ol>
    <p class="muted">Only positions <b>during your trips</b> are saved – anything sent outside a trip is thrown away. You can switch the
      service off in Traccar Client when you are off duty.</p>
    <p>Status: ${t.last_at ? `✅ last received from the app <b>${dateTime(t.last_at)}</b>` : '⏳ nothing received from the app yet'}</p>
    <div class="actions"><button type="button" class="small" id="bgreset">🔄 New identifier</button>
      <small class="muted">Use if the identifier was shared by mistake – then enter the new one in the app.</small></div>`;
  for (const b of $$('[data-copy]', box)) b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); }
    catch { prompt('Copy this:', b.dataset.copy); }
  };
  $('#bgreset', box).onclick = async () => {
    if (!confirm('Make a new identifier? The old one stops working, so you must enter the new one in Traccar Client.')) return;
    renderBgTracking(box, await api('/api/me/tracking/reset', { method: 'POST' }));
    toast('New identifier made – update it in Traccar Client');
  };
}

// ------------------------------------------------------------------ shell & routing
const NAV = [
  ['dashboard', '📊', 'Dashboard'], ['trips', '🚗', 'Daily km'], ['fuel', '⛽', 'Fuel'],
  ['services', '🛢', 'Service'], ['accidents', '⚠️', 'Accidents'], ['complaints', '📣', 'Complaints'],
  ['vehicles', '🚐', 'Vehicles'], ['drivers', '👤', 'Drivers', 'admin'], ['reports', '📊', 'Reports'], ['live', '📍', 'Live map', 'admin'], ['documents', '📄', 'Documents', 'admin'], ['loyverse', '🧾', 'Loyverse', 'admin'],
  ['profile', '⚙️', 'Profile'],
];

function renderLogin() {
  $('#app').innerHTML = `<div class="login card">
    <img class="logo" src="/icon.svg" alt=""><h1>Driver Log Shalom</h1>
    <p class="muted">Log in with the username and password given by your fleet admin.</p>
    <form id="lf"><div class="fields" style="grid-template-columns:1fr">
      <label><span>Username</span><input name="username" required autocapitalize="off" autocomplete="username"></label>
      <label><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
    </div><div class="actions"><button class="primary" type="submit" style="width:100%;justify-content:center">Log in</button></div></form></div>`;
  const f = $('#lf');
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    state.user = await api('/api/login', { method: 'POST', body: formData(f) });
    state.user = await api('/api/me');
    location.hash = '#/dashboard'; render();
  }); };
}

// ================================================================== notifications: bell, page, phone push
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const b64uToU8 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const u8ToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${br}`;
}
async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}
/** Turn on push for this device (asks the browser for permission the first time). */
async function enablePush({ quiet = false } = {}) {
  if (!pushSupported()) {
    throw new Error(isIOS() && !isStandalone()
      ? 'On iPhone: tap Share ⬆️ → "Add to Home Screen", open Driver Log Shalom from the home screen, then turn notifications on there.'
      : 'This browser cannot show notifications. Use Chrome, Edge, Firefox or Samsung Internet.');
  }
  if (!quiet && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser\'s site settings (🔒 next to the address).');
  }
  if (Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey && u8ToB64u(sub.options.applicationServerKey) !== publicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
  return true;
}
async function disablePush() {
  const sub = await currentPushSub();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}
async function updateBell() {
  const el = $('#bellcount');
  if (!el || !state.user) return;
  try {
    const { unread } = await api('/api/notifications/count');
    el.textContent = unread > 99 ? '99+' : String(unread);
    el.hidden = !unread;
  } catch { /* offline */ }
}
setInterval(updateBell, 5 * 60e3);
const notifIcon = (k) => ({ document: '📄', warranty: '🔋', oil: '🛢' }[k] || '🔔');

/** Inside the Android app: reminders come as the app's own notifications (it checks every 30 minutes). */
function appNotifCard() {
  const app = nativeApp();
  let allowed = true;
  try { allowed = app.notificationsAllowed(); } catch { /* older app */ }
  return `<div class="card"><h2>📱 Notifications on this phone</h2>
    ${allowed ? `<p>✅ <b>On.</b> The Driver Log Shalom app checks for new reminders every 30 minutes – also when the app is closed –
        and shows them as phone notifications. Tap one to open the vehicle.</p>`
      : `<div class="alert warn">Notifications are <b>off</b> for the Driver Log Shalom app. Allow them to get reminders on this phone.</div>`}
    <div class="actions"><button id="appnotif" class="${allowed ? '' : 'primary'}">${allowed ? '⚙️ Notification settings' : '🔔 Allow notifications'}</button>
      <button id="appcheck">🔄 Check now</button></div></div>`;
}
pages.notifications = async (main) => {
  const admin = state.user.role === 'admin';
  const [d, st, sub] = await Promise.all([api('/api/notifications'), admin ? api('/api/notifications/settings') : null, currentPushSub().catch(() => null)]);
  const onHere = Boolean(sub) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const ago = (iso) => dateTime(iso);
  main.innerHTML = `<div class="row"><h1 style="margin:0">🔔 Notifications</h1><span class="spacer"></span>
      ${d.unread ? '<button id="readall">✓ Mark all as read</button>' : ''}</div>
    <p class="muted">Reminders for insurance, pollution (PUC), fitness, road tax, permit, battery &amp; part warranties, and – by distance – oil change, battery and part changes (${
      esc((st?.km || '500,100').split(',').join(' and '))} km before) –
      ${admin ? 'all vehicles' : 'your vehicle'}. Sent ${st ? st.days.split(',').map((x) => (x === '0' ? 'on the day' : `${x}`)).join(', ').replace(/, on the day$/, ' days before and on the day') : '30, 15, 7, 3, 1 days before and on the day'}, then weekly while expired.</p>

    ${nativeApp() ? appNotifCard() : `<div class="card"><h2>📱 Notifications on this phone / computer</h2>
      ${onHere ? `<p>✅ <b>On</b> for this device (${esc(deviceName())}). Reminders pop up even when the website is closed.</p>`
        : blocked ? '<div class="alert warn">Notifications are <b>blocked</b> for this site. Open the browser\'s site settings (🔒 next to the address) → Notifications → Allow, then reload.</div>'
        : !pushSupported() && isIOS() && !isStandalone() ? `<div class="alert warn"><b>iPhone:</b> tap <b>Share ⬆️ → Add to Home Screen</b>, then open Driver Log Shalom from the
            home screen and turn notifications on there (needs iOS 16.4 or newer).</div>`
        : '<p class="muted">Off on this device. Turn it on to get reminders like a WhatsApp message.</p>'}
      <div class="actions">
        ${onHere ? '<button id="ptest" class="primary">Send a test notification</button><button id="poff">Turn off on this device</button>'
          : `<button id="pon" class="primary" ${blocked ? 'disabled' : ''}>🔔 Turn on notifications</button>`}
      </div>
      ${d.devices.length ? `<p class="muted" style="margin-bottom:4px">Your devices with notifications on:</p><ul class="history">${d.devices.map((x) => `<li>
          📱 ${esc(x.device || 'Device')} <small class="muted">· since ${ago(x.created_at)}${x.last_ok_at ? ` · last delivered ${ago(x.last_ok_at)}` : ''}</small>
          ${x.last_error ? `<br><small style="color:var(--danger)">⚠ ${esc(x.last_error)}</small>` : ''}
          <button class="small" data-rmdev="${x.id}" style="float:right">Remove</button></li>`).join('')}</ul>` : ''}
    </div>`}

    <div class="card"><h2>Reminders ${d.unread ? `<span class="badge danger">${d.unread} new</span>` : ''}</h2>
      ${d.items.length ? `<ul class="notifs">${d.items.map((n) => `<li class="${n.read_at ? '' : 'unread'}"><a href="${esc(n.url || '#/notifications')}" data-nid="${n.id}">
          <span class="ni">${notifIcon(n.kind)}</span><span><b>${esc(n.title)}</b>${n.body ? `<br><span class="muted">${esc(n.body)}</span>` : ''}
          <br><small class="muted">${ago(n.created_at)}</small></span></a></li>`).join('')}</ul>`
        : '<p class="muted">No reminders yet. They appear here when a date is 30 days away or less.</p>'}
    </div>

    ${admin ? `<div class="card"><h2>⚙️ Reminder settings</h2><form id="nsf"><div class="fields">
        <label><span>Remind this many days before</span><input name="days" value="${esc(st.days.split(',').join(', '))}">
          <small class="muted">0 = on the day. After expiry a reminder is repeated every week.</small></label>
        <label><span>Warn before oil change / battery &amp; part change (km)</span><input name="km" value="${esc((st.km || '500,100').split(',').join(', '))}">
          <small class="muted">e.g. 500, 100 = a warning 500 km before and again ~100 km before. Overdue repeats every 500 km.</small></label>
        <label><span>Send reminders at</span><select name="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === st.hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
      </div><div class="actions"><button class="primary" type="submit">Save</button><button type="button" id="nrun">🔄 Check for reminders now</button></div></form>
      <p class="muted" style="margin-bottom:0">${st.last_run ? `Last check: ${ago(st.last_run.at)} – ${st.last_run.created} new reminder(s), ${st.last_run.pushed} sent to phones.` : 'Not checked yet.'}
        ${st.users_with_devices} user(s) have notifications on (${st.devices} device(s)).</p></div>` : ''}`;

  const btn = (sel, fn) => { const b = $(sel, main); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; } }; };
  btn('#pon', async () => { await enablePush(); toast('Notifications are on for this device ✅'); route(); });
  btn('#poff', async () => { await disablePush(); toast('Notifications turned off on this device'); route(); });
  btn('#ptest', async () => { const r = await api('/api/push/test', { method: 'POST' }); toast(`Test sent to ${r.sent} device(s)${r.failed ? `, ${r.failed} failed` : ''}`); });
  btn('#readall', async () => { await api('/api/notifications/read', { method: 'POST', body: {} }); route(); });
  btn('#appnotif', async () => { nativeApp()?.openNotificationSettings(); });
  btn('#appcheck', async () => { nativeApp()?.checkReminders(); toast('Checking for new reminders…'); });
  btn('#nrun', async () => { const r = await api('/api/notifications/run', { method: 'POST' }); try { nativeApp()?.checkReminders(); } catch { /* old app */ } toast(`${r.created} new reminder(s), ${r.pushed} sent to phones`); route(); });
  for (const b of $$('[data-rmdev]', main)) b.onclick = async () => { await api('/api/push/unsubscribe', { method: 'POST', body: { id: b.dataset.rmdev } }); route(); };
  for (const a of $$('[data-nid]', main)) a.addEventListener('click', () => { api('/api/notifications/read', { method: 'POST', body: { id: a.dataset.nid } }).then(updateBell).catch(() => {}); });
  const nsf = $('#nsf', main);
  if (nsf) nsf.onsubmit = (e) => { e.preventDefault(); submitting(nsf, async () => {
    await api('/api/notifications/settings', { method: 'PUT', body: { days: nsf.days.value, km: nsf.km.value, hour: Number(nsf.hour.value) } });
    toast('Reminder settings saved'); route();
  }); };
  if (d.unread) setTimeout(updateBell, 0);
};

// ================================================================== GPS tracking while on a trip
const tracker = { tripId: null, reg: '', watchId: null, queue: [], last: null, lastFix: null, sent: 0, wake: null, timer: null, error: null };
const gpsKey = (id) => `fleet_gps_${id}`;
const distM = (a, b) => {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const loadGpsQueue = (id) => { try { return JSON.parse(localStorage.getItem(gpsKey(id)) || '[]'); } catch { return []; } };
const saveGpsQueue = () => { try { if (tracker.tripId) localStorage.setItem(gpsKey(tracker.tripId), JSON.stringify(tracker.queue.slice(-3000))); } catch { /* storage full/blocked */ } };
/** One position now (resolves null if denied / no fix – never throws). */
function getPosition(timeout = 12000) {
  return new Promise((res) => {
    if (!('geolocation' in navigator)) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res(p), () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 20000 });
  });
}
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') tracker.wake = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
function onGpsVisibility() { if (document.visibilityState === 'visible' && tracker.tripId) { keepAwake(); flushGps(); renderGpsBar(); } }
function startTracking(tripId, reg) {
  if (!('geolocation' in navigator)) { tracker.error = 'This phone/browser cannot share location.'; return; }
  if (tracker.tripId === tripId && tracker.watchId !== null) return;
  stopTracking(false);
  Object.assign(tracker, { tripId, reg, queue: loadGpsQueue(tripId), last: null, lastFix: null, sent: 0, error: null });
  tracker.watchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 60000 });
  tracker.timer = setInterval(() => { flushGps(); renderGpsBar(); }, 30000);
  keepAwake();
  document.addEventListener('visibilitychange', onGpsVisibility);
  renderGpsBar();
}
function onGpsFix(pos) {
  const c = pos.coords;
  const p = { lat: +c.latitude.toFixed(6), lng: +c.longitude.toFixed(6), accuracy: Math.round(c.accuracy), speed: c.speed ?? null,
    heading: Number.isFinite(c.heading) ? Math.round(c.heading) : null, at: new Date(pos.timestamp || Date.now()).toISOString() };
  tracker.lastFix = p; tracker.error = null;
  const prev = tracker.last;
  const secs = prev ? (Date.parse(p.at) - Date.parse(prev.at)) / 1000 : Infinity;
  // keep a point every 30 s, or sooner after moving 50 m
  if (!prev || secs >= 30 || (secs >= 5 && distM(prev, p) >= 50)) { tracker.queue.push(p); tracker.last = p; saveGpsQueue(); }
  if (tracker.queue.length >= 10) flushGps();
  renderGpsBar();
}
function onGpsError(e) {
  tracker.error = e.code === 1 ? 'Location is blocked – allow location for this site (🔒 next to the address), then reload.' : 'Waiting for GPS signal…';
  renderGpsBar();
}
let gpsFlushing = false;
async function flushGps() {
  if (gpsFlushing || !tracker.tripId || !tracker.queue.length || navigator.onLine === false) return;
  gpsFlushing = true;
  const tripId = tracker.tripId, batch = tracker.queue.slice(0, 300);
  try {
    const r = await api(`/api/trips/${tripId}/locations`, { method: 'POST', body: { points: batch } });
    if (tracker.tripId === tripId) { tracker.queue.splice(0, batch.length); tracker.sent += r.saved; saveGpsQueue(); }
    if (r.closed && tracker.tripId === tripId && !tracker.queue.length) stopTracking(true);
  } catch { /* offline – kept on the phone, sent later */ } finally { gpsFlushing = false; }
}
function stopTracking(clear = true) {
  if (tracker.watchId !== null) navigator.geolocation.clearWatch(tracker.watchId);
  clearInterval(tracker.timer);
  tracker.watchId = null;
  try { tracker.wake?.release(); } catch { /* ignore */ }
  tracker.wake = null;
  document.removeEventListener('visibilitychange', onGpsVisibility);
  if (clear && tracker.tripId) { try { localStorage.removeItem(gpsKey(tracker.tripId)); } catch { /* ignore */ } }
  tracker.tripId = null;
  renderGpsBar();
}
window.addEventListener('online', () => flushGps());
// ---- inside the Driver Log Shalom Android app, background location is done by the app itself
const APP_APK_URL = 'https://github.com/anandcar730-svg/test2/releases/download/android-app/driver-log-shalom.apk';
const nativeApp = () => (window.DriverLogApp && typeof window.DriverLogApp.startTracking === 'function' ? window.DriverLogApp : null);
const nativeStatus = () => { try { return JSON.parse(nativeApp()?.status() || '{}'); } catch { return {}; } };
let nativeTimer = null;
/** Start trip location: the app (screen-off capable) when available, otherwise the browser. */
async function startTripTracking(tripId, reg) {
  const app = nativeApp();
  if (app) {
    try {
      const t = await api('/api/me/tracking');
      app.startTracking(t.device_id, `${location.origin}/api/osmand`, reg);
      tracker.native = { tripId, reg };
      clearInterval(nativeTimer);
      nativeTimer = setInterval(renderGpsBar, 15000);
      renderGpsBar();
      return;
    } catch { /* fall back to the browser */ }
  }
  startTracking(tripId, reg);
}
function stopNativeTracking() {
  const app = nativeApp();
  if (app && tracker.native) { try { app.stopTracking(); } catch { /* ignore */ } }
  tracker.native = null;
  clearInterval(nativeTimer);
  renderGpsBar();
}
window.onDriverLogApp = (event) => {
  if (event === 'denied') { toast('Location permission is needed to record the trip route', true); tracker.native = null; renderGpsBar(); }
  if (event === 'resume') { renderGpsBar(); if (state.user) resumeTracking(); }
  if (event === 'notifications' && location.hash.includes('notifications')) route();
};

function renderGpsBar() {
  let bar = $('#gpsbar');
  if (tracker.native) {
    if (!bar) { bar = document.createElement('div'); bar.id = 'gpsbar'; bar.setAttribute('role', 'status'); $('.topbar')?.after(bar); if (!bar.isConnected) return; }
    const st = nativeStatus();
    const ago = st.last_fix ? Math.max(0, Math.round((Date.now() - st.last_fix) / 1000)) : null;
    bar.className = st.active === false ? 'warn' : '';
    bar.innerHTML = st.active === false
      ? `⚠️ <b>${esc(tracker.native.reg)}</b>: location sharing is not running – allow location for Driver Log Shalom`
      : `<span class="pulse"></span> <b>Location sharing on</b> · ${esc(tracker.native.reg)} · ${ago === null ? 'finding GPS…' : `GPS ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago`}
         · ${st.sent || 0} sent${st.queued ? `, ${st.queued} waiting` : ''}<small>📱 App – keeps working with the screen off · stops at End trip</small>`;
    return;
  }
  if (!tracker.tripId) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'gpsbar';
    bar.setAttribute('role', 'status');
    $('.topbar')?.after(bar);
    if (!bar.isConnected) return;
  }
  const f = tracker.lastFix;
  const ago = f ? Math.max(0, Math.round((Date.now() - Date.parse(f.at)) / 1000)) : null;
  bar.className = tracker.error ? 'warn' : '';
  bar.innerHTML = tracker.error
    ? `⚠️ <b>${esc(tracker.reg)}</b> trip: ${esc(tracker.error)}`
    : `<span class="pulse"></span> <b>Location sharing on</b> · ${esc(tracker.reg)} · ${f ? `GPS ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago ±${f.accuracy} m` : 'finding GPS…'}
       · ${tracker.sent} sent${tracker.queue.length ? `, ${tracker.queue.length} waiting` : ''}
       <small>Keep this app open on screen while driving · stops at End trip</small>`;
}
/** After login / reload: resume sharing for the user's open trip. */
async function resumeTracking() {
  try {
    const open = await api('/api/trips/open');
    const app = nativeApp();
    if (app) {
      if (open.length) {
        if (!app.isTracking()) await startTripTracking(open[0].id, open[0].reg_no);
        else { tracker.native = { tripId: open[0].id, reg: open[0].reg_no }; clearInterval(nativeTimer); nativeTimer = setInterval(renderGpsBar, 15000); renderGpsBar(); }
      } else if (app.isTracking()) { tracker.native = { tripId: null, reg: '' }; stopNativeTracking(); }
      return;
    }
    if (open.length) startTracking(open[0].id, open[0].reg_no); else if (tracker.tripId) stopTracking(true);
  } catch { /* ignore */ }
}

// ---- maps (Leaflet, bundled in /vendor/leaflet; map pictures from OpenStreetMap)
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return (leafletLoading ||= new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = () => res(window.L);
    s.onerror = () => { leafletLoading = null; rej(new Error('The map could not be loaded')); };
    document.head.appendChild(s);
  }));
}
function newMap(el) {
  const map = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  return map;
}
const pin = (html, cls = '') => L.divIcon({ className: `mpin ${cls}`, html: `<div>${html}</div>`, iconSize: null, iconAnchor: [14, 34], popupAnchor: [0, -30] });
const gmaps = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;
const kmh = (ms) => (ms === null || ms === undefined ? '—' : `${Math.round(ms * 3.6)} km/h`);
const ageText = (min) => (min === null ? '—' : min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`);

// --- live map (admin: all vehicles on a trip; drivers: their own)
pages.live = async (main) => {
  const rows = await api('/api/live');
  main.innerHTML = `<div class="row"><h1 style="margin:0">📍 Live map</h1><span class="spacer"></span><small class="muted" id="liveat"></small></div>
    <p class="muted">Vehicles on a trip right now. Updates every 30 seconds. Locations are only shared between <b>Start trip</b> and <b>End trip</b>.</p>
    <div id="livemap" class="map"></div>
    <div class="card"><h2>On the road (${rows.length})</h2>${rows.length ? `<div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Driver</th><th>Last position</th><th>Speed</th><th>Since</th><th></th></tr>
      ${rows.map((r) => `<tr><td><b>${vlink(r.vehicle_id, r.reg_no)}</b><br><small class="muted">${esc(r.model || '')}</small></td>
        <td>${esc(r.driver_name)}${r.driver_phone ? `<br><a href="tel:${esc(r.driver_phone)}">📞 ${esc(r.driver_phone)}</a>` : ''}</td>
        <td>${r.last ? `${ageText(r.age_min)}${r.age_min > 10 ? ' <span class="badge warn">no signal</span>' : ''}<br><small class="muted">±${Math.round(r.last.accuracy || 0)} m · ${
          r.last.source === 'app' ? '📡 GPS app' : '🌐 website'}</small>`
          : '<span class="badge">no GPS shared</span>'}</td>
        <td>${r.last ? kmh(r.last.speed) : '—'}</td><td>${esc(r.started_at ? dateTime(r.started_at) : r.date)}<br><small class="muted">${fmt(r.start_km)} km</small></td>
        <td style="white-space:nowrap"><a class="btn small" href="#/trip-map/${r.trip_id}">🗺 Route</a>${r.last ? ` <a class="btn small" href="${gmaps(r.last.lat, r.last.lng)}" target="_blank" rel="noopener">Google Maps</a>` : ''}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No vehicle is on a trip right now.</p>'}</div>`;
  $('#liveat', main).textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  try {
    await loadLeaflet();
    const map = newMap($('#livemap', main));
    const pts = rows.filter((r) => r.last);
    for (const r of pts) {
      L.marker([r.last.lat, r.last.lng], { icon: pin(`${r.fuel_type === 'EV' ? '⚡' : '🚐'} ${esc(r.reg_no)}`, r.age_min > 10 ? 'stale' : '') }).addTo(map)
        .bindPopup(`<b>${esc(r.reg_no)}</b><br>👤 ${esc(r.driver_name)}<br>${ageText(r.age_min)} · ${kmh(r.last.speed)}<br><a href="#/trip-map/${r.trip_id}">Route</a>`);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map((r) => [r.last.lat, r.last.lng])).pad(0.3), { maxZoom: 15 });
    else map.setView([13.0827, 80.2707], 11); // Chennai
  } catch (e) { $('#livemap', main).innerHTML = `<p class="muted" style="padding:16px">${esc(e.message)}</p>`; }
  const here = location.hash;
  setTimeout(() => { if (location.hash === here && document.visibilityState === 'visible') route(); }, 30000);
};

// --- route of one trip
pages['trip-map'] = async (main, id) => {
  const d = await api(`/api/trips/${encodeURIComponent(id)}/route`);
  const t = d.trip, s = d.summary;
  main.innerHTML = `<div class="row"><a class="btn small" href="#/${state.user.role === 'admin' ? 'live' : 'trips'}">← Back</a></div>
    <h1 style="margin:12px 0 4px">🗺 ${esc(t.reg_no)} – trip on ${niceDate(t.date)}</h1>
    <p class="muted" style="margin-top:0">👤 ${esc(t.driver_name)} · ${t.open ? '<span class="badge warn">on the road now</span>' : `${fmt(t.start_km)} → ${fmt(t.end_km)} km`}</p>
    <div class="grid">
      <div class="stat"><div class="v">${fmt(s.gps_km, 1)} km</div><div class="l">GPS distance</div></div>
      <div class="stat"><div class="v">${t.odometer_km === null ? '—' : `${fmt(t.odometer_km, 1)} km`}</div><div class="l">Odometer distance</div></div>
      <div class="stat"><div class="v">${s.minutes >= 60 ? `${Math.floor(s.minutes / 60)} h ${s.minutes % 60} m` : `${s.minutes} min`}</div><div class="l">Tracked time</div></div>
      <div class="stat"><div class="v">${s.avg_kmh} / ${s.max_kmh}</div><div class="l">Average / top speed (km/h)</div></div>
      <div class="stat"><div class="v">${s.points}</div><div class="l">GPS points</div></div>
    </div>
    ${t.odometer_km !== null && s.gps_km > 1 && Math.abs(t.odometer_km - s.gps_km) / Math.max(t.odometer_km, s.gps_km) > 0.25
      ? `<div class="alert warn">GPS distance and odometer distance differ by more than 25%. GPS may have been off for part of the trip (app closed / screen off), or the odometer reading needs checking.</div>` : ''}
    ${s.points ? '<div id="tripmap" class="map"></div>' : '<div class="alert">No location was shared for this trip (location blocked, or the app was not open).</div>'}`;
  if (!s.points) return;
  try {
    await loadLeaflet();
    const map = newMap($('#tripmap', main));
    const good = d.points.filter((p) => p.accuracy === null || p.accuracy <= 100);
    const line = (good.length > 1 ? good : d.points).map((p) => [p.lat, p.lng]);
    const poly = L.polyline(line, { color: '#0f766e', weight: 5, opacity: 0.85 }).addTo(map);
    const first = d.points[0], last = d.points[d.points.length - 1];
    L.marker([first.lat, first.lng], { icon: pin('🟢 Start') }).addTo(map).bindPopup(`Start · ${dateTime(first.recorded_at)}`);
    L.marker([last.lat, last.lng], { icon: pin(t.open ? `🚐 ${esc(t.reg_no)}` : '🏁 End') }).addTo(map)
      .bindPopup(`${t.open ? 'Last position' : 'End'} · ${dateTime(last.recorded_at)}<br><a href="${gmaps(last.lat, last.lng)}" target="_blank" rel="noopener">Open in Google Maps</a>`);
    map.fitBounds(poly.getBounds().pad(0.2), { maxZoom: 16 });
  } catch (e) { $('#tripmap', main).innerHTML = `<p class="muted" style="padding:16px">${esc(e.message)}</p>`; }
  if (t.open) { const here = location.hash; setTimeout(() => { if (location.hash === here && document.visibilityState === 'visible') route(); }, 30000); }
};

// ================================================================== monthly fuel report (page + PDF download)
const thisMonth = () => today().slice(0, 7);
const pctBadge = (p, goodWhenUp) => (p === null || p === undefined ? '' : `<span class="badge ${p === 0 ? '' : (p > 0) === goodWhenUp ? 'ok' : 'danger'}">${p > 0 ? '▲' : p < 0 ? '▼' : ''} ${Math.abs(p)}% vs last month</span>`);
pages.reports = async (main, param) => {
  const admin = state.user.role === 'admin';
  await refreshVehicles();
  const mine = admin ? state.vehicles : state.vehicles.filter((v) => v.assigned_driver_id === state.user.id);
  if (!admin && !mine.length) { main.innerHTML = '<h1>📊 Fuel report</h1><p class="muted">Reports are available for the vehicle assigned to you. Ask the admin to assign one.</p>'; return; }
  const st = state.reportSel ||= { vehicle: admin ? 'all' : String(mine[0].id), month: thisMonth() };
  if (param) st.vehicle = String(param);
  if (!admin && !mine.some((v) => String(v.id) === st.vehicle)) st.vehicle = String(mine[0].id);
  const settings = admin ? await api('/api/reports/settings') : null;
  main.innerHTML = `<h1>📊 Monthly fuel report</h1>
    <form class="filters" id="rf" style="align-items:end">
      <label><span>Month</span><input type="month" name="month" value="${esc(st.month)}" max="${thisMonth()}" required></label>
      <label><span>Vehicle</span><select name="vehicle">${admin ? `<option value="all" ${st.vehicle === 'all' ? 'selected' : ''}>All vehicles (summary + each)</option>` : ''}
        ${mine.map((v) => `<option value="${v.id}" ${String(v.id) === st.vehicle ? 'selected' : ''}>${esc(v.reg_no)}${v.model ? ' – ' + esc(v.model) : ''}${v.active ? '' : ' (inactive)'}</option>`).join('')}</select></label>
      <div class="row"><a class="btn primary" id="pdf" download>⬇ Download PDF</a></div>
    </form>
    <div id="rep"><p class="muted">Loading…</p></div>
    ${admin ? `<details class="card"><summary><b>⚙️ Report settings</b></summary><form id="rs" class="row" style="margin-top:10px">
      <label style="flex:1"><span>Organisation name (top of the PDF)</span><input name="org_name" value="${esc(settings.org_name)}" maxlength="80"></label>
      <button type="submit">Save</button></form></details>` : ''}`;
  const f = $('#rf', main);
  const load = async () => {
    st.month = f.month.value || thisMonth(); st.vehicle = f.vehicle.value;
    const qs = `vehicle=${encodeURIComponent(st.vehicle)}&month=${encodeURIComponent(st.month)}`;
    $('#pdf', main).href = `/api/reports/fuel.pdf?${qs}`;
    const box = $('#rep', main);
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const r = await api(`/api/reports/fuel?${qs}`);
      box.innerHTML = r.fleet ? fleetReportHtml(r.fleet) : vehicleReportHtml(r);
    } catch (e) { box.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; }
  };
  f.onchange = load;
  f.onsubmit = (e) => e.preventDefault();
  const rs = $('#rs', main);
  if (rs) rs.onsubmit = (e) => { e.preventDefault(); submitting(rs, async () => { await api('/api/reports/settings', { method: 'PUT', body: { org_name: rs.org_name.value } }); toast('Saved'); }); };
  await load();
};
function vehicleReportHtml(r) {
  const max = Math.max(1, ...r.daily.map((d) => d.amount));
  const qty = r.by_type.map((t) => `${fmt(t.quantity, 2)} ${esc(t.unit)}`).join(' + ') || '0';
  return `<div class="card"><h2 style="margin-bottom:4px">${vlink(r.vehicle.id, r.vehicle.reg_no)} – ${esc(r.month_label)}</h2>
      <p class="muted" style="margin-top:0">${[r.vehicle.model, r.vehicle.fuel_type, r.vehicle.driver_name && `Driver: ${r.vehicle.driver_name}`].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="grid" style="margin:0">
        <div class="stat"><div class="v">${qty}</div><div class="l">Fuel / energy used</div></div>
        <div class="stat"><div class="v">${money(r.amount)}</div><div class="l">Total amount ${pctBadge(r.change.amount_pct, false)}</div></div>
        <div class="stat"><div class="v">${fmt(r.km, 1)} km</div><div class="l">Distance driven ${pctBadge(r.change.km_pct, true)}</div></div>
        <div class="stat"><div class="v">${r.mileage ? fmt(r.mileage, 2) : '—'}</div><div class="l">Mileage (km/${esc(r.unit)}) ${pctBadge(r.change.mileage_pct, true)}
          ${r.mileage_method ? `<br><small>${esc(r.mileage_method)}</small>` : ''}</div></div>
        <div class="stat"><div class="v">${r.cost_per_km !== null ? money(r.cost_per_km) : '—'}</div><div class="l">Cost per km${r.previous.cost_per_km ? `<br><small>last month ${money(r.previous.cost_per_km)}</small>` : ''}</div></div>
        <div class="stat"><div class="v">${r.avg_price !== null ? money(r.avg_price) : '—'}</div><div class="l">Average price per ${esc(r.unit)}</div></div>
        <div class="stat"><div class="v">${r.fill_count}</div><div class="l">Fills / charges</div></div>
        <div class="stat"><div class="v">${money(r.previous.amount)}</div><div class="l">Last month (${esc(r.previous.month_label)})</div></div>
      </div></div>
    <div class="card"><h2>Amount spent per day</h2>
      ${r.amount ? `<div class="bars">${r.daily.map((d) => `<div class="b" title="${d.day}: ${money(d.amount)}">
        <small>${d.amount ? fmt(d.amount) : ''}</small><i style="height:${(d.amount / max) * 100}%"></i><span>${d.day % 5 === 0 || d.day === 1 ? d.day : ''}</span></div>`).join('')}</div>`
        : '<p class="muted">No fuel recorded this month.</p>'}</div>
    <div class="card"><h2>All fills (${r.rows.length})</h2>${r.rows.length ? `<div class="table-wrap"><table>
      <tr><th>Date</th><th>Fuel</th><th>Odometer</th><th>Quantity</th><th>Rate</th><th>Amount</th><th>Station</th><th>By</th></tr>
      ${r.rows.map((f) => `<tr><td>${niceDate(f.date)}</td><td>${fuelBadge(f.fuel_type)}</td><td>${f.odometer === null ? '—' : fmt(f.odometer)}</td>
        <td>${fmt(f.quantity, 2)} ${esc(f.unit)}</td><td>${f.price ? '₹' + fmt(f.price, 2) : '—'}</td><td><b>${money(f.amount)}</b></td>
        <td>${esc(f.station || '')}${f.source === 'loyverse' ? ' <span class="badge src-pos">🧾 POS</span>' : ''}</td><td>${esc(f.driver)}</td></tr>`).join('')}
      <tr style="background:color-mix(in srgb,var(--ok) 10%,transparent)"><td><b>Total</b></td><td></td><td></td><td><b>${qty}</b></td><td></td><td><b>${money(r.amount)}</b></td><td></td><td>${r.fill_count} fill(s)</td></tr>
    </table></div>` : '<p class="muted">No fuel or charging recorded this month.</p>'}</div>
    ${r.drivers.length ? `<div class="card"><h2>By driver</h2><div class="table-wrap"><table><tr><th>Driver</th><th>Fills</th><th>Quantity</th><th>Amount</th></tr>
      ${r.drivers.map((d) => `<tr><td>${esc(d.driver)}</td><td>${d.fills}</td><td>${Object.entries(d.quantity).map(([t, q]) => `${fmt(q, 2)} ${FUEL[t]?.unit || ''}`).join(' + ')}</td>
        <td><b>${money(d.amount)}</b></td></tr>`).join('')}</table></div></div>` : ''}`;
}
function fleetReportHtml(f) {
  return `<div class="card"><h2>All vehicles – ${esc(f.month_label)}</h2>
      <div class="grid" style="margin:0">
        <div class="stat"><div class="v">${money(f.total.amount)}</div><div class="l">Total fuel amount</div></div>
        <div class="stat"><div class="v">${fmt(f.total.km, 1)} km</div><div class="l">Distance driven</div></div>
        <div class="stat"><div class="v">${f.total.cost_per_km !== null ? money(f.total.cost_per_km) : '—'}</div><div class="l">Fuel cost per km</div></div>
        <div class="stat"><div class="v">${f.total.fills}</div><div class="l">Fills / charges</div></div>
      </div></div>
    <div class="card"><h2>Per vehicle</h2><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Fuel used</th><th>Amount</th><th>km</th><th>Mileage</th><th>Cost / km</th><th>Fills</th><th></th></tr>
      ${f.vehicles.map((v) => `<tr><td><b>${vlink(v.vehicle_id, v.reg_no)}</b><br><small class="muted">${esc(v.model || '')}</small></td>
        <td>${v.by_type.map((t) => `${fmt(t.quantity, 1)} ${esc(t.unit)}`).join(' + ') || '—'}</td><td><b>${money(v.amount)}</b></td><td>${fmt(v.km, 0)}</td>
        <td>${v.mileage ? `${fmt(v.mileage, 1)} km/${esc(v.unit)}` : '—'}</td><td>${v.cost_per_km !== null ? money(v.cost_per_km) : '—'}</td><td>${v.fill_count}</td>
        <td style="white-space:nowrap"><button class="small" data-onev="${v.vehicle_id}">View</button>
          <a class="btn small" href="/api/reports/fuel.pdf?vehicle=${v.vehicle_id}&month=${esc(f.month)}" download>⬇ PDF</a></td></tr>`).join('')
        || '<tr><td colspan="8" class="muted">No vehicles.</td></tr>'}
      <tr style="background:color-mix(in srgb,var(--ok) 10%,transparent)"><td><b>Total</b></td><td></td><td><b>${money(f.total.amount)}</b></td><td><b>${fmt(f.total.km, 0)}</b></td><td></td>
        <td><b>${f.total.cost_per_km !== null ? money(f.total.cost_per_km) : '—'}</b></td><td><b>${f.total.fills}</b></td><td></td></tr>
    </table></div></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-onev]');
  if (!b) return;
  const sel = $('#rf [name=vehicle]');
  if (sel) { sel.value = b.dataset.onev; sel.dispatchEvent(new Event('change', { bubbles: true })); window.scrollTo(0, 0); }
});

function renderShell() {
  const items = NAV.filter((n) => !n[3] || n[3] === state.user.role);
  $('#app').innerHTML = `<header class="topbar"><span class="title">🚐 Driver Log Shalom</span>
      <a class="bell" href="#/notifications" title="Notifications" aria-label="Notifications">🔔<span id="bellcount" hidden></span></a>
      <span class="muted uname" style="color:#ccfbf1">${esc(state.user.name)}</span><button id="lo">Log out</button></header>
    <div class="shell"><nav class="side">${items.map(([k, i, l]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${i}</span>${l}</a>`).join('')}</nav>
    <main id="main"></main></div>`;
  $('#lo').onclick = async () => {
    if (tracker.tripId && !confirm('You are on a trip – logging out stops location sharing. Log out anyway?')) return;
    await flushGps(); stopTracking(false);
    await api('/api/logout', { method: 'POST' }).catch(() => {}); state.user = null; render();
  };
  renderGpsBar();
}

async function route() {
  if (!state.user) return;
  let [page, param] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const nav = NAV.find((n) => n[0] === page);
  const hidden = (param && (page === 'vehicle' || page === 'vehicle-edit' || page === 'trip-map')) || page === 'notifications'; // pages without a menu entry
  if (!hidden && (!nav || (nav[3] && nav[3] !== state.user.role))) page = 'dashboard';
  const activeNav = page === 'vehicle' || page === 'vehicle-edit' ? 'vehicles' : page;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === activeNav));
  const main = $('#main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (state.user.role === 'admin' && !state.drivers) state.drivers = await api('/api/drivers');
    if (!state.vehicles.length) await refreshVehicles();
    await pages[page](main, param ? decodeURIComponent(param) : undefined);
    updateBell();
  } catch (e) { main.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}

async function render() {
  if (!state.user) {
    try { state.user = await api('/api/me'); } catch { state.user = null; }
  }
  if (!state.user) { state.vehicles = []; state.drivers = null; return renderLogin(); }
  renderShell();
  route();
  if (pushSupported() && Notification.permission === 'granted') enablePush({ quiet: true }).catch(() => {});
  resumeTracking();
}
window.addEventListener('hashchange', route);
render();
