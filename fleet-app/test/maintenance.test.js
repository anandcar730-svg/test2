'use strict';
// Parts & warranties, wheels, daily oil/coolant check, complaints.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-maint-'));
const { server } = require('../server.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
  const admin = client(), ravi = client(), kumar = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const r1 = (await admin('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' })).data.id;
  const k1 = (await admin('/api/drivers', 'POST', { name: 'Kumar', username: 'kumar', password: 'kumar123' })).data.id;
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', fuel_type: 'Diesel', initial_km: 1000, assigned_driver_id: r1 })).data.id;
  const ev = (await admin('/api/vehicles', 'POST', { reg_no: 'TN07EV2024', fuel_type: 'EV', initial_km: 10 })).data.id;
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  await kumar('/api/login', 'POST', { username: 'kumar', password: 'kumar123' });

  // ---- Battery: warranty years → expiry; new battery replaces the old one
  const b1 = await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', brand: 'Exide', serial_no: 'EX-123', installed_on: '2024-01-31',
    warranty_months: 24, cost: 5600, photo: PNG });
  assert.equal(b1.status, 200, JSON.stringify(b1.data));
  assert.equal(b1.data.expiry_date, '2026-01-31'); assert.equal(b1.data.name, 'Battery'); assert.equal(b1.data.state, 'expired');
  assert.match(b1.data.photo, /\.png$/);
  assert.equal((await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', installed_on: '2025-01-31', warranty_months: 1 })).data.expiry_date,
    '2025-02-28', 'month-end handled');
  const b2 = (await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', brand: 'Amaron', serial_no: 'AM-777', installed_on: day(-10), warranty_months: 48 })).data;
  let sum = (await admin(`/api/vehicles/${car}/summary`)).data;
  assert.deepEqual(sum.parts.filter((p) => p.kind === 'battery').map((p) => [p.serial_no, p.status]),
    [['AM-777', 'active'], [null, 'replaced'], ['EX-123', 'replaced']]);
  assert.equal(b2.state, 'ok');
  // ---- Other part with an expiry date, due soon → dashboard alert
  const ext = (await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'other', name: 'Fire extinguisher', expiry_date: day(12) })).data;
  assert.equal(ext.state, 'due'); assert.equal(ext.days_left, 12);
  assert.equal((await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'other' })).status, 400, 'name needed');
  assert.equal((await ravi('/api/parts', 'POST', { vehicle_id: car, kind: 'other', name: 'x' })).status, 403, 'admin only');
  let dash = (await admin('/api/dashboard')).data;
  assert.deepEqual(dash.part_alerts.map((p) => p.name), ['Fire extinguisher']);
  assert.equal((await ravi('/api/dashboard')).data.part_alerts.length, 1, 'assigned driver sees it');
  assert.equal((await kumar('/api/dashboard')).data.part_alerts.length, 0, 'other drivers do not');
  // edit + mark replaced
  assert.equal((await admin(`/api/parts/${ext.id}`, 'PUT', { expiry_date: day(400) })).data.state, 'ok');
  assert.equal((await admin(`/api/parts/${ext.id}`, 'PUT', { status: 'replaced' })).data.state, 'replaced');

  // ---- Wheels
  const w = await ravi('/api/wheels', 'POST', { vehicle_id: car, date: day(0), odometer: 1200, kind: 'puncture', positions: ['RL'], cost: 150, garage: 'Roadside', photo: PNG });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  await admin('/api/wheels', 'POST', { vehicle_id: car, date: day(-1), kind: 'alignment', positions: 'ALL', cost: 600 });
  assert.equal((await ravi('/api/wheels', 'POST', { vehicle_id: car, date: day(0), kind: 'flying' })).status, 400);
  assert.equal((await ravi('/api/wheels', 'POST', { vehicle_id: car, date: day(0), kind: 'damage', positions: ['XX'] })).status, 400);
  sum = (await ravi(`/api/vehicles/${car}/summary`)).data;
  assert.deepEqual(sum.wheels.map((x) => [x.kind_label, x.positions, x.by_name]), [['Puncture repair', 'RL', 'Ravi'], ['Wheel alignment', 'ALL', 'Fleet Admin']]);
  assert.equal((await ravi(`/api/wheels/${w.data.id}`, 'DELETE')).status, 403);

  // ---- Daily oil & coolant check
  assert.equal((await ravi('/api/checks', 'POST', { vehicle_id: car, oil: 'ok' })).status, 400, 'coolant needed');
  assert.equal((await ravi('/api/checks', 'POST', { vehicle_id: car, oil: 'ok', coolant: 'ok' })).status, 200);
  const again = await ravi('/api/checks', 'POST', { vehicle_id: car, oil: 'low', coolant: 'topped_up', notes: 'Oil below min' });
  assert.equal(again.data.oil, 'low', 'second check same day updates it');
  const evc = await kumar('/api/checks', 'POST', { vehicle_id: ev, oil: 'low', coolant: 'ok' });
  assert.equal(evc.data.oil, null, 'EV: no engine oil');
  assert.equal((await ravi('/api/checks', 'POST', { vehicle_id: car, oil: 'ok', coolant: 'ok', date: day(1) })).status, 400, 'no future');
  const today = (await admin('/api/checks/today')).data;
  assert.deepEqual(today.map((c) => [c.reg_no, c.done]), [['TN01AB1234', true], ['TN07EV2024', true]]);
  dash = (await admin('/api/dashboard')).data;
  assert.equal(dash.fluid_alerts.length, 1); assert.equal(dash.fluid_alerts[0].reg_no, 'TN01AB1234');
  assert.equal((await ravi('/api/dashboard')).data.checks_today.length, 1, 'driver: own vehicle');
  assert.equal((await admin('/api/checks?vehicle=' + car)).data.length, 1);
  assert.equal((await kumar('/api/checks')).data.length, 1, 'driver sees own checks');

  // ---- Complaints, incl. damage left by another driver
  assert.equal((await kumar('/api/complaints', 'POST', { vehicle_id: car, category: 'other_driver', description: 'Rear bumper dent', photos: [PNG] })).status, 400,
    'must say who used it');
  assert.equal((await kumar('/api/complaints', 'POST', { vehicle_id: car, category: 'other_driver', other_user_id: r1, description: 'Rear bumper dent' })).status, 400,
    'photo needed for damage');
  assert.equal((await kumar('/api/complaints', 'POST', { vehicle_id: car, category: 'other_driver', other_user_id: k1, description: 'x', photos: [PNG] })).status, 400,
    'not yourself');
  const c1 = await kumar('/api/complaints', 'POST', { vehicle_id: car, category: 'other_driver', other_user_id: r1, description: 'Rear bumper dent, not there on Monday',
    photos: [PNG, PNG], priority: 'high', odometer: 1250 });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  await ravi('/api/complaints', 'POST', { vehicle_id: car, category: 'mechanical', title: 'AC not cooling', description: 'AC weak since yesterday' });
  await kumar('/api/complaints', 'POST', { vehicle_id: ev, category: 'other_driver', other_user_name: 'Pastor (borrowed for event)', description: 'Seat torn', photos: [PNG] });
  const all = (await admin('/api/complaints')).data;
  assert.equal(all.length, 3);
  assert.equal(all[0].priority, 'high', 'high priority first');
  assert.deepEqual([all[0].other_user, all[0].reported_by_name, all[0].photos.length, all[0].category_label],
    ['Ravi', 'Kumar', 2, 'Damage / misuse by another driver']);
  assert.ok(all.some((c) => c.other_user === 'Pastor (borrowed for event)'));
  // Ravi sees his own complaint and the one about him; Kumar sees his two
  assert.equal((await ravi('/api/complaints')).data.length, 2);
  assert.equal((await kumar('/api/complaints')).data.length, 2);
  dash = (await admin('/api/dashboard')).data;
  assert.deepEqual([dash.complaints_open, dash.complaints_high], [3, 1]);
  // Admin handles it
  const upd = await admin(`/api/complaints/${c1.data.id}`, 'PUT', { status: 'resolved', admin_notes: 'Talked to Ravi, repaired ₹1,200' });
  assert.equal(upd.data.status, 'resolved'); assert.ok(upd.data.resolved_at);
  assert.equal((await ravi(`/api/complaints/${c1.data.id}`, 'PUT', { status: 'open' })).status, 403);
  assert.equal((await admin('/api/dashboard')).data.complaints_open, 2);
  assert.equal((await admin('/api/complaints?status=resolved')).data.length, 1);
  assert.equal((await admin(`/api/vehicles/${ev}/summary`)).data.complaints.length, 1);

  console.log('✔ maintenance tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
