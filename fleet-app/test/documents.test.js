'use strict';
// Vehicle documents (insurance / PUC / fitness) against a fake RC-verification API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseDate, extract, usageOf, LIFETIME } = require('../documents.js');

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

// RTO Sarthi sample response exactly as published on rtosarthi.com/vahan-api
const RTO_SARTHI_SAMPLE = { success: true, message: 'Vehicle details fetched successfully', vehicleNumber: 'MH12AB1234',
  data: { REGN_NO: 'MH12AB1234', STATUS: 'ACTIVE', OWNER_NAME: 'SUNITA PATIL', MAKER_DESC: 'MARUTI SUZUKI INDIA LTD', MAKER_MODEL: 'SWIFT VXI',
    REGN_DT: '12-Apr-2022', REGN_UPTO: '11-Apr-2037', FINANCER_DETAILS: 'HDFC BANK LTD',
    INSURANCE_COMP: 'ICICI LOMBARD GENERAL INSURANCE CO. LTD.', INS_POLICY_NO: '3001/123456789/00/000', INSURANCE_UPTO: '11-Apr-2027',
    PUCC_NO: 'MH01200040056789', PUCC_UPTO: '10-Apr-2027', FIT_UPTO: '11-Apr-2037', TAX_UPTO: 'LTT', BLACKLIST_STATUS: 'NA', NOC_DETAILS: 'NA' },
  usage: { limit: 5000, used: 1240, remaining: 3760 } };
const rs = extract(RTO_SARTHI_SAMPLE, { rc_status: ['status'] });
assert.deepEqual([rs.insurance_upto, rs.insurance_company, rs.insurance_policy, rs.pucc_upto, rs.pucc_number, rs.fitness_upto, rs.tax_upto,
  rs.owner_name, rs.maker_model, rs.rc_status],
  ['2027-04-11', 'ICICI LOMBARD GENERAL INSURANCE CO. LTD.', '3001/123456789/00/000', '2027-04-10', 'MH01200040056789', '2037-04-11', LIFETIME,
    'SUNITA PATIL', 'SWIFT VXI', 'ACTIVE']);
assert.deepEqual(usageOf(RTO_SARTHI_SAMPLE), { limit: 5000, used: 1240, remaining: 3760 });

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
    if (req.url.startsWith('/rtosarthi/')) {
      if (req.headers['x-api-key'] !== 'RS-KEY-1') return send(401, { success: false, message: 'Invalid API key' });
      const vn = JSON.parse(b || '{}').vehicleNumber;
      if (!db[vn]) return send(200, { success: false, message: 'Vehicle not found', usage: { limit: 5000, used: 1241, remaining: 3759 } });
      const r = db[vn];
      const dmy = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/ /g, '-') : d);
      return send(200, { ...RTO_SARTHI_SAMPLE, vehicleNumber: vn, usage: { limit: 5000, used: 1242, remaining: 3758 },
        data: { ...RTO_SARTHI_SAMPLE.data, REGN_NO: vn, INSURANCE_UPTO: dmy(r.insurance_upto), PUCC_UPTO: dmy(r.pucc_upto), FIT_UPTO: dmy(r.fit_up_to), TAX_UPTO: 'LTT' } });
    }
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
  assert.equal(c.docs.tax.status, 'ok', 'LTT = lifetime tax, always valid'); assert.equal(c.tax_upto, LIFETIME);
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
  const man = await admin(`/api/documents/${bad}`, 'PUT', { insurance_upto: '15/08/2027', pucc_upto: '2027-12-01', insurance_company: 'LIC' });
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
  // Smart sync: only the car (fitness expired, PUC due) – van and the third vehicle are up to date
  const plan = server.documents.smartPlan();
  assert.deepEqual(plan.filter((x) => x.lookup).map((x) => x.vehicle_id), [car]);
  assert.match(plan.find((x) => x.vehicle_id === van).reason, /skipped/);
  const smartRun = await runDailyIfDue(later);
  assert.ok(smartRun, 'runs after 6 AM');
  assert.deepEqual([smartRun.mode, smartRun.checked, smartRun.skipped], ['smart', 1, 2]);
  assert.equal(calls - before, 1, 'one paid lookup instead of three');
  assert.equal(await runDailyIfDue(later), null, 'only once per day');
  // Monthly refresh: a vehicle last checked 31 days ago is looked up again
  require('../server.js').db.prepare(`UPDATE vehicle_docs SET fetched_at=? WHERE vehicle_id=?`).run(new Date(Date.now() - 31 * 864e5).toISOString(), van);
  assert.match(server.documents.smartPlan().find((x) => x.vehicle_id === van).reason, /monthly check/);
  // "Sync now" with smart=true from the page, and status shows the plan
  const sm = await admin('/api/documents/sync', 'POST', { smart: true });
  assert.equal(sm.data.checked, 2, 'car (still due) + van (monthly)');
  assert.equal((await admin('/api/documents')).data.settings.next_run.lookups, 1);
  // Mode "all": every vehicle every day
  await admin('/api/documents/settings', 'PUT', { mode: 'all' });
  require('../server.js').db.prepare(`DELETE FROM settings WHERE key='docs_auto_day'`).run();
  const before2 = calls;
  assert.equal((await runDailyIfDue(later)).checked, 3);
  assert.equal(calls - before2, 3);
  await admin('/api/documents/settings', 'PUT', { mode: 'smart' });

  // RTO Sarthi provider (URL/header from their integration guide)
  await admin('/api/documents/settings', 'PUT', { provider: 'rtosarthi' });
  const noUrl = await admin('/api/documents/sync', 'POST', { vehicle_id: van });
  assert.equal(noUrl.status, 400); assert.match(noUrl.data.error, /RTO Sarthi API URL/);
  const rsSet = await admin('/api/documents/settings', 'PUT', { url: `http://127.0.0.1:${fake.address().port}/rtosarthi/v1/vehicle`,
    auth_header: 'x-api-key', auth_prefix: '', key: 'RS-KEY-1', body: '{"vehicleNumber": "{vehicle_number}"}' });
  assert.equal(rsSet.status, 200, JSON.stringify(rsSet.data)); assert.equal(rsSet.data.editable, true);
  assert.equal((await admin('/api/documents/settings', 'PUT', { body: '{bad json' })).status, 400);
  const rsOne = await admin('/api/documents/sync', 'POST', { vehicle_id: van });
  assert.equal(rsOne.data.ok, true, JSON.stringify(rsOne.data));
  const vanDocs = (await admin('/api/documents')).data;
  const vrow = vanDocs.vehicles.find((v) => v.vehicle_id === van);
  assert.deepEqual([vrow.insurance_upto, vrow.pucc_upto, vrow.tax_upto, vrow.insurance_company, vrow.rc_status],
    [plus(400), plus(100), LIFETIME, 'ICICI LOMBARD GENERAL INSURANCE CO. LTD.', 'ACTIVE']);
  assert.equal(vrow.docs.tax.status, 'ok', 'lifetime tax is valid');
  assert.equal(vanDocs.settings.usage.remaining, 3758, 'prepaid balance shown');
  delete db.XX00ZZ0000;
  const rsBad = await admin('/api/documents/sync', 'POST', { vehicle_id: bad });
  assert.equal(rsBad.data.ok, false); assert.match(rsBad.data.error, /Vehicle not found/);
  // switching provider keeps each provider's own URL
  await admin('/api/documents/settings', 'PUT', { provider: 'surepass' });
  await admin('/api/documents/settings', 'PUT', { provider: 'rtosarthi' });
  assert.match((await admin('/api/documents')).data.settings.url, /rtosarthi\/v1/);

  // Custom provider (GET with number in URL, own header)
  await admin('/api/documents/settings', 'PUT', { provider: 'custom' });
  await admin('/api/documents/settings', 'PUT', { url: 'ftp://x' }).then((r) => assert.equal(r.status, 400));
  await admin('/api/documents/settings', 'PUT', { provider: 'surepass' });

  console.log('✔ documents tests passed');
  server.close(); fake.close();
})().catch((e) => { console.error(e); process.exit(1); });
