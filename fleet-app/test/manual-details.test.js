'use strict';
// Vehicle details entered by hand: registration fields, documents, scanned papers (photo / PDF).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-manual-'));
const { server } = require('../server.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const FAKE_PDF = 'data:application/pdf;base64,' + Buffer.from('<html>not a pdf</html>').toString('base64');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fleet-app', cookie },
      body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, data: type.includes('json') ? await res.json() : await res.text() };
  };
  await call('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const id = (await call('/api/vehicles', 'POST', { reg_no: 'TN05AB0001', model: 'Old', fuel_type: 'Diesel', initial_km: 100 })).data.id;

  // Basics: model and starting odometer can be corrected while nothing is recorded yet
  assert.equal((await call(`/api/vehicles/${id}`, 'PUT', { model: 'Toyota Innova Crysta', initial_km: 45210 })).status, 200);
  let s = (await call(`/api/vehicles/${id}/summary`)).data;
  assert.deepEqual([s.vehicle.model, s.vehicle.initial_km], ['Toyota Innova Crysta', 45210]);

  // Everything by hand
  const save = await call(`/api/documents/${id}`, 'PUT', {
    owner_name: 'Shalom Church Trust', maker_model: 'TOYOTA INNOVA CRYSTA 2.4 GX', vehicle_class: 'MOTOR CAB',
    registration_date: '15/03/2021', registered_at: 'CHENNAI (SOUTH) RTO', chassis_no: 'MBJ11AF3001234567', engine_no: '2GD1234567',
    manufacture: '02/2021', color: 'SILVER', seating: '7', financer: '', rc_status: 'ACTIVE',
    insurance_company: 'United India', insurance_policy: 'UI-2026-889', insurance_upto: '2027-03-14',
    pucc_number: 'TN0502', pucc_upto: '2027-01-10', fitness_upto: '2028-03-14', tax_upto: 'LTT', permit_upto: '2030-06-30',
    notes: 'Spare key in office drawer', files: { rc_file: PNG, insurance_file: PDF },
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const d = save.data;
  assert.deepEqual([d.owner_name, d.registration_date, d.chassis_no, d.seating, d.financer, d.tax_upto, d.source],
    ['Shalom Church Trust', '2021-03-15', 'MBJ11AF3001234567', '7', null, '9999-12-31', 'manual']);
  assert.equal(d.docs.tax.status, 'ok');
  assert.match(d.rc_file, /\.png$/); assert.match(d.insurance_file, /\.pdf$/);
  assert.equal(d.notes, 'Spare key in office drawer');

  // Files are served to logged-in users only, PDFs with the right type
  const pdf = await call('/uploads/' + d.insurance_file);
  assert.equal(pdf.status, 200); assert.match(pdf.type, /application\/pdf/);
  assert.equal((await fetch(base + '/uploads/' + d.insurance_file)).status, 401);

  // Bad input
  assert.equal((await call(`/api/documents/${id}`, 'PUT', { files: { pucc_file: FAKE_PDF } })).status, 400, 'fake PDF refused');
  assert.equal((await call(`/api/documents/${id}`, 'PUT', { registration_date: '31-02-2021' })).status, 400);
  assert.equal((await call('/api/fuel', 'POST', { vehicle_id: id, date: '2026-11-01', odometer: 45300, quantity: 30, amount: 2700, photo: PDF })).status, 400,
    'PDF only allowed for papers, not fuel photos');

  // Partial update keeps other values; null removes a file; untouched file stays
  const upd = (await call(`/api/documents/${id}`, 'PUT', { pucc_upto: '2027-07-10', files: { rc_file: null } })).data;
  assert.deepEqual([upd.pucc_upto, upd.owner_name, upd.rc_file, upd.insurance_file], ['2027-07-10', 'Shalom Church Trust', null, d.insurance_file]);

  // Shown on the vehicle page and the documents list
  s = (await call(`/api/vehicles/${id}/summary`)).data;
  assert.equal(s.documents.engine_no, '2GD1234567');
  assert.equal((await call('/api/documents')).data.vehicles[0].vehicle_class, 'MOTOR CAB');

  // Starting odometer locked once something is recorded
  assert.equal((await call('/api/fuel', 'POST', { vehicle_id: id, date: '2026-11-01', odometer: 45300, quantity: 30, amount: 2700 })).status, 200);
  const locked = await call(`/api/vehicles/${id}`, 'PUT', { initial_km: 1 });
  assert.equal(locked.status, 400); assert.match(locked.data.error, /only be changed before/);
  assert.equal((await call(`/api/vehicles/${id}`, 'PUT', { initial_km: 45210, model: 'Innova Crysta GX' })).status, 200, 'same value is fine');

  console.log('✔ manual details tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
