'use strict';
/**
 * Reminders for expiry / warranty dates:
 *   - in-app notifications (bell + list)
 *   - push notifications to phones / computers (standard Web Push, no paid service):
 *       VAPID (RFC 8292) authentication + aes128gcm payload encryption (RFC 8291), using only node:crypto.
 *
 * A reminder is sent once per "stage": 30, 15, 7, 3, 1 days before, on the day, then weekly while expired
 * (configurable). Stages are thresholds, so a day the server was down is caught up the next morning.
 * A renewed document (new date) starts its own reminders.
 */
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const DEFAULT_DAYS = '30,15,7,3,1,0';

/** Which reminder stage a date is in, or null if it is still further away than the first reminder. */
function stageFor(daysLeft, milestones) {
  if (daysLeft === null || daysLeft === undefined) return null;
  if (daysLeft < 0) return `expired-w${Math.floor((-daysLeft - 1) / 7)}`; // once a week while expired
  const m = milestones.filter((x) => x >= daysLeft).sort((a, b) => a - b)[0];
  return m === undefined ? null : `d${m}`;
}

/** Encrypt a push message for one browser subscription (RFC 8291, aes128gcm). */
function encryptPayload(payload, keys) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

module.exports = function createNotifications({ db, all, get, run, route, today, bad, str, collect }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      kind TEXT, title TEXT NOT NULL, body TEXT, url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      UNIQUE (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      device TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT, last_error TEXT
    );
  `);
  const getSetting = (k) => get(`SELECT value FROM settings WHERE key=?`, k)?.value ?? null;
  const setSetting = (k, v) => (v === null || v === undefined
    ? run(`DELETE FROM settings WHERE key=?`, k)
    : run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v)));

  // ------------------------------------------------------------------ VAPID keys (made once, kept in the database)
  function vapid() {
    let pub = getSetting('vapid_public'), priv = getSetting('vapid_private');
    if (!pub || !priv) {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      pub = b64u(ecdh.getPublicKey());
      priv = b64u(ecdh.getPrivateKey());
      setSetting('vapid_public', pub);
      setSetting('vapid_private', priv);
    }
    const p = fromB64u(pub);
    const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) } });
    return { publicKey: pub, key };
  }
  function vapidAuth(endpoint) {
    const v = vapid();
    const subject = getSetting('site_url') || 'mailto:admin@fleet-monitor.app';
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: v.key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
  }

  /** Send one message to every device of a user. Removes devices the push service says are gone. */
  async function pushToUser(userId, message) {
    const subs = all(`SELECT * FROM push_subs WHERE user_id=?`, userId);
    let sent = 0, failed = 0;
    for (const s of subs) {
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: { Authorization: vapidAuth(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
          body: encryptPayload(JSON.stringify(message), { p256dh: s.p256dh, auth: s.auth }),
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 404 || res.status === 410) { run(`DELETE FROM push_subs WHERE id=?`, s.id); failed++; continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
        run(`UPDATE push_subs SET last_ok_at=datetime('now'), last_error=NULL WHERE id=?`, s.id);
        sent++;
      } catch (e) {
        run(`UPDATE push_subs SET last_error=? WHERE id=?`, String(e.message).slice(0, 300), s.id);
        failed++;
      }
    }
    return { sent, failed, devices: subs.length };
  }

  // ------------------------------------------------------------------ reminders
  const milestones = () => (getSetting('notif_days') || DEFAULT_DAYS).split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  let running = null;
  function generate() {
    if (!running) running = doGenerate().finally(() => { running = null; });
    return running;
  }
  async function doGenerate() {
    const ms = milestones();
    const fresh = new Map(); // userId -> [notification]
    for (const item of collect()) {
      const stage = item.stage ?? stageFor(item.days_left, ms);
      if (!stage) continue;
      for (const uid of item.recipients) {
        const r = run(`INSERT OR IGNORE INTO notifications (user_id, key, kind, title, body, url) VALUES (?,?,?,?,?,?)`,
          uid, `${item.key}:${stage}`, item.kind || null, item.title, item.body || null, item.url || null);
        if (r.changes) {
          if (!fresh.has(uid)) fresh.set(uid, []);
          fresh.get(uid).push(item);
        }
      }
    }
    let created = 0, pushed = 0;
    for (const [uid, items] of fresh) {
      created += items.length;
      const msg = items.length === 1
        ? { title: items[0].title, body: items[0].body || '', url: items[0].url || '/#/notifications', tag: items[0].key }
        : { title: `🔔 ${items.length} reminders – Fleet Monitor`, body: items.slice(0, 4).map((i) => `• ${i.title}`).join('\n') + (items.length > 4 ? `\n…and ${items.length - 4} more` : ''),
          url: '/#/notifications', tag: 'fleet-digest' };
      pushed += (await pushToUser(uid, msg)).sent;
    }
    setSetting('notif_last_run', JSON.stringify({ at: new Date().toISOString(), created, pushed }));
    return { created, pushed };
  }
  /** Morning run: once a day after the set hour (server time zone). */
  async function runDailyIfDue(now = new Date()) {
    const hour = Number(getSetting('notif_hour') ?? 8);
    const day = now.toLocaleDateString('en-CA');
    if (now.getHours() < hour || getSetting('notif_auto_day') === day) return null;
    setSetting('notif_auto_day', day);
    return generate();
  }
  const timer = setInterval(() => runDailyIfDue().catch((e) => console.error('Reminders:', e.message)), 10 * 60e3);
  timer.unref();

  // ------------------------------------------------------------------ routes
  route('GET', '/api/notifications', ({ user }) => ({
    items: all(`SELECT id, kind, title, body, url, created_at, read_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 150`, user.id),
    unread: get(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL`, user.id).n,
    devices: all(`SELECT id, device, created_at, last_ok_at, last_error FROM push_subs WHERE user_id=? ORDER BY id`, user.id),
  }));
  route('GET', '/api/notifications/count', ({ user }) => ({ unread: get(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL`, user.id).n }));
  route('POST', '/api/notifications/read', ({ user, body }) => {
    if (body.id) run(`UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=? AND read_at IS NULL`, Number(body.id), user.id);
    else run(`UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL`, user.id);
    return { ok: true };
  });

  route('GET', '/api/push/key', () => ({ publicKey: vapid().publicKey }));
  route('POST', '/api/push/subscribe', ({ req, user, body }) => {
    const s = body.subscription || {};
    const scheme = process.env.PUSH_ALLOW_HTTP === '1' ? /^https?:\/\// : /^https:\/\//; // http only in tests
    if (!scheme.test(s.endpoint || '') || !s.keys?.p256dh || !s.keys?.auth) bad('Invalid push subscription');
    if (fromB64u(s.keys.p256dh).length !== 65) bad('Invalid push subscription key');
    // Remember the site address – used as the contact in push requests (some push services require it)
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && !/^(localhost|127\.)/.test(host)) setSetting('site_url', `https://${host}`);
    run(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, device) VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, device=excluded.device, last_error=NULL`,
      user.id, s.endpoint, s.keys.p256dh, s.keys.auth, str(body.device, 'Device', { max: 120 }));
    return { ok: true };
  });
  route('POST', '/api/push/unsubscribe', ({ user, body }) => {
    if (body.endpoint) run(`DELETE FROM push_subs WHERE endpoint=? AND user_id=?`, String(body.endpoint), user.id);
    else if (body.id) run(`DELETE FROM push_subs WHERE id=? AND user_id=?`, Number(body.id), user.id);
    return { ok: true };
  });
  route('POST', '/api/push/test', async ({ user }) => {
    const r = await pushToUser(user.id, { title: '🔔 Test notification', body: 'Reminders for insurance, PUC, fitness and warranties will arrive like this.', url: '/#/notifications', tag: 'fleet-test' });
    if (!r.devices) bad('This account has no device with notifications switched on yet.');
    return r;
  });

  route('GET', '/api/notifications/settings', { auth: 'admin' }, () => {
    let last = null;
    try { last = JSON.parse(getSetting('notif_last_run') || 'null'); } catch { /* ignore */ }
    return { days: getSetting('notif_days') || DEFAULT_DAYS, hour: Number(getSetting('notif_hour') ?? 8), last_run: last,
      devices: get(`SELECT COUNT(*) AS n FROM push_subs`).n, users_with_devices: get(`SELECT COUNT(DISTINCT user_id) AS n FROM push_subs`).n };
  });
  route('PUT', '/api/notifications/settings', { auth: 'admin' }, ({ body }) => {
    if (body.days !== undefined) {
      const list = [...new Set(String(body.days).split(/[\s,]+/).filter(Boolean).map(Number))];
      if (!list.length || list.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) bad('Reminder days: whole numbers 0–365, e.g. 30, 15, 7, 3, 1, 0');
      setSetting('notif_days', list.sort((a, b) => b - a).join(','));
    }
    if (body.hour !== undefined) {
      const h = Number(body.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) bad('Hour must be 0–23');
      setSetting('notif_hour', h);
    }
    return { ok: true };
  });
  route('POST', '/api/notifications/run', { auth: 'admin' }, () => generate());

  return { generate, runDailyIfDue, pushToUser, stageFor, vapid };
};
module.exports.stageFor = stageFor;
module.exports.encryptPayload = encryptPayload;
