'use strict';
// Reminders + Web Push. A fake push service decrypts each message (RFC 8291) and checks the VAPID signature (RFC 8292)
// exactly as a real push service / browser would.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { stageFor } = require('../notifications.js');

// ---- stages
const ms = [30, 15, 7, 3, 1, 0];
assert.equal(stageFor(45, ms), null);
assert.equal(stageFor(30, ms), 'd30');
assert.equal(stageFor(12, ms), 'd15');
assert.equal(stageFor(1, ms), 'd1');
assert.equal(stageFor(0, ms), 'd0');
assert.equal(stageFor(-1, ms), 'expired-w0');
assert.equal(stageFor(-7, ms), 'expired-w0');
assert.equal(stageFor(-8, ms), 'expired-w1');

// ---- a "browser": key pair + auth secret, and the receiving side of RFC 8291
function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
function decrypt(body, b) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function verifyVapid(header, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'vapid header');
  const [h, c, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  assert.match(claims.sub, /^(mailto:|https:)/);
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature valid');
  return pub;
}

const devices = {}; // path -> browser
const inbox = {};   // path -> [messages]
let vapidKeySeen = null;
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const p = req.url;
    if (p === '/gone') { res.writeHead(410); return res.end(); }
    try {
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      assert.ok(Number(req.headers.ttl) > 0);
      const endpoint = `http://127.0.0.1:${pushService.address().port}${p}`;
      vapidKeySeen = verifyVapid(req.headers.authorization, endpoint).toString('base64url');
      (inbox[p] ||= []).push(decrypt(Buffer.concat(chunks), devices[p]));
      res.writeHead(201); res.end();
    } catch (e) { console.error('push service rejected:', e.message); res.writeHead(400); res.end(e.message); }
  });
});

const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');

(async () => {
  await new Promise((r) => pushService.listen(0, r));
  const pushBase = `http://127.0.0.1:${pushService.address().port}`;
  process.env.PUSH_ALLOW_HTTP = '1';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-notif-'));
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
  const admin = client(), ravi = client(), suresh = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const r1 = (await admin('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' })).data.id;
  await admin('/api/drivers', 'POST', { name: 'Suresh', username: 'suresh', password: 'suresh123' });
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', fuel_type: 'Diesel', initial_km: 1000, assigned_driver_id: r1 })).data.id;
  const van = (await admin('/api/vehicles', 'POST', { reg_no: 'TN22BB5678', fuel_type: 'Diesel', initial_km: 1000 })).data.id;
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  await suresh('/api/login', 'POST', { username: 'suresh', password: 'suresh123' });

  await admin(`/api/documents/${car}`, 'PUT', { insurance_upto: day(10), insurance_company: 'United India', tax_upto: 'LTT' });
  await admin(`/api/documents/${van}`, 'PUT', { pucc_upto: day(40) });   // too far away – no reminder yet
  await admin('/api/parts', 'POST', { vehicle_id: car, kind: 'battery', brand: 'Exide', serial_no: 'EX-1', installed_on: day(-733), warranty_months: 24 });

  // ---- devices
  const key = (await ravi('/api/push/key')).data.publicKey;
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  assert.equal((await ravi('/api/push/test', 'POST')).status, 400, 'no device yet');
  devices['/ravi-phone'] = browser(); devices['/admin-pc'] = browser();
  assert.equal((await ravi('/api/push/subscribe', 'POST', { subscription: { endpoint: 'ftp://x', keys: devices['/ravi-phone'].keys } })).status, 400);
  assert.equal((await ravi('/api/push/subscribe', 'POST', { subscription: { endpoint: pushBase + '/ravi-phone', keys: devices['/ravi-phone'].keys }, device: 'Android Chrome' })).status, 200);
  assert.equal((await admin('/api/push/subscribe', 'POST', { subscription: { endpoint: pushBase + '/admin-pc', keys: devices['/admin-pc'].keys }, device: 'Windows Chrome' })).status, 200);
  await admin('/api/push/subscribe', 'POST', { subscription: { endpoint: pushBase + '/gone', keys: browser().keys }, device: 'old phone' });

  // ---- test push decrypts + signature verifies
  const t = await ravi('/api/push/test', 'POST');
  assert.deepEqual([t.data.sent, t.data.failed], [1, 0]);
  assert.equal(inbox['/ravi-phone'][0].title, '🔔 Test notification');
  assert.equal(vapidKeySeen, key, 'signed with the published VAPID key');

  // ---- morning run
  const r = await admin('/api/notifications/run', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 4, 'insurance + battery, for admin and Ravi');
  const ravisMsg = inbox['/ravi-phone'][1];
  assert.match(ravisMsg.title, /2 reminders/);
  assert.match(ravisMsg.body, /Insurance expires in 10 days/);
  assert.match(ravisMsg.body, /Battery warranty expired 3 days ago/);
  assert.equal(inbox['/admin-pc'].length, 1);
  assert.equal((await admin('/api/notifications')).data.devices.length, 1, 'expired (410) device removed');
  const rn = (await ravi('/api/notifications')).data;
  assert.equal(rn.unread, 2);
  assert.ok(rn.items.every((n) => n.url === `/#/vehicle/${car}`));
  assert.equal((await suresh('/api/notifications')).data.items.length, 0, 'other drivers are not told');
  assert.ok(!(await admin('/api/notifications')).data.items.some((n) => /Road tax/.test(n.title)), 'lifetime tax never reminds');

  // ---- no duplicates; next stage triggers again; renewal starts fresh
  assert.equal((await admin('/api/notifications/run', 'POST')).data.created, 0);
  await admin(`/api/documents/${car}`, 'PUT', { insurance_upto: day(6) });
  const again = (await admin('/api/notifications/run', 'POST')).data;
  assert.equal(again.created, 2, 'new date → its own reminder for admin and Ravi');
  assert.match(inbox['/ravi-phone'].at(-1).title, /TN01AB1234: Insurance expires in 6 days/);
  assert.equal(inbox['/ravi-phone'].at(-1).url, `/#/vehicle/${car}`);

  // ---- read
  const first = (await ravi('/api/notifications')).data.items[0];
  await ravi('/api/notifications/read', 'POST', { id: first.id });
  assert.equal((await ravi('/api/notifications/count')).data.unread, 2);
  await ravi('/api/notifications/read', 'POST', {});
  assert.equal((await ravi('/api/notifications/count')).data.unread, 0);

  // ---- settings + daily schedule
  assert.equal((await ravi('/api/notifications/settings')).status, 403);
  assert.equal((await admin('/api/notifications/settings', 'PUT', { days: '60, 30, 7, 0', hour: 9 })).status, 200);
  assert.equal((await admin('/api/notifications/settings', 'PUT', { days: 'soon' })).status, 400);
  const st = (await admin('/api/notifications/settings')).data;
  assert.deepEqual([st.days, st.hour, st.devices], ['60,30,7,0', 9, 2]);
  const { runDailyIfDue } = server.notifications;
  const early = new Date(); early.setHours(8, 0, 0, 0);
  const later = new Date(); later.setHours(9, 30, 0, 0);
  assert.equal(await runDailyIfDue(early), null, 'not before 9');
  const daily = await runDailyIfDue(later);
  assert.equal(daily.created, 1, 'van PUC (40 days) is now inside the 60-day reminder – admin only, the van has no driver');
  assert.equal(await runDailyIfDue(later), null, 'once a day');

  // ---- unsubscribe
  await ravi('/api/push/unsubscribe', 'POST', { endpoint: pushBase + '/ravi-phone' });
  assert.equal((await ravi('/api/notifications')).data.devices.length, 0);

  console.log('✔ notifications tests passed');
  server.close(); pushService.close();
})().catch((e) => { console.error(e); process.exit(1); });
