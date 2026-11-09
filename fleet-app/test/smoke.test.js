'use strict';
// End-to-end smoke test: boots the server on a temp DB and exercises every feature.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
const { server } = require('../server.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (p, method = 'GET', body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  const admin = client(), driver = client();

  assert.equal((await admin('/api/me')).status, 401);
  assert.equal((await admin('/api/login', 'POST', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' })).status, 200);

  const d = await admin('/api/drivers', 'POST', { name: 'Ravi Kumar', username: 'ravi', password: 'ravi123', phone: '9999999999' });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const v = await admin('/api/vehicles', 'POST', { reg_no: 'dl01ab1234', model: 'WagonR CNG', initial_km: 10000, oil_interval_km: 5000, assigned_driver_id: d.data.id });
  assert.equal(v.status, 200);
  const vid = v.data.id;

  assert.equal((await driver('/api/login', 'POST', { username: 'ravi', password: 'ravi123' })).status, 200);
  assert.equal((await driver('/api/drivers')).status, 403, 'driver cannot list users');

  // Daily km
  assert.equal((await driver('/api/trips', 'POST', { vehicle_id: vid, start_km: 9000 })).status, 400, 'start below odometer rejected');
  const t = await driver('/api/trips', 'POST', { vehicle_id: vid, start_km: 10000, start_photo: PNG });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.equal((await driver('/api/trips', 'POST', { vehicle_id: vid, start_km: 10000 })).status, 400, 'one open trip per vehicle');
  assert.equal((await driver(`/api/trips/${t.data.id}/end`, 'PUT', { end_km: 9999 })).status, 400);
  const end = await driver(`/api/trips/${t.data.id}/end`, 'PUT', { end_km: 10180, end_photo: PNG });
  assert.equal(end.data.distance_km, 180);

  // CNG
  const date = new Date().toISOString().slice(0, 10);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: vid, date, odometer: 10050, qty_kg: 8, price_per_kg: 76 })).status, 200);
  const f2 = await driver('/api/fuel', 'POST', { vehicle_id: vid, date, odometer: 10180, qty_kg: 5, amount: 380, photo: PNG });
  assert.equal(f2.status, 200);

  // Oil change
  const s = await driver('/api/services', 'POST', { vehicle_id: vid, date, odometer: 10180, type: 'oil_change', cost: 1800, garage: 'ABC Motors' });
  assert.equal(s.status, 200, JSON.stringify(s.data));

  // Accident
  assert.equal((await driver('/api/accidents', 'POST', { vehicle_id: vid, occurred_at: date + 'T10:00', odometer: 10180, description: 'x' })).status, 400, 'photo required');
  const a = await driver('/api/accidents', 'POST', { vehicle_id: vid, occurred_at: date + 'T10:00', odometer: 10180, description: 'Rear bumper hit at signal',
    severity: 'minor', lat: 28.6, lng: 77.2, photos: [PNG, PNG] });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const accs = await admin('/api/accidents');
  assert.equal(accs.data[0].photos.length, 2);
  const photo = await driver('/uploads/' + accs.data[0].photos[0]);
  assert.equal(photo.status, 200);
  assert.equal((await fetch(base + '/uploads/' + accs.data[0].photos[0])).status, 401, 'photos need login');
  assert.equal((await admin(`/api/accidents/${a.data.id}`, 'PUT', { status: 'closed', admin_notes: 'Repaired' })).status, 200);

  // Dashboard
  const dash = await admin('/api/dashboard');
  assert.equal(dash.data.today.km, 180);
  assert.equal(dash.data.month.fuel_kg, 13);
  assert.equal(dash.data.month.fuel_amount, 988);
  const dv = dash.data.vehicles[0];
  assert.equal(dv.current_km, 10180);
  assert.equal(dv.oil_due_km, 15180);
  assert.equal(dv.km_per_kg, 26); // 130 km / 5 kg
  const csv = await admin('/api/export/fuel.csv');
  assert.match(csv.data, /DL01AB1234/);

  // Driver sees only own data
  const other = await admin('/api/drivers', 'POST', { name: 'Other', username: 'other', password: 'other123' });
  const oc = client();
  await oc('/api/login', 'POST', { username: 'other', password: 'other123' });
  assert.equal((await oc('/api/trips')).data.length, 0);
  assert.equal((await oc('/api/delete-me', 'POST', {})).status, 404);
  // CSRF header required
  assert.equal((await fetch(base + '/api/fuel', { method: 'POST' })).status, 401);
  void other;

  console.log('✔ all smoke tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
