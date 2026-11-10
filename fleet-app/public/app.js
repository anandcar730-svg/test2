'use strict';
/* Fleet Driver Monitor — single-page front end (no framework). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }));
const money = (n) => (n === null || n === undefined ? '—' : '₹' + fmt(n, 2));
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const SERVICE_LABEL = { oil_change: 'Oil change', general_service: 'General service', tyre: 'Tyre', brake: 'Brake',
  battery: 'Battery', cng_kit: 'CNG kit', other: 'Other' };
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
  const mine = state.vehicles.find((v) => v.assigned_driver_id === state.user.id);
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

function filtersBar(id, { dates = true } = {}) {
  return `<form class="filters" id="${id}">
    ${state.user.role === 'admin' ? `<label><span>Driver</span><select name="driver"><option value="">All drivers</option>${
      (state.drivers || []).filter((d) => d.role === 'driver').map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>` : ''}
    <label><span>Vehicle</span>${vehicleSelect('vehicle', { includeAll: true })}</label>
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
  const alerts = d.vehicles.filter((v) => v.oil_status !== 'ok');
  const max = Math.max(1, ...d.daily.map((x) => x.km));
  main.innerHTML = `
    <h1>${isAdmin ? 'Fleet dashboard' : `Hello, ${esc(state.user.name)}`}</h1>
    ${alerts.map((v) => `<div class="alert ${v.oil_status === 'overdue' ? 'danger' : 'warn'}">
      🛢 <b>${esc(v.reg_no)}</b>: oil change ${v.oil_status === 'overdue'
        ? `<b>overdue by ${fmt(-v.oil_remaining_km)} km</b>` : `due in ${fmt(v.oil_remaining_km)} km`} (at ${fmt(v.oil_due_km)} km)</div>`).join('')}
    ${d.open_accidents ? `<div class="alert danger">⚠️ ${d.open_accidents} accident report(s) not closed. <a href="#/accidents">View</a></div>` : ''}
    <div class="grid">
      <div class="stat"><div class="v">${fmt(d.today.km, 1)}</div><div class="l">km today</div></div>
      <div class="stat"><div class="v">${fmt(d.month.km, 1)}</div><div class="l">km this month</div></div>
      <div class="stat"><div class="v">${fmt(d.month.fuel_kg, 2)} kg</div><div class="l">CNG this month</div></div>
      <div class="stat"><div class="v">${money(d.month.fuel_amount)}</div><div class="l">CNG spend this month</div></div>
      <div class="stat"><div class="v">${d.month.cost_per_km !== null ? money(d.month.cost_per_km) : '—'}</div><div class="l">Fuel cost / km</div></div>
      <div class="stat"><div class="v">${money(d.month.service_cost)}</div><div class="l">Service spend this month</div></div>
      <div class="stat"><div class="v">${d.month.accidents}</div><div class="l">Accidents this month</div></div>
    </div>
    <div class="card"><h2>Kilometers – last 14 days</h2>
      ${d.daily.length ? `<div class="bars">${d.daily.map((x) => `<div class="b" title="${x.date}: ${fmt(x.km, 1)} km">
        <small>${fmt(x.km)}</small><i style="height:${(x.km / max) * 100}%"></i><span>${x.date.slice(8)}</span></div>`).join('')}</div>`
        : '<p class="muted">No completed trips yet.</p>'}
    </div>
    ${d.active_trips.length ? `<div class="card"><h2>On the road now</h2><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Driver</th><th>Started</th><th>Start km</th></tr>
      ${d.active_trips.map((t) => `<tr><td>${esc(t.reg_no)}</td><td>${esc(t.driver_name)}</td><td>${esc(t.started_at)} UTC</td><td>${fmt(t.start_km)}</td></tr>`).join('')}
      </table></div></div>` : ''}
    <div class="card"><h2>Vehicles</h2><div class="table-wrap"><table>
      <tr><th>Vehicle</th><th>Driver</th><th>Odometer</th><th>Month km</th><th>Month CNG</th><th>Mileage</th><th>Oil change</th></tr>
      ${d.vehicles.map((v) => `<tr><td><b>${esc(v.reg_no)}</b><br><small class="muted">${esc(v.model)}</small></td>
        <td>${esc(v.driver_name || '—')}</td><td>${fmt(v.current_km)} km</td><td>${fmt(v.month_km, 1)}</td>
        <td>${fmt(v.month_fuel_kg, 2)} kg<br><small class="muted">${money(v.month_fuel_amount)}</small></td>
        <td>${v.km_per_kg ? fmt(v.km_per_kg, 2) + ' km/kg' : '—'}</td>
        <td>${oilBadge(v)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No vehicles yet.</td></tr>'}
      </table></div></div>
    ${d.recent_accidents.length ? `<div class="card"><h2>Recent accidents</h2>${accidentTable(d.recent_accidents)}</div>` : ''}
    ${!isAdmin ? `<div class="row"><a class="btn" href="#/trips">🚗 Daily km</a><a class="btn" href="#/fuel">⛽ CNG fill</a>
      <a class="btn" href="#/services">🛢 Service</a><a class="btn" href="#/accidents">⚠️ Accident</a></div>` : ''}`;
};
const oilBadge = (v) => {
  const cls = v.oil_status === 'overdue' ? 'danger' : v.oil_status === 'due_soon' ? 'warn' : 'ok';
  const txt = v.oil_status === 'overdue' ? `Overdue ${fmt(-v.oil_remaining_km)} km` : `${fmt(v.oil_remaining_km)} km left`;
  return `<span class="badge ${cls}">${txt}</span><br><small class="muted">due at ${fmt(v.oil_due_km)} km</small>`;
};

// --- daily kilometers
pages.trips = async (main) => {
  await refreshVehicles();
  const open = await api('/api/trips/open');
  main.innerHTML = `<h1>Daily kilometers</h1>
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
      </div><div class="actions"><button class="primary" type="submit">Start trip</button></div></form></div>`}
    <div class="card"><h2>History</h2>${filtersBar('flt')}<div id="list"></div></div>`;

  for (const f of $$('form[data-end]', main)) {
    bindPhotoPickers(f);
    f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
      const r = await api(`/api/trips/${f.dataset.end}/end`, { method: 'PUT', body: { ...formData(f), end_photo: f._photos.end_photo[0] } });
      toast(`Trip ended – ${fmt(r.distance_km, 1)} km driven`); route();
    }); };
  }
  const start = $('#start', main);
  if (start) {
    bindPhotoPickers(start); bindOdometer(start, 'start_km');
    start.onsubmit = (e) => { e.preventDefault(); submitting(start, async () => {
      await api('/api/trips', { method: 'POST', body: { ...formData(start), start_photo: start._photos.start_photo[0] } });
      toast('Trip started. Drive safe!'); route();
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
        <td>${thumb(r.start_photo)} ${thumb(r.end_photo)}</td><td class="wrap">${esc(r.notes)}</td><td>${delBtn('trips', r.id)}</td></tr>`).join('')}
      </table></div>`;
    bindDeletes($('#list', main), () => load(qs));
  };
  bindFilters($('#flt', main), 'trips', load);
};

// --- CNG fuel
pages.fuel = async (main) => {
  await refreshVehicles();
  main.innerHTML = `<h1>CNG fueling</h1>
    <div class="card"><h2>Add CNG fill</h2><form id="f"><div class="fields">
      <label><span>Vehicle *</span>${vehicleSelect()}</label>
      <label><span>Date *</span><input type="date" name="date" value="${today()}" required></label>
      ${kmField('odometer', 'Odometer at fill (km)')}
      <label><span>Quantity (kg) *</span><input name="qty_kg" type="number" inputmode="decimal" step="0.01" min="0.01" required></label>
      <label><span>Price per kg (₹)</span><input name="price_per_kg" type="number" inputmode="decimal" step="0.01" min="0"></label>
      <label><span>Total amount (₹)</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="auto = qty × price"></label>
      <label><span>CNG station</span><input name="station" placeholder="e.g. IGL Sector 18"></label>
      <label class="full"><span>Notes</span><textarea name="notes"></textarea></label>
      ${photoField('photo', 'Bill / meter photo')}
    </div><div class="actions"><button class="primary" type="submit">Save CNG fill</button></div></form></div>
    <div class="card"><h2>History</h2>${filtersBar('flt')}<div id="list"></div></div>`;
  const f = $('#f', main);
  bindPhotoPickers(f); bindOdometer(f);
  const qty = $('[name=qty_kg]', f), price = $('[name=price_per_kg]', f), amt = $('[name=amount]', f);
  const calc = () => { if (qty.value && price.value && !amt.dataset.touched) amt.value = (qty.value * price.value).toFixed(2); };
  qty.oninput = calc; price.oninput = calc; amt.oninput = () => (amt.dataset.touched = amt.value ? '1' : '');
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/fuel', { method: 'POST', body: { ...formData(f), photo: f._photos.photo[0] } });
    toast('CNG fill saved'); route();
  }); };
  const load = async (qs) => {
    const rows = await api('/api/fuel?' + qs);
    const kg = rows.reduce((s, r) => s + r.qty_kg, 0), amount = rows.reduce((s, r) => s + r.amount, 0);
    $('#list', main).innerHTML = `<p class="muted">${rows.length} fills · <b>${fmt(kg, 2)} kg</b> · <b>${money(amount)}</b></p><div class="table-wrap"><table>
      <tr><th>Date</th><th>Vehicle</th>${state.user.role === 'admin' ? '<th>Driver</th>' : ''}<th>Odometer</th><th>Qty</th><th>₹/kg</th><th>Amount</th><th>Station</th><th>Photo</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.reg_no)}</td>${state.user.role === 'admin' ? `<td>${esc(r.driver_name)}</td>` : ''}
        <td>${fmt(r.odometer)}</td><td>${fmt(r.qty_kg, 2)} kg</td><td>${fmt(r.price_per_kg, 2)}</td><td><b>${money(r.amount)}</b></td>
        <td>${esc(r.station)}</td><td>${thumb(r.photo)}</td><td>${delBtn('fuel', r.id)}</td></tr>`).join('')}
      </table></div>`;
    bindDeletes($('#list', main), () => load(qs));
  };
  bindFilters($('#flt', main), 'fuel', load);
};

// --- oil change / service
pages.services = async (main) => {
  await refreshVehicles();
  main.innerHTML = `<h1>Oil change &amp; service</h1>
    <div class="card"><h2>Add service record</h2><form id="f"><div class="fields">
      <label><span>Vehicle *</span>${vehicleSelect()}</label>
      <label><span>Type *</span><select name="type" required>${Object.entries(SERVICE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
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
    $('#nexthint', f).textContent = $('[name=type]', f).value === 'oil_change' && v && odo
      ? `Leave blank for default: ${fmt(odo + v.oil_interval_km)} km (every ${fmt(v.oil_interval_km)} km)` : '';
  };
  f.oninput = hint; f.onchange = hint;
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

// --- vehicles (admin)
pages.vehicles = async (main) => {
  await refreshVehicles();
  const drivers = (state.drivers = await api('/api/drivers')).filter((d) => d.role === 'driver' && d.active);
  const driverOpts = (sel) => `<option value="">— none —</option>${drivers.map((d) => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`;
  main.innerHTML = `<h1>Vehicles</h1>
    <div class="card"><h2>Add vehicle</h2><form id="f"><div class="fields">
      <label><span>Registration no. *</span><input name="reg_no" required placeholder="DL01AB1234" style="text-transform:uppercase"></label>
      <label><span>Make / model</span><input name="model" placeholder="Maruti WagonR CNG"></label>
      <label><span>Fuel</span><select name="fuel_type"><option>CNG</option><option>CNG + Petrol</option><option>Petrol</option><option>Diesel</option><option>EV</option></select></label>
      <label><span>Current odometer (km)</span><input name="initial_km" type="number" min="0" step="0.1" value="0"></label>
      <label><span>Oil change every (km)</span><input name="oil_interval_km" type="number" min="100" value="5000"></label>
      <label><span>Assigned driver</span><select name="assigned_driver_id">${driverOpts()}</select></label>
    </div><div class="actions"><button class="primary" type="submit">Add vehicle</button></div></form></div>
    <div class="card"><h2>Fleet</h2><div class="table-wrap"><table>
      <tr><th>Reg. no.</th><th>Model</th><th>Fuel</th><th>Odometer</th><th>Oil interval</th><th>Driver</th><th>Oil change</th><th>Active</th></tr>
      ${state.vehicles.map((v) => `<tr data-v="${v.id}"><td><b>${esc(v.reg_no)}</b></td><td>${esc(v.model)}</td><td>${esc(v.fuel_type)}</td>
        <td>${fmt(v.current_km)} km</td>
        <td><input type="number" min="100" value="${v.oil_interval_km}" data-k="oil_interval_km" style="width:100px"></td>
        <td><select data-k="assigned_driver_id">${driverOpts(v.assigned_driver_id)}</select></td>
        <td>${oilBadge(v)}</td><td><input type="checkbox" data-k="active" ${v.active ? 'checked' : ''}></td></tr>`).join('')}
    </table></div></div>`;
  const f = $('#f', main);
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/vehicles', { method: 'POST', body: formData(f) }); toast('Vehicle added'); route();
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
      <tr><th>Name</th><th>Username</th><th>Role</th><th>Phone</th><th>Licence</th><th>Status</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.phone)}</td>
        <td>${esc(u.license_no)}</td><td><span class="badge ${u.active ? 'ok' : ''}">${u.active ? 'active' : 'disabled'}</span></td>
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
    </div><div class="actions"><button class="primary" type="submit">Update password</button></div></form></div>`;
  const f = $('#f', main);
  f.onsubmit = (e) => { e.preventDefault(); submitting(f, async () => {
    await api('/api/me/password', { method: 'POST', body: formData(f) }); toast('Password updated'); f.reset();
  }); };
};

// ------------------------------------------------------------------ shell & routing
const NAV = [
  ['dashboard', '📊', 'Dashboard'], ['trips', '🚗', 'Daily km'], ['fuel', '⛽', 'CNG'],
  ['services', '🛢', 'Service'], ['accidents', '⚠️', 'Accidents'],
  ['vehicles', '🚐', 'Vehicles', 'admin'], ['drivers', '👤', 'Drivers', 'admin'], ['profile', '⚙️', 'Profile'],
];

function renderLogin() {
  $('#app').innerHTML = `<div class="login card">
    <img class="logo" src="/icon.svg" alt=""><h1>Fleet Driver Monitor</h1>
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

function renderShell() {
  const items = NAV.filter((n) => !n[3] || n[3] === state.user.role);
  $('#app').innerHTML = `<header class="topbar"><span class="title">🚐 Fleet Monitor</span>
      <span class="muted" style="color:#ccfbf1">${esc(state.user.name)}</span><button id="lo">Log out</button></header>
    <div class="shell"><nav class="side">${items.map(([k, i, l]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${i}</span>${l}</a>`).join('')}</nav>
    <main id="main"></main></div>`;
  $('#lo').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); state.user = null; render(); };
}

async function route() {
  if (!state.user) return;
  let page = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const nav = NAV.find((n) => n[0] === page);
  if (!nav || (nav[3] && nav[3] !== state.user.role)) page = 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  const main = $('#main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (state.user.role === 'admin' && !state.drivers) state.drivers = await api('/api/drivers');
    if (!state.vehicles.length) await refreshVehicles();
    await pages[page](main);
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
}
window.addEventListener('hashchange', route);
render();
