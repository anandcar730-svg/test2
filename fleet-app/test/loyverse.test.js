'use strict';
// Loyverse integration test against a fake Loyverse API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'test-token-1234';
const day = new Date().toISOString().slice(0, 10);
const at = (m) => new Date(Date.now() + m * 60e3).toISOString(); // m minutes from now
const state = {
  customers: [{ id: 'c-existing', name: 'tn 09 zz 9999', note: '' }, { id: 'c-walkin', name: 'Walk-in' }],
  receipts: [
    // matched by comment (spaces/dashes ignored)
    { receipt_number: '1-1001', receipt_type: 'SALE', receipt_date: at(1), updated_at: at(1), note: 'veh tn-01 ab 1234', store_id: 's1',
      line_items: [{ id: 'L1', item_name: 'Petrol', quantity: 20, price: 102.5, total_money: 2050 },
        { id: 'L2', item_name: 'Engine oil 1L', quantity: 1, price: 450, total_money: 450 }] },
    // matched by last 4 digits in the line comment
    { receipt_number: '1-1002', receipt_type: 'SALE', receipt_date: at(2), updated_at: at(2), store_id: 's1',
      line_items: [{ id: 'L1', item_name: 'HSD', variant_name: 'Diesel', quantity: 35.5, price: 90, total_money: 3195, line_note: 'van 5678' }] },
    // no vehicle → unmatched
    { receipt_number: '1-1003', receipt_type: 'SALE', receipt_date: at(3), updated_at: at(3), customer_id: 'c-walkin', store_id: 's1',
      line_items: [{ id: 'L1', item_name: 'Petrol', quantity: 10, price: 102.5, total_money: 1025 }] },
    // cancelled → ignored
    { receipt_number: '1-1004', receipt_type: 'SALE', receipt_date: at(4), updated_at: at(4), cancelled_at: at(5), note: 'TN01AB1234',
      line_items: [{ id: 'L1', item_name: 'Petrol', quantity: 5, price: 102.5, total_money: 512.5 }] },
  ],
};
const requests = [];
const fake = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errors: [{ code: 'UNAUTHORIZED' }] });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stores') return send(200, { stores: [{ id: 's1', name: 'Shalom Fuels' }] });
  if (u.pathname === '/stores/s1') return send(200, { id: 's1', name: 'Shalom Fuels' });
  if (u.pathname === '/receipts') {
    const min = u.searchParams.get('updated_at_min') || '';
    const rows = state.receipts.filter((r) => r.updated_at >= min);
    // paginate 2 per page to exercise cursors
    const start = Number(u.searchParams.get('cursor') || 0);
    return send(200, { receipts: rows.slice(start, start + 2), cursor: start + 2 < rows.length ? String(start + 2) : null });
  }
  if (u.pathname.startsWith('/customers/')) {
    const c = state.customers.find((x) => x.id === decodeURIComponent(u.pathname.split('/')[2]));
    return c ? send(200, c) : send(404, { errors: [{ code: 'NOT_FOUND' }] });
  }
  if (u.pathname === '/customers' && req.method === 'GET') return send(200, { customers: state.customers, cursor: null });
  if (u.pathname === '/customers' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b);
      let c = body.id && state.customers.find((x) => x.id === body.id);
      if (c) Object.assign(c, body); else { c = { ...body, id: `c-${state.customers.length + 1}` }; state.customers.push(c); }
      send(200, c);
    });
    return;
  }
  send(404, { errors: [{ code: 'NOT_FOUND' }] });
});

(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.LOYVERSE_API = `http://127.0.0.1:${fake.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lv-'));
  const { server } = require('../server.js');
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie },
      body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await call('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const drv = await call('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' });
  const car = (await call('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', fuel_type: 'Petrol', initial_km: 1000, assigned_driver_id: drv.data.id })).data.id;
  const van = (await call('/api/vehicles', 'POST', { reg_no: 'TN02CD5678', fuel_type: 'Diesel', initial_km: 5000 })).data.id;
  const bus = (await call('/api/vehicles', 'POST', { reg_no: 'TN09ZZ9999', fuel_type: 'Diesel', initial_km: 100 })).data.id;

  // Connect: a wrong token is refused and not saved
  assert.equal((await call('/api/loyverse', 'PUT', { token: 'wrong' })).status, 400);
  assert.equal((await call('/api/loyverse')).data.connected, false);
  const conn = await call('/api/loyverse', 'PUT', { token: TOKEN, since: `${day}T00:00:00Z` });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  assert.equal(conn.data.connected, true);
  assert.equal(conn.data.token_hint, '••••1234');
  assert.ok(!JSON.stringify(conn.data).includes(TOKEN), 'token never sent back to the browser');
  assert.deepEqual((await call('/api/loyverse/test', 'POST')).data.stores, ['Shalom Fuels']);

  // Sync
  const s1 = await call('/api/loyverse/sync', 'POST');
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  assert.deepEqual([s1.data.receipts, s1.data.imported, s1.data.unmatched, s1.data.skipped_non_fuel], [4, 2, 1, 1]);
  const fuel = (await call('/api/fuel')).data;
  const petrol = fuel.find((f) => f.vehicle_id === car);
  assert.equal(petrol.fuel_type, 'Petrol'); assert.equal(petrol.quantity, 20); assert.equal(petrol.unit, 'L');
  assert.equal(petrol.amount, 2050); assert.equal(petrol.odometer, null); assert.equal(petrol.source, 'loyverse');
  assert.equal(petrol.driver_id, drv.data.id, 'assigned driver gets the record');
  assert.match(petrol.station, /Shalom Fuels/);
  const diesel = fuel.find((f) => f.vehicle_id === van);
  assert.equal(diesel.fuel_type, 'Diesel'); assert.equal(diesel.quantity, 35.5);

  // Re-sync is idempotent
  const s2 = await call('/api/loyverse/sync', 'POST');
  assert.equal(s2.data.imported, 0); assert.equal(s2.data.unmatched, 0);
  assert.equal((await call('/api/fuel')).data.length, 2);

  // Unmatched → assign to a vehicle
  const um = (await call('/api/loyverse/unmatched')).data;
  assert.equal(um.length, 1); assert.match(um[0].info, /Walk-in/);
  assert.equal((await call(`/api/loyverse/unmatched/${um[0].id}/assign`, 'POST', { vehicle_id: car })).status, 200);
  assert.equal((await call('/api/loyverse/unmatched')).data.length, 0);
  assert.equal((await call('/api/fuel?vehicle=' + car)).data.length, 2);
  assert.equal((await call(`/api/loyverse/unmatched/${um[0].id}/assign`, 'POST', { vehicle_id: car })).status, 400, 'only once');

  // Driver adds the odometer reading; mileage works with the imported fills
  const ravi = { c: '' };
  const asRavi = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie: ravi.c },
      body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) ravi.c = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await asRavi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  const carFills = (await call('/api/fuel?vehicle=' + car)).data.sort((a, b) => a.id - b.id);
  assert.equal((await asRavi(`/api/fuel/${carFills[0].id}/odometer`, 'PUT', { odometer: 1000 })).status, 200);
  assert.equal((await asRavi(`/api/fuel/${carFills[0].id}/odometer`, 'PUT', { odometer: 1 })).status, 400, 'driver cannot overwrite');
  assert.equal((await asRavi(`/api/fuel/${diesel.id}/odometer`, 'PUT', { odometer: 1 })).status, 403, 'not his vehicle');
  await call(`/api/fuel/${carFills[1].id}/odometer`, 'PUT', { odometer: 1150 });
  // manual fill with odometer later on
  await call('/api/fuel', 'POST', { vehicle_id: car, date: day, odometer: 1450, quantity: 15, amount: 1500 });
  const sum = (await call(`/api/vehicles/${car}/summary`)).data;
  assert.equal(sum.vehicle.reg_no, 'TN01AB1234');
  assert.equal(sum.vehicle.mileage, 18); // (1450-1000) km / (10 + 15) L
  assert.equal(sum.vehicle.mileage_unit, 'km/L');
  assert.equal(sum.fuel.length, 3);
  assert.equal(sum.month_fuel[0].quantity, 45);
  assert.equal((await asRavi(`/api/vehicles/${car}/summary`)).status, 200, 'drivers can open vehicle pages');

  // Refund removes the original receipt's records
  state.receipts.push({ receipt_number: '1-2001', receipt_type: 'REFUND', refund_for: '1-1002', receipt_date: at(6), updated_at: at(6), line_items: [] });
  const s3 = await call('/api/loyverse/sync', 'POST');
  assert.equal(s3.data.removed, 1);
  assert.equal((await call('/api/fuel?vehicle=' + van)).data.length, 0);

  // Add vehicles to Loyverse as customers (links the existing "tn 09 zz 9999" by name)
  const push = await call('/api/loyverse/push-vehicles', 'POST');
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.deepEqual(push.data, { created: 2, linked: 1, updated: 0 });
  assert.equal(state.customers.filter((c) => c.name === 'TN01AB1234').length, 1);
  assert.equal((await call('/api/loyverse/push-vehicles', 'POST')).data.updated, 3, 'second run updates, no duplicates');
  assert.equal(state.customers.length, 4);
  // A sale to the bus's customer is matched with no comment at all
  state.receipts.push({ receipt_number: '1-3001', receipt_type: 'SALE', receipt_date: at(7), updated_at: at(7), customer_id: 'c-existing',
    line_items: [{ id: 'L1', item_name: 'Diesel', quantity: 60, price: 90, total_money: 5400 }] });
  await call('/api/loyverse/sync', 'POST');
  assert.equal((await call('/api/fuel?vehicle=' + bus)).data[0].quantity, 60);

  // Admin only
  assert.equal((await asRavi('/api/loyverse')).status, 403);

  // Disconnect
  assert.equal((await call('/api/loyverse', 'PUT', { token: '' })).data.connected, false);

  console.log('✔ loyverse tests passed');
  server.close(); fake.close();
})().catch((e) => { console.error(e); process.exit(1); });
