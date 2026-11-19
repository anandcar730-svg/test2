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
  assert.deepEqual(dash.data.month.fuel.map((x) => [x.fuel_type, x.quantity, x.unit]), [['CNG', 13, 'kg']]);
  assert.equal(dash.data.month.fuel_amount, 988);
  const dv = dash.data.vehicles[0];
  assert.equal(dv.current_km, 10180);
  assert.equal(dv.oil_due_km, 15180);
  assert.equal(dv.mileage, 26); // 130 km / 5 kg
  assert.equal(dv.mileage_unit, 'km/kg');
  const csv = await admin('/api/export/fuel.csv');
  assert.match(csv.data, /DL01AB1234/);

  // Petrol, Diesel and EV vehicles
  const pv = await admin('/api/vehicles', 'POST', { reg_no: 'KA01P1', fuel_type: 'Petrol', initial_km: 500 });
  const ev = await admin('/api/vehicles', 'POST', { reg_no: 'KA01E1', fuel_type: 'EV', initial_km: 100 });
  const dv2 = await admin('/api/vehicles', 'POST', { reg_no: 'KA01D1', fuel_type: 'Diesel', initial_km: 0 });
  assert.equal((await admin('/api/vehicles', 'POST', { reg_no: 'X1', fuel_type: 'Hydrogen' })).status, 400);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: pv.data.id, date, odometer: 500, quantity: 20, price_per_unit: 102 })).data.id > 0, true);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: pv.data.id, date, odometer: 800, quantity: 15, price_per_unit: 102 })).status, 200);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: dv2.data.id, date, odometer: 50, quantity: 30, amount: 2700 })).status, 200);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 100, quantity: 30, price_per_unit: 12, battery_start_pct: 20, battery_end_pct: 90 })).status, 200);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 340, quantity: 32, amount: 0, station: 'Home' })).status, 200);
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 340, quantity: 5, battery_start_pct: 90, battery_end_pct: 20, amount: 1 })).status, 400, 'battery % must rise');
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: vid, fuel_type: 'Petrol', date, odometer: 10190, quantity: 2, amount: 204 })).status, 200, 'dual-fuel: explicit type');
  assert.equal((await driver('/api/services', 'POST', { vehicle_id: ev.data.id, date, odometer: 340, type: 'oil_change' })).status, 400, 'no oil change for EV');
  const fl = await admin('/api/fuel?fuel_type=EV');
  assert.equal(fl.data.length, 2);
  assert.equal(fl.data[0].unit, 'kWh');
  assert.ok(fl.data.some((r) => r.battery_end_pct === 90));
  const d2 = (await admin('/api/dashboard')).data;
  const byType = Object.fromEntries(d2.month.fuel.map((x) => [x.fuel_type, x]));
  assert.equal(byType.Petrol.quantity, 37); assert.equal(byType.Petrol.unit, 'L');
  assert.equal(byType.Diesel.quantity, 30); assert.equal(byType.EV.quantity, 62); assert.equal(byType.EV.unit, 'kWh');
  const vEv = d2.vehicles.find((x) => x.reg_no === 'KA01E1'), vP = d2.vehicles.find((x) => x.reg_no === 'KA01P1');
  assert.equal(vEv.oil_status, 'na');
  assert.equal(vEv.mileage, 7.5); assert.equal(vEv.mileage_unit, 'km/kWh'); // 240 km / 32 kWh
  assert.equal(vP.mileage, 20); assert.equal(vP.mileage_unit, 'km/L');     // 300 km / 15 L
  assert.equal(d2.vehicles.find((x) => x.reg_no === 'DL01AB1234').mileage, 26, 'dual-fuel mileage uses CNG only');
  assert.match((await admin('/api/export/fuel.csv')).data, /fuel_type/);

  // EV usage with the odometer only (home/office charging, no kWh or bill)
  const evOnly = await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 400 });
  assert.equal(evOnly.status, 200, JSON.stringify(evOnly.data));
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 390 })).status, 400, 'reading cannot go backwards');
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: ev.data.id, date, odometer: 50 })).status, 400, 'not below starting odometer');
  assert.equal((await driver('/api/fuel', 'POST', { vehicle_id: pv.data.id, date, odometer: 900 })).status, 400, 'petrol still needs litres');
  const evRow = (await admin('/api/fuel?fuel_type=EV')).data.find((r) => r.id === evOnly.data.id);
  assert.deepEqual([evRow.quantity, evRow.amount, evRow.price_per_unit, evRow.odometer], [0, 0, null, 400]);
  const evSum = (await admin(`/api/vehicles/${ev.data.id}/summary`)).data;
  assert.equal(evSum.month_odometer_km, 300, 'km from odometer: 400 - starting 100');
  assert.equal(evSum.month_km, 0, 'no trips logged');
  assert.equal(evSum.vehicle.mileage, 7.5, 'odometer-only readings do not distort km/kWh');
  const d3 = (await admin('/api/dashboard')).data;
  assert.equal(d3.vehicles.find((x) => x.reg_no === 'KA01E1').month_odometer_km, 300);
  assert.ok(d3.month.fleet_km >= 300);

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
