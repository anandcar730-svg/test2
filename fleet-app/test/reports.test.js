'use strict';
// Monthly fuel report: numbers, permissions, PDF file.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { textWidth, encode } = require('../pdf.js');

// pdf helpers
assert.equal(textWidth('0123456789', 10), 55.6, 'digit widths');
assert.deepEqual(encode('₹5 – ok'), [...Buffer.from('Rs. 5 ', 'latin1')].concat([0x96]).concat([...Buffer.from(' ok')]));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-rep-'));
process.env.DATA_DIR = dir;
const { server } = require('../server.js');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (p, method = 'GET', body, raw = false) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const admin = client(), ravi = client(), suresh = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const r1 = (await admin('/api/drivers', 'POST', { name: 'Ravi Kumar', username: 'ravi', password: 'ravi123' })).data.id;
  await admin('/api/drivers', 'POST', { name: 'Suresh', username: 'suresh', password: 'suresh123' });
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', model: 'Toyota Innova', fuel_type: 'Diesel', initial_km: 10000, assigned_driver_id: r1 })).data.id;
  const van = (await admin('/api/vehicles', 'POST', { reg_no: 'TN22BB5678', model: 'Tata Winger', fuel_type: 'Diesel', initial_km: 50000 })).data.id;
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  await suresh('/api/login', 'POST', { username: 'suresh', password: 'suresh123' });

  // October: one fill. November: three fills by two drivers.
  await ravi('/api/fuel', 'POST', { vehicle_id: car, date: '2026-10-20', odometer: 10000, quantity: 40, price_per_unit: 90 });
  await ravi('/api/fuel', 'POST', { vehicle_id: car, date: '2026-11-02', odometer: 10500, quantity: 40, price_per_unit: 92, station: 'IOCL, Anna Salai' });
  await suresh('/api/fuel', 'POST', { vehicle_id: car, date: '2026-11-15', odometer: 11000, quantity: 38, price_per_unit: 92 });
  await ravi('/api/fuel', 'POST', { vehicle_id: car, date: '2026-11-28', odometer: 11520, quantity: 40, amount: 3700 });
  await admin('/api/fuel', 'POST', { vehicle_id: van, date: '2026-11-10', odometer: 50300, quantity: 60, price_per_unit: 92 });

  const r = (await admin(`/api/reports/fuel?vehicle=${car}&month=2026-11`)).data;
  assert.equal(r.month_label, 'November 2026');
  assert.equal(r.fill_count, 3);
  assert.equal(r.amount, 3680 + 3496 + 3700);
  assert.deepEqual(r.by_type.map((t) => [t.fuel_type, t.quantity, t.unit]), [['Diesel', 118, 'L']]);
  assert.equal(r.km, 1520, 'last Nov reading 11,520 − last Oct reading 10,000');
  assert.equal(r.mileage, 13.08, '(11520-10500) / (38+40) = 13.08'); assert.equal(r.mileage_method, 'fill-to-fill');
  assert.equal(r.cost_per_km, +(10876 / 1520).toFixed(2));
  assert.equal(r.avg_price, +(10876 / 118).toFixed(2));
  assert.equal(r.previous.amount, 3600); assert.equal(r.previous.month_label, 'October 2026');
  assert.equal(r.change.amount_pct, +(((10876 - 3600) / 3600) * 100).toFixed(1));
  assert.deepEqual(r.drivers.map((d) => [d.driver, d.fills]), [['Ravi Kumar', 2], ['Suresh', 1]]);
  assert.equal(r.daily.length, 30); assert.equal(r.daily[1].amount, 3680);
  assert.equal((await admin(`/api/reports/fuel?vehicle=${car}&month=2026-13`)).status, 400);

  // permissions: Ravi – his own vehicle only; Suresh (no vehicle) – nothing; all-vehicles is admin-only
  assert.equal((await ravi(`/api/reports/fuel?vehicle=${car}&month=2026-11`)).status, 200);
  assert.equal((await ravi(`/api/reports/fuel?vehicle=${van}&month=2026-11`)).status, 403);
  assert.equal((await suresh(`/api/reports/fuel?vehicle=${car}&month=2026-11`)).status, 403);
  assert.equal((await ravi('/api/reports/fuel?vehicle=all&month=2026-11')).status, 403);

  const fleet = (await admin('/api/reports/fuel?vehicle=all&month=2026-11')).data.fleet;
  assert.deepEqual(fleet.vehicles.map((v) => v.reg_no), ['TN01AB1234', 'TN22BB5678']);
  assert.equal(fleet.total.amount, 10876 + 5520);

  // organisation name on the PDF
  assert.equal((await ravi('/api/reports/settings', 'PUT', { org_name: 'X' })).status, 403);
  await admin('/api/reports/settings', 'PUT', { org_name: 'Shalom Church' });

  // PDF – one vehicle
  const pdf = await admin(`/api/reports/fuel.pdf?vehicle=${car}&month=2026-11`, 'GET', null, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /fuel-report-2026-11-TN01AB1234\.pdf/);
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.buf.subarray(-6).toString(), /%%EOF/);
  const one = path.join(dir, 'one.pdf'); fs.writeFileSync(one, pdf.buf);
  // all vehicles
  const all = await admin('/api/reports/fuel.pdf?vehicle=all&month=2026-11', 'GET', null, true);
  const allFile = path.join(dir, 'all.pdf'); fs.writeFileSync(allFile, all.buf);
  assert.equal((await ravi(`/api/reports/fuel.pdf?vehicle=${van}&month=2026-11`, 'GET', null, true)).status, 403);

  // read the PDFs back with a real PDF tool when it is installed
  let tool = true;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { tool = false; }
  if (tool) {
    const txt = execFileSync('pdftotext', ['-layout', one, '-']).toString();
    for (const s of ['SHALOM CHURCH', 'Fuel report – TN01AB1234', 'November 2026', 'Rs. 10,876.00', '1,520 km', '13.08', 'IOCL, Anna Salai', 'Suresh', 'Page 1 of 1']) {
      assert.ok(txt.includes(s), `PDF text contains "${s}"`);
    }
    const txt2 = execFileSync('pdftotext', ['-layout', allFile, '-']).toString();
    assert.match(txt2, /all vehicles/); assert.match(txt2, /Rs\. 16,396\.00/); assert.match(txt2, /Page 3 of 3/);
    const info = execFileSync('pdfinfo', [allFile]).toString();
    assert.match(info, /Pages:\s+3/); assert.match(info, /A4/);
  } else console.log('  (pdftotext not installed – PDF text check skipped)');
  if (process.env.KEEP_PDF) { fs.copyFileSync(one, process.env.KEEP_PDF + '/one.pdf'); fs.copyFileSync(allFile, process.env.KEEP_PDF + '/all.pdf'); }

  console.log('✔ reports tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
