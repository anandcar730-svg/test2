'use strict';
// Distance-based warnings: oil change and battery / part replacement ~500 km and ~100 km before, then overdue.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-km-'));
const { server } = require('../server.js');

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
  // oil change every 5,000 km from 10,000 → due at 15,000
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', fuel_type: 'Diesel', initial_km: 10000, oil_interval_km: 5000, assigned_driver_id: r1 })).data.id;
  const ev = (await admin('/api/vehicles', 'POST', { reg_no: 'TN07EV2024', fuel_type: 'EV', initial_km: 100 })).data.id;
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  const day = new Date().toLocaleDateString('en-CA');
  const drive = (km) => ravi('/api/fuel', 'POST', { vehicle_id: car, date: day, odometer: km, quantity: 1, amount: 90 }); // any reading moves the odometer
  const run = async () => (await admin('/api/notifications/run', 'POST')).data;
  const titles = async (c) => (await c('/api/notifications')).data.items.map((n) => n.title);

  // battery: replace every 5,060 km from 10,000 → at 15,060 (no date warranty)
  const bat = await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', brand: 'Exide', serial_no: 'EX-77', installed_km: 10000, life_km: 5060 });
  assert.equal(bat.status, 200, JSON.stringify(bat.data));
  assert.equal(bat.data.due_km, 15060);
  assert.equal((await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'tyre', name: 'MRF ZVTV', life_km: 40000 })).status, 400, 'needs installed km');
  // tyre with explicit "replace at" odometer
  const tyre = (await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'tyre', name: 'MRF ZVTV', position: 'FL', due_km: 40000 })).data;
  assert.equal(tyre.due_km, 40000);

  // 14,450 km: 550 km to oil change → nothing yet
  await drive(14450);
  assert.equal((await run()).created, 0);
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_status, 'ok');

  // 14,520 km: 480 km left → first warning (500 km stage), battery 540 km → nothing
  await drive(14520);
  assert.equal((await run()).created, 2, 'oil warning for admin + Ravi');
  assert.match((await titles(ravi))[0], /TN01AB1234: Oil change due in 480 km/);
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_status, 'due_soon');
  assert.equal((await run()).created, 0, 'no repeat inside the same stage');

  // 14,610: battery 450 km → its 500 km warning; oil (390 km) still in the 500 stage
  await drive(14610);
  let r = await run();
  assert.equal(r.created, 2);
  assert.match((await titles(ravi))[0], /Battery change due in 450 km/);

  // 14,905: oil 95 km → the "around 100 km" warning
  await drive(14905);
  r = await run();
  assert.equal(r.created, 2, 'oil 100-km warning (battery at 155 km is still in its 500 stage)');
  assert.match((await titles(ravi))[0], /Oil change due in 95 km/);
  // dashboard shows the battery as due with km left
  const dash = (await ravi('/api/dashboard')).data;
  const pa = dash.part_alerts.find((p) => p.kind === 'battery');
  assert.deepEqual([pa.state, pa.km_left, pa.km_state], ['due', 155, 'due']);

  // 14,970: battery 90 km → its 100-km warning
  await drive(14970);
  assert.equal((await run()).created, 2);
  assert.match((await titles(admin))[0], /Battery change due in 90 km/);

  // 15,030: oil overdue 30 km
  await drive(15030);
  assert.equal((await run()).created, 2);
  assert.match((await titles(ravi))[0], /Oil change OVERDUE by 30 km/);
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_status, 'overdue');

  // 15,100: battery overdue 40 km; oil still in its first overdue stage
  await drive(15100);
  assert.equal((await run()).created, 2);
  assert.match((await titles(ravi))[0], /Battery change OVERDUE by 40 km/);
  const fleet = (await admin('/api/fleet')).data.find((v) => v.reg_no === 'TN01AB1234');
  assert.deepEqual([fleet.battery.km_left, fleet.battery.km_state], [-40, 'expired']);
  // tyre far away: no warning
  assert.ok(!(await titles(admin)).some((t) => /Tyre/.test(t)));

  // oil done → new due km, warnings start fresh; EVs never get oil warnings
  await admin('/api/services', 'POST', { vehicle_id: car, date: day, odometer: 15100, type: 'oil_change', cost: 2500 });
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_due_km, 20100);
  assert.equal((await run()).created, 0);
  assert.ok(!(await titles(admin)).some((t) => /TN07EV2024/.test(t)));
  void ev;

  // admin changes the warning distances
  assert.equal((await admin('/api/notifications/settings', 'PUT', { km: '1000, 200' })).status, 200);
  assert.equal((await admin('/api/notifications/settings', 'PUT', { km: 'soon' })).status, 400);
  assert.equal((await admin('/api/notifications/settings')).data.km, '1000,200');
  await drive(19150); // oil 950 km left → now inside the 1000 km stage
  assert.equal((await run()).created, 4, 'oil 1000-km warning + battery still not changed (repeats every 500 km overdue)');
  const latest = (await titles(ravi)).slice(0, 2).join(' | ');
  assert.match(latest, /Oil change due in 950 km/);
  assert.match(latest, /Battery change OVERDUE by 4,090 km/);

  // "next oil change after 2000 km" -> due at odometer + 2000
  await admin('/api/services', 'POST', { vehicle_id: car, date: day, odometer: 19200, type: 'oil_change', next_after_km: '2000' });
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_due_km, 21200);
  // an explicit "next due at" wins over "after"
  await admin('/api/services', 'POST', { vehicle_id: car, date: day, odometer: 19300, type: 'oil_change', next_after_km: '2000', next_due_km: '22000' });
  assert.equal((await admin(`/api/vehicles/${car}/summary`)).data.vehicle.oil_due_km, 22000);
  assert.equal((await admin('/api/services', 'POST', { vehicle_id: car, date: day, odometer: 19400, type: 'oil_change', next_after_km: 'abc' })).status, 400);

  console.log('✔ km warnings tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
