'use strict';
// Vehicles section: fleet overview for everyone, details edited by drivers and admin, change history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-vsec-'));
const { server } = require('../server.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (p, method = 'GET', body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const admin = client(), ravi = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const r1 = (await admin('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' })).data.id;
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', model: 'Innova', fuel_type: 'Diesel', initial_km: 1000, assigned_driver_id: r1 })).data.id;
  const old = (await admin('/api/vehicles', 'POST', { reg_no: 'TN09ZZ0009', model: 'Old jeep', fuel_type: 'Diesel', initial_km: 5 })).data.id;
  await admin(`/api/vehicles/${old}`, 'PUT', { active: false });
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });

  // ---- driver updates details + photo; history records it with his name
  const upd = await ravi(`/api/documents/${car}`, 'PUT', { color: 'White', insurance_upto: day(10), insurance_company: 'United India',
    files: { vehicle_photo: PNG, insurance_file: PDF } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.match(upd.data.vehicle_photo, /\.png$/);
  assert.equal((await ravi(`/api/documents/${car}`, 'PUT', { files: { vehicle_photo: PDF } })).status, 400, 'vehicle photo must be a picture');
  assert.equal((await ravi(`/api/documents/${old}`, 'PUT', { color: 'Red' })).status, 400, 'inactive vehicle: not for drivers');
  assert.equal((await ravi(`/api/vehicles/${car}`, 'PUT', { model: 'X' })).status, 403, 'basics stay admin-only');
  await admin(`/api/documents/${car}`, 'PUT', { insurance_upto: day(300) });
  await admin(`/api/vehicles/${car}`, 'PUT', { model: 'Innova Crysta' });
  const sum = (await ravi(`/api/vehicles/${car}/summary`)).data;
  assert.equal(sum.log.length >= 3, true);
  const [last, prev, first] = sum.log;
  assert.equal(last.by_name, 'Fleet Admin'); assert.match(last.text, /Model: Innova → Innova Crysta/);
  assert.match(prev.text, new RegExp(`Insurance valid till: ${day(10)} → ${day(300)}`));
  assert.equal(first.by_name, 'Ravi');
  assert.match(first.text, /Colour: — → White/); assert.match(first.text, /Vehicle photo added/); assert.match(first.text, /Insurance copy added/);
  // no-op save writes no history
  const n = sum.log.length;
  await ravi(`/api/documents/${car}`, 'PUT', { color: 'White' });
  assert.equal((await ravi(`/api/vehicles/${car}/summary`)).data.log.length, n);

  // ---- parts by driver are logged
  await ravi('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', brand: 'Exide', serial_no: 'EX-9', installed_on: day(-700), warranty_months: 24 });
  assert.match((await admin(`/api/vehicles/${car}/summary`)).data.log[0].text, /Added Battery \(S\/N EX-9\)/);

  // ---- fleet overview
  await ravi('/api/checks', 'POST', { vehicle_id: car, oil: 'low', coolant: 'ok' });
  await ravi('/api/complaints', 'POST', { vehicle_id: car, category: 'mechanical', description: 'AC weak' });
  const fleetDriver = (await ravi('/api/fleet')).data;
  assert.deepEqual(fleetDriver.map((v) => v.reg_no), ['TN01AB1234'], 'drivers see active vehicles');
  const f = (await admin('/api/fleet')).data;
  assert.deepEqual(f.map((v) => [v.reg_no, v.active]), [['TN01AB1234', 1], ['TN09ZZ0009', 0]], 'admin sees inactive too, last');
  const c = f[0];
  assert.deepEqual([c.model, c.driver_name, c.color, c.current_km], ['Innova Crysta', 'Ravi', 'White', 1000]);
  assert.match(c.photo, /\.png$/);
  assert.deepEqual([c.papers_known, c.papers_expired, c.papers_due], [1, [], []]);
  assert.equal(c.battery.serial_no, 'EX-9'); assert.equal(c.battery.state, 'due');
  assert.deepEqual(c.check_today, { done: true, low: true });
  assert.equal(c.open_complaints, 1);
  assert.equal(f[1].check_today.done, false);

  console.log('✔ vehicles section tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
