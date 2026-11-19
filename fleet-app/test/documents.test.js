'use strict';
// Vehicle documents (insurance / PUC / fitness) against a fake RC-verification API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseDate, extract } = require('../documents.js');

// ---- pure helpers
assert.equal(parseDate('2026-05-31'), '2026-05-31');
assert.equal(parseDate('2026-05-31T00:00:00.000Z'), '2026-05-31');
assert.equal(parseDate('31-05-2026'), '2026-05-31');
assert.equal(parseDate('31/05/2026'), '2026-05-31');
assert.equal(parseDate('31-May-2026'), '2026-05-31');
assert.equal(parseDate('31 May 2026'), '2026-05-31');
assert.equal(parseDate('May 31, 2026'), '2026-05-31');
assert.equal(parseDate('31-02-2026'), null, 'impossible date');
assert.equal(parseDate('NA'), null);
assert.equal(parseDate('LTT'), null);
const ex = extract({ result: { vehicle: { insuranceUpto: '12/01/2027', PUC_VALID_UPTO: '01-Jun-2026', fitnessUpto: '2030-01-01', insurer: 'ACME' } } });
assert.deepEqual([ex.insurance_upto, ex.pucc_upto, ex.fitness_upto, ex.insurance_company], ['2027-01-12', '2026-06-01', '2030-01-01', 'ACME']);

const KEY = 'sk_live_test_9876';
const plus = (days) => new Date(Date.now() + days * 864e5).toLocaleDateString('en-CA');
const db = {
  TN01AB1234: { insurance_upto: plus(200), insurance_company: 'New India Assurance', insurance_policy_number: 'P-77', pucc_upto: plus(10),
    pucc_number: 'PUC1', fit_up_to: plus(-3), tax_upto: 'LTT', permit_valid_upto: null, owner_name: 'SHALOM CHURCH', maker_model: 'HONDA CITY', rc_status: 'ACTIVE' },
  TN22BB5678: { insurance_upto: plus(400), pucc_upto: plus(100), fit_up_to: plus(700) },
};
let calls = 0;
const fake = http.createServer((req, res) => {
  calls++;
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'Invalid token', success: false });
    const id = JSON.parse(b || '{}').id_number;
    if (!db[id]) return send(422, { success: false, message: 'Verification Failed.', status_code: 422 });
    // Surepass-style envelope; dates formatted like the provider (ISO here, but one in DD-MM-YYYY)
    const data = { ...db[id], rc_number: id };
    if (id === 'TN22BB5678') data.pucc_upto = data.pucc_upto.split('-').reverse().join('-');
    send(200, { data, status_code: 200, success: true, message: null, message_code: 'success' });
  });
});

(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.DOCS_PRESET_URL = `http://127.0.0.1:${fake.address().port}/api/v1/rc/rc-full`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-docs-'));
  const { server } = require('../server.js');
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
  const admin = client(), driver = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const drv = await admin('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' });
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN 01 AB 1234', initial_km: 1, assigned_driver_id: drv.data.id })).data.id;
  const van = (await admin('/api/vehicles', 'POST', { reg_no: 'TN22BB5678', initial_km: 1 })).data.id;
  const bad = (await admin('/api/vehicles', 'POST', { reg_no: 'XX00ZZ0000', initial_km: 1 })).data.id;

  // No key yet → clear message, nothing called
  const nokey = await admin('/api/documents/sync', 'POST', {});
  assert.equal(nokey.status, 400); assert.match(nokey.data.error, /API key/);
  assert.equal(calls, 0);

  // Wrong key → stops with a key error
  await admin('/api/documents/settings', 'PUT', { provider: 'surepass', key: 'wrong' });
  const wrong = await admin('/api/documents/sync', 'POST', {});
  assert.equal(wrong.status, 400); assert.match(wrong.data.error, /rejected the API key/);

  // Right key → sync all
  const st = await admin('/api/documents/settings', 'PUT', { key: KEY, hour: 6 });
  assert.equal(st.data.key_hint, '••••9876'); assert.ok(!JSON.stringify(st.data).includes(KEY), 'key never sent to browser');
  const sync = await admin('/api/documents/sync', 'POST', {});
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.updated, 2);
  assert.equal(sync.data.failed.length, 1); assert.match(sync.data.failed[0].error, /Verification Failed/);

  const list = (await admin('/api/documents')).data.vehicles;
  const c = list.find((v) => v.vehicle_id === car);
  assert.equal(c.insurance_company, 'New India Assurance');
  assert.equal(c.docs.insurance.status, 'ok');
  assert.equal(c.docs.pucc.status, 'due'); assert.equal(c.docs.pucc.days_left, 10);
  assert.equal(c.docs.fitness.status, 'expired'); assert.equal(c.docs.fitness.days_left, -3);
  assert.equal(c.docs.tax.status, 'unknown', 'LTT = lifetime tax, no date');
  assert.equal(c.source, 'api'); assert.ok(c.fetched_at);
  assert.equal(list.find((v) => v.vehicle_id === van).docs.pucc.upto, plus(100), 'DD-MM-YYYY parsed');
  assert.match(list.find((v) => v.vehicle_id === bad).last_error, /Verification Failed/);

  // Dashboard alerts: admin sees all, driver only his vehicle
  const da = (await admin('/api/dashboard')).data.doc_alerts;
  assert.deepEqual(da.map((a) => `${a.reg_no}:${a.doc}:${a.status}`), ['TN 01 AB 1234:fitness:expired', 'TN 01 AB 1234:pucc:due']);
  await driver('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  assert.equal((await driver('/api/dashboard')).data.doc_alerts.length, 2);
  assert.equal((await driver('/api/documents')).status, 403, 'documents page is admin only');
  assert.equal((await driver(`/api/vehicles/${car}/summary`)).data.documents.docs.fitness.status, 'expired', 'driver sees on vehicle page');

  // Manual entry (no API needed); an API sync later keeps manual values the API does not have
  const man = await admin(`/api/documents/${bad}`, 'PUT', { insurance_upto: '15/08/2027', pucc_upto: '2026-12-01', insurance_company: 'LIC' });
  assert.equal(man.status, 200, JSON.stringify(man.data));
  assert.equal(man.data.insurance_upto, '2027-08-15'); assert.equal(man.data.source, 'manual');
  assert.equal((await admin(`/api/documents/${bad}`, 'PUT', { fitness_upto: '31-02-2026' })).status, 400);
  db.XX00ZZ0000 = { fit_up_to: plus(50) };
  await admin('/api/documents/sync', 'POST', { vehicle_id: bad });
  const b2 = (await admin('/api/documents')).data.vehicles.find((v) => v.vehicle_id === bad);
  assert.deepEqual([b2.insurance_upto, b2.fitness_upto, b2.source, b2.last_error], ['2027-08-15', plus(50), 'api', null]);

  // Daily morning schedule: runs once after the set hour
  const before = calls;
  const { runDailyIfDue } = server.documents;
  const early = new Date(); early.setHours(5, 0, 0, 0);
  const later = new Date(); later.setHours(7, 0, 0, 0);
  assert.equal(await runDailyIfDue(early), null, 'not before 6 AM');
  assert.ok(await runDailyIfDue(later), 'runs after 6 AM');
  assert.equal(calls - before, 3, 'one lookup per vehicle');
  assert.equal(await runDailyIfDue(later), null, 'only once per day');

  // Custom provider (GET with number in URL, own header)
  await admin('/api/documents/settings', 'PUT', { provider: 'custom', url: 'ftp://x', key: KEY }).then((r) => assert.equal(r.status, 400));
  await admin('/api/documents/settings', 'PUT', { provider: 'surepass' });

  console.log('✔ documents tests passed');
  server.close(); fake.close();
})().catch((e) => { console.error(e); process.exit(1); });
