'use strict';
/**
 * Monthly fuel report per vehicle (and an all-vehicles summary), as JSON for the page and as a PDF download.
 */
const { PDF } = require('./pdf');

const TEAL = [15, 118, 110], MUTED = [107, 114, 128], DARK = [17, 24, 39], LIGHT = [240, 253, 250];

module.exports = function createReports({ all, get, route, bad, HttpError, FUELS, primaryFuel, odometerKm, getSetting, setSetting }) {
  const monthOk = (m) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') ? m : bad('Choose a month'));
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
  const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const daysIn = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
  const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const rs = (x) => (x === null || x === undefined ? '—' : `Rs. ${Number(x).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`);

  /** Numbers for one vehicle and month (no rows) – also used for the previous month and the fleet summary. */
  function totals(v, month) {
    const fills = all(`SELECT * FROM fuel_logs WHERE vehicle_id=? AND substr(date,1,7)=? AND (qty_kg > 0 OR amount > 0)
                       ORDER BY date, odometer IS NULL, odometer, id`, v.id, month);
    const byType = {};
    for (const f of fills) {
      const t = (byType[f.fuel_type] ||= { fuel_type: f.fuel_type, unit: FUELS[f.fuel_type]?.unit || '', quantity: 0, amount: 0, fills: 0 });
      t.quantity += f.qty_kg; t.amount += f.amount; t.fills++;
    }
    const tripKm = get(`SELECT COALESCE(SUM(end_km-start_km),0) AS km FROM trips WHERE vehicle_id=? AND end_km IS NOT NULL AND substr(date,1,7)=?`, v.id, month).km;
    const km = Math.max(tripKm, odometerKm(v.id, month));
    const main = primaryFuel(v.fuel_type);
    const mainFills = fills.filter((f) => f.fuel_type === main && f.qty_kg > 0);
    const mainQty = mainFills.reduce((s, f) => s + f.qty_kg, 0);
    // Mileage: fill-to-fill inside the month when there are 2+ readings, else month km ÷ fuel
    let mileage = null, method = null;
    const withOdo = mainFills.filter((f) => f.odometer !== null);
    if (withOdo.length >= 2) {
      const first = mainFills.indexOf(withOdo[0]), last = mainFills.indexOf(withOdo[withOdo.length - 1]);
      const used = mainFills.slice(first + 1, last + 1).reduce((s, f) => s + f.qty_kg, 0);
      const dist = withOdo[withOdo.length - 1].odometer - withOdo[0].odometer;
      if (used > 0 && dist > 0) { mileage = dist / used; method = 'fill-to-fill'; }
    }
    if (mileage === null && km > 0 && mainQty > 0) { mileage = km / mainQty; method = 'km ÷ fuel (approx.)'; }
    const amount = fills.reduce((s, f) => s + f.amount, 0);
    const mainAmount = mainFills.reduce((s, f) => s + f.amount, 0);
    return {
      fills, by_type: Object.values(byType), amount: +amount.toFixed(2), fill_count: fills.length, km: +km.toFixed(1), main_fuel: main,
      unit: FUELS[main]?.unit || '', mileage: mileage === null ? null : +mileage.toFixed(2), mileage_method: method,
      cost_per_km: km > 0 ? +(amount / km).toFixed(2) : null, avg_price: mainQty > 0 ? +(mainAmount / mainQty).toFixed(2) : null,
    };
  }

  function vehicleReport(vehicleId, month) {
    const v = get(`SELECT v.*, u.name AS driver_name FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_driver_id WHERE v.id=?`, vehicleId) || bad('Vehicle not found');
    const cur = totals(v, month);
    const prev = totals(v, prevMonth(month));
    const names = Object.fromEntries(all(`SELECT id, name FROM users`).map((u) => [u.id, u.name]));
    const drivers = {};
    for (const f of cur.fills) {
      const d = (drivers[f.driver_id] ||= { driver: names[f.driver_id] || '?', fills: 0, amount: 0, quantity: {} });
      d.fills++; d.amount += f.amount; d.quantity[f.fuel_type] = (d.quantity[f.fuel_type] || 0) + f.qty_kg;
    }
    const daily = Array.from({ length: daysIn(month) }, (_, i) => ({ day: i + 1, amount: 0 }));
    for (const f of cur.fills) daily[Number(f.date.slice(8, 10)) - 1].amount += f.amount;
    const change = (a, b) => (b ? +(((a - b) / b) * 100).toFixed(1) : null);
    const { fills, ...summary } = cur;
    return {
      vehicle: { id: v.id, reg_no: v.reg_no, model: v.model, fuel_type: v.fuel_type, driver_name: v.driver_name, active: v.active },
      month, month_label: monthLabel(month), ...summary,
      rows: fills.map((f) => ({ id: f.id, date: f.date, fuel_type: f.fuel_type, unit: FUELS[f.fuel_type]?.unit || '', odometer: f.odometer, quantity: f.qty_kg,
        price: f.price_per_kg, amount: f.amount, station: f.station, driver: names[f.driver_id] || '?', source: f.source })),
      drivers: Object.values(drivers).sort((a, b) => b.amount - a.amount).map((d) => ({ ...d, amount: +d.amount.toFixed(2) })),
      daily,
      previous: { month: prevMonth(month), month_label: monthLabel(prevMonth(month)), amount: prev.amount, km: prev.km, mileage: prev.mileage, cost_per_km: prev.cost_per_km },
      change: { amount_pct: change(cur.amount, prev.amount), km_pct: change(cur.km, prev.km), mileage_pct: cur.mileage && prev.mileage ? change(cur.mileage, prev.mileage) : null },
    };
  }

  function fleetReport(month, vehicleIds) {
    const vs = all(`SELECT * FROM vehicles ORDER BY reg_no`).filter((v) => vehicleIds.includes(v.id));
    const rows = vs.map((v) => ({ vehicle_id: v.id, reg_no: v.reg_no, model: v.model, active: v.active, ...(({ fills, ...t }) => t)(totals(v, month)) }))
      .filter((r) => r.active || r.fill_count || r.km);
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const amount = +sum('amount').toFixed(2), km = +sum('km').toFixed(1);
    return { month, month_label: monthLabel(month), vehicles: rows, total: { amount, km, fills: sum('fill_count'), cost_per_km: km > 0 ? +(amount / km).toFixed(2) : null } };
  }

  const allowedVehicles = (user) => (user.role === 'admin'
    ? all(`SELECT id FROM vehicles`).map((v) => v.id)
    : all(`SELECT id FROM vehicles WHERE active=1 AND assigned_driver_id=?`, user.id).map((v) => v.id));
  const vehicleFor = (user, id) => {
    const vid = Number(id);
    if (!allowedVehicles(user).includes(vid)) throw new HttpError(403, user.role === 'admin' ? 'Vehicle not found' : 'You can see reports for your own vehicle only');
    return vid;
  };

  // ------------------------------------------------------------------ PDF
  const orgName = () => getSetting('org_name') || 'Shalom Church';
  function headerBand(pdf, title, subtitle) {
    pdf.rect(0, 0, pdf.W, 74, { fill: TEAL });
    pdf.text(pdf.margin, 16, orgName().toUpperCase(), { size: 8.5, bold: true, color: [153, 246, 228] });
    pdf.text(pdf.margin, 30, title, { size: 18, bold: true, color: [255, 255, 255], maxWidth: pdf.W - 220 });
    pdf.text(pdf.W - pdf.margin, 32, subtitle, { size: 13, bold: true, color: [255, 255, 255], align: 'right' });
    pdf.y = 92;
  }
  function statBoxes(pdf, boxes) {
    const gap = 8, cols = 4, w = (pdf.W - pdf.margin * 2 - gap * (cols - 1)) / cols, h = 52;
    boxes.forEach((b, i) => {
      if (i && i % cols === 0) pdf.y += h + gap;
      const x = pdf.margin + (i % cols) * (w + gap);
      pdf.rect(x, pdf.y, w, h, { fill: LIGHT, stroke: [204, 251, 241] });
      pdf.text(x + 8, pdf.y + 8, b.label, { size: 7.5, color: MUTED, maxWidth: w - 16 });
      pdf.text(x + 8, pdf.y + 21, b.value, { size: 13, bold: true, color: DARK, maxWidth: w - 16 });
      if (b.note) pdf.text(x + 8, pdf.y + 38, b.note, { size: 7, color: b.noteColor || MUTED, maxWidth: w - 16 });
    });
    pdf.y += h + 16;
  }
  function sectionTitle(pdf, t) { pdf.ensure(40); pdf.text(pdf.margin, pdf.y, t, { size: 11.5, bold: true, color: TEAL }); pdf.y += 18; }
  function barChart(pdf, data) {
    const h = 90, x0 = pdf.margin + 34, w = pdf.W - pdf.margin * 2 - 34;
    pdf.ensure(h + 30);
    const max = Math.max(1, ...data.map((d) => d.amount));
    const top = pdf.y;
    for (const f of [0, 0.5, 1]) {
      const y = top + h - h * f;
      pdf.line(x0, y, x0 + w, y, { color: [229, 231, 235] });
      pdf.text(x0 - 4, y - 4, f ? num(max * f) : '0', { size: 6.5, color: MUTED, align: 'right' });
    }
    const bw = w / data.length;
    data.forEach((d, i) => {
      const bh = (d.amount / max) * h;
      if (bh > 0) pdf.rect(x0 + i * bw + bw * 0.18, top + h - bh, bw * 0.64, bh, { fill: [20, 184, 166] });
      if (data.length <= 31 && (i === 0 || (i + 1) % 5 === 0)) pdf.text(x0 + i * bw + bw / 2, top + h + 4, String(d.day), { size: 6.5, color: MUTED, align: 'center' });
    });
    pdf.y = top + h + 22;
  }
  const pct = (p, goodWhenUp) => (p === null || p === undefined ? null
    : { text: `${p > 0 ? '+' : ''}${p}% vs last month`, color: (p > 0) === goodWhenUp ? [22, 163, 74] : p === 0 ? MUTED : [220, 38, 38] });

  function drawVehicle(pdf, r, first) {
    if (!first) pdf.addPage();
    headerBand(pdf, `Fuel report – ${r.vehicle.reg_no}`, r.month_label);
    pdf.text(pdf.margin, pdf.y, `${[r.vehicle.model, r.vehicle.fuel_type, r.vehicle.driver_name && `Driver: ${r.vehicle.driver_name}`].filter(Boolean).join('  ·  ')}`,
      { size: 9.5, color: MUTED, maxWidth: pdf.W - pdf.margin * 2 });
    pdf.y += 20;
    const qty = r.by_type.map((t) => `${num(t.quantity, 2)} ${t.unit}`).join(' + ') || '0';
    const ca = pct(r.change.amount_pct, false), cm = pct(r.change.mileage_pct, true), ck = pct(r.change.km_pct, true);
    statBoxes(pdf, [
      { label: 'Fuel / energy used', value: qty, note: r.by_type.length > 1 ? r.by_type.map((t) => t.fuel_type).join(' + ') : r.by_type[0]?.fuel_type },
      { label: 'Total amount', value: rs(r.amount), note: ca?.text, noteColor: ca?.color },
      { label: 'Distance driven', value: `${num(r.km, 1)} km`, note: ck?.text, noteColor: ck?.color },
      { label: `Mileage (km/${r.unit})`, value: r.mileage ? num(r.mileage, 2) : '—', note: cm?.text || r.mileage_method, noteColor: cm?.color },
      { label: 'Cost per km', value: r.cost_per_km !== null ? rs(r.cost_per_km) : '—', note: r.previous.cost_per_km ? `last month ${rs(r.previous.cost_per_km)}` : '' },
      { label: `Average price per ${r.unit}`, value: r.avg_price !== null ? rs(r.avg_price) : '—' },
      { label: 'Fills / charges', value: String(r.fill_count) },
      { label: `Last month (${r.previous.month_label})`, value: rs(r.previous.amount), note: `${num(r.previous.km, 1)} km` },
    ]);
    sectionTitle(pdf, 'Amount spent per day');
    barChart(pdf, r.daily);
    sectionTitle(pdf, `All fills (${r.rows.length})`);
    if (!r.rows.length) { pdf.text(pdf.margin, pdf.y, 'No fuel or charging recorded this month.', { size: 9, color: MUTED }); pdf.y += 20; }
    else {
      pdf.table([
        { label: 'Date', width: 52 }, { label: 'Fuel', width: 40 }, { label: 'Odometer', width: 56, align: 'right' },
        { label: 'Quantity', width: 58, align: 'right' }, { label: 'Rate', width: 52, align: 'right' }, { label: 'Amount', width: 70, align: 'right', bold: true },
        { label: 'Station', width: 102 }, { label: 'By', width: 85 },
      ], r.rows.map((f) => [
        f.date.split('-').reverse().join('-'), f.fuel_type, f.odometer === null ? '—' : num(f.odometer), `${num(f.quantity, 2)} ${f.unit}`,
        f.price ? num(f.price, 2) : '—', rs(f.amount), `${f.station || ''}${f.source === 'loyverse' ? ' (POS)' : ''}`, f.driver,
      ]), { totals: ['Total', '', '', r.by_type.map((t) => `${num(t.quantity, 2)} ${t.unit}`).join(' + '), '', rs(r.amount), '', `${r.fill_count} fill(s)`] });
      pdf.y += 14;
    }
    if (r.drivers.length) {
      sectionTitle(pdf, 'By driver');
      pdf.table([{ label: 'Driver', width: 200 }, { label: 'Fills', width: 60, align: 'right' }, { label: 'Quantity', width: 130, align: 'right' }, { label: 'Amount', width: 125, align: 'right', bold: true }],
        r.drivers.map((d) => [d.driver, String(d.fills), Object.entries(d.quantity).map(([t, q]) => `${num(q, 2)} ${FUELS[t]?.unit || ''}`).join(' + '), rs(d.amount)]));
    }
  }

  function drawFleet(pdf, f) {
    headerBand(pdf, 'Fuel report – all vehicles', f.month_label);
    statBoxes(pdf, [
      { label: 'Total fuel amount', value: rs(f.total.amount) },
      { label: 'Distance driven', value: `${num(f.total.km, 1)} km` },
      { label: 'Fuel cost per km', value: f.total.cost_per_km !== null ? rs(f.total.cost_per_km) : '—' },
      { label: 'Fills / charges', value: String(f.total.fills) },
    ]);
    sectionTitle(pdf, 'Per vehicle');
    pdf.table([
      { label: 'Vehicle', width: 90, bold: true }, { label: 'Fuel used', width: 96, align: 'right' }, { label: 'Amount', width: 84, align: 'right' },
      { label: 'km', width: 58, align: 'right' }, { label: 'Mileage', width: 64, align: 'right' }, { label: 'Cost/km', width: 64, align: 'right' }, { label: 'Fills', width: 59, align: 'right' },
    ], f.vehicles.map((v) => [v.reg_no, v.by_type.map((t) => `${num(t.quantity, 1)} ${t.unit}`).join(' + ') || '—', rs(v.amount), num(v.km, 0),
      v.mileage ? `${num(v.mileage, 1)} km/${v.unit}` : '—', v.cost_per_km !== null ? num(v.cost_per_km, 2) : '—', String(v.fill_count)]),
    { totals: ['Total', '', rs(f.total.amount), num(f.total.km, 0), '', f.total.cost_per_km !== null ? num(f.total.cost_per_km, 2) : '—', String(f.total.fills)] });
  }

  function buildPdf({ vehicleReports, fleet, title }) {
    const pdf = new PDF({ title, author: orgName() });
    let first = true;
    if (fleet) { drawFleet(pdf, fleet); first = false; }
    for (const r of vehicleReports) { drawVehicle(pdf, r, first); first = false; }
    const made = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    return pdf.output(() => `${orgName()} · Fuel report · generated ${made}`);
  }

  // ------------------------------------------------------------------ routes
  route('GET', '/api/reports/fuel', ({ user, query }) => {
    const month = monthOk(query.get('month'));
    if (query.get('vehicle') === 'all') {
      if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
      return { fleet: fleetReport(month, allowedVehicles(user)) };
    }
    return vehicleReport(vehicleFor(user, query.get('vehicle')), month);
  });
  route('GET', '/api/reports/fuel.pdf', ({ user, query }) => {
    const month = monthOk(query.get('month'));
    let body, name;
    if (query.get('vehicle') === 'all') {
      if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
      const fleet = fleetReport(month, allowedVehicles(user));
      const reports = fleet.vehicles.map((v) => vehicleReport(v.vehicle_id, month));
      body = buildPdf({ fleet, vehicleReports: reports, title: `Fuel report ${month} – all vehicles` });
      name = `fuel-report-${month}-all-vehicles.pdf`;
    } else {
      const r = vehicleReport(vehicleFor(user, query.get('vehicle')), month);
      body = buildPdf({ vehicleReports: [r], title: `Fuel report ${month} – ${r.vehicle.reg_no}` });
      name = `fuel-report-${month}-${r.vehicle.reg_no}.pdf`;
    }
    return { __file: { name, type: 'application/pdf', body } };
  });
  route('GET', '/api/reports/settings', () => ({ org_name: orgName() }));
  route('PUT', '/api/reports/settings', { auth: 'admin' }, ({ body }) => {
    const v = String(body.org_name ?? '').trim().slice(0, 80);
    setSetting('org_name', v || null);
    return { org_name: orgName() };
  });

  return { vehicleReport, fleetReport, buildPdf };
};
