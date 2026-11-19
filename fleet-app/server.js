'use strict';
/**
 * Fleet Driver Monitor — zero-dependency Node.js server (Node >= 22.13).
 *
 * Stores everything in SQLite (node:sqlite) under ./data and photos under ./data/uploads.
 * Roles:
 *   admin  – manages drivers & vehicles, sees every record, dashboard, CSV export.
 *   driver – logs daily kilometers, CNG fills, oil change / service, accident reports.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // dates ("today", monthly totals) follow this time zone
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // use 127.0.0.1 when behind a reverse proxy (Caddy/Nginx)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 40 * 1024 * 1024; // 40 MB (several compressed photos)
const OIL_ALERT_KM = 500; // warn when an oil change is due within this many km

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'fleet.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  license_no TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','driver')),
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  reg_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model TEXT,
  fuel_type TEXT NOT NULL DEFAULT 'CNG',
  initial_km REAL NOT NULL DEFAULT 0,
  oil_interval_km REAL NOT NULL DEFAULT 5000,
  assigned_driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  date TEXT NOT NULL,
  start_km REAL NOT NULL,
  end_km REAL,
  start_photo TEXT,
  end_photo TEXT,
  notes TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS fuel_logs (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  date TEXT NOT NULL,
  odometer REAL,                       -- NULL for Loyverse sales until someone adds the reading
  qty_kg REAL NOT NULL,                -- quantity (kg / L / kWh depending on fuel_type)
  price_per_kg REAL,                   -- price per unit
  amount REAL NOT NULL,
  station TEXT,
  photo TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fuel_type TEXT NOT NULL DEFAULT 'CNG',
  battery_start_pct REAL,
  battery_end_pct REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  date TEXT NOT NULL,
  odometer REAL NOT NULL,
  type TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  garage TEXT,
  next_due_km REAL,
  photo TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS accidents (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  occurred_at TEXT NOT NULL,
  odometer REAL NOT NULL,
  location TEXT,
  lat REAL,
  lng REAL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'minor',
  injuries INTEGER NOT NULL DEFAULT 0,
  third_party TEXT,
  police_report TEXT,
  status TEXT NOT NULL DEFAULT 'reported',
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS accident_photos (
  id INTEGER PRIMARY KEY,
  accident_id INTEGER NOT NULL REFERENCES accidents(id) ON DELETE CASCADE,
  file TEXT NOT NULL
);
`);

const q = (sql) => db.prepare(sql);
const all = (sql, ...p) => q(sql).all(...p);
const get = (sql, ...p) => q(sql).get(...p);
const run = (sql, ...p) => q(sql).run(...p);

// ---------------------------------------------------------------- migrations (safe to run every start)
function addColumn(table, column, def) {
  if (!all(`PRAGMA table_info(${table})`).some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('fuel_logs', 'fuel_type', "TEXT NOT NULL DEFAULT 'CNG'"); // records made before v1.1 were all CNG
addColumn('fuel_logs', 'battery_start_pct', 'REAL');
addColumn('fuel_logs', 'battery_end_pct', 'REAL');
// v1.2: odometer becomes optional (POS imports) – SQLite needs a table rebuild to drop NOT NULL.
if (all(`PRAGMA table_info(fuel_logs)`).find((c) => c.name === 'odometer')?.notnull) {
  const cols = 'id,driver_id,vehicle_id,date,odometer,qty_kg,price_per_kg,amount,station,photo,notes,created_at,fuel_type,battery_start_pct,battery_end_pct';
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE fuel_logs_v12 (
      id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id), vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      date TEXT NOT NULL, odometer REAL, qty_kg REAL NOT NULL, price_per_kg REAL, amount REAL NOT NULL, station TEXT, photo TEXT,
      notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), fuel_type TEXT NOT NULL DEFAULT 'CNG',
      battery_start_pct REAL, battery_end_pct REAL, source TEXT NOT NULL DEFAULT 'manual', external_id TEXT)`);
    db.exec(`INSERT INTO fuel_logs_v12 (${cols}) SELECT ${cols} FROM fuel_logs`);
    db.exec('DROP TABLE fuel_logs');
    db.exec('ALTER TABLE fuel_logs_v12 RENAME TO fuel_logs');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
addColumn('fuel_logs', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('fuel_logs', 'external_id', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS fuel_logs_external ON fuel_logs(external_id) WHERE external_id IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS fuel_logs_vehicle ON fuel_logs(vehicle_id, date)`);

// ---------------------------------------------------------------- fuels
// qty is stored in fuel_logs.qty_kg and price in price_per_kg (historic names); the unit depends on fuel_type.
const FUELS = {
  CNG: { unit: 'kg', label: 'CNG' },
  Petrol: { unit: 'L', label: 'Petrol' },
  Diesel: { unit: 'L', label: 'Diesel' },
  EV: { unit: 'kWh', label: 'EV charging' },
};
const VEHICLE_FUELS = ['CNG', 'CNG + Petrol', 'Petrol', 'Diesel', 'EV', 'Petrol + EV (hybrid)'];
/** The fuel a vehicle normally uses (first one for dual-fuel vehicles). */
const primaryFuel = (vehicleFuel) => {
  const f = String(vehicleFuel || 'CNG');
  if (f === 'EV') return 'EV';
  return Object.keys(FUELS).find((k) => f.startsWith(k)) || 'CNG';
};
const usesOil = (vehicleFuel) => String(vehicleFuel || '') !== 'EV';
/**
 * Mileage (km per unit) from fills of one fuel: distance between the first and last fill that have an
 * odometer reading, divided by the fuel added after the first of them (fills without a reading still count).
 */
function mileage(vehicleId, fuel) {
  // Only real fills/charges (quantity > 0); EV odometer-only readings carry no energy figure.
  const rows = all(`SELECT odometer, qty_kg FROM fuel_logs WHERE vehicle_id=? AND fuel_type=? AND qty_kg > 0
                    ORDER BY date, odometer IS NULL, odometer, id`, vehicleId, fuel);
  const first = rows.findIndex((r) => r.odometer !== null);
  let last = -1;
  rows.forEach((r, i) => { if (r.odometer !== null) last = i; });
  if (first < 0 || last <= first) return null;
  const used = rows.slice(first + 1, last + 1).reduce((t, r) => t + r.qty_kg, 0);
  const dist = rows[last].odometer - rows[first].odometer;
  return used > 0 && dist > 0 ? +(dist / used).toFixed(2) : null;
}
/**
 * km driven in a month from odometer readings of every kind (trips, fuel/EV readings, services, accidents):
 * highest reading in the month minus the highest reading before it (or the vehicle's starting odometer).
 * Works for vehicles whose drivers only log odometer readings (e.g. EVs charged at home/office).
 */
function odometerKm(vehicleId, month) {
  const maxWhere = (cond) => get(`SELECT MAX(km) AS km FROM (
      SELECT MAX(start_km) AS km FROM trips WHERE vehicle_id=:v AND ${cond('date')}
      UNION ALL SELECT MAX(end_km) FROM trips WHERE vehicle_id=:v AND ${cond('date')}
      UNION ALL SELECT MAX(odometer) FROM fuel_logs WHERE vehicle_id=:v AND ${cond('date')}
      UNION ALL SELECT MAX(odometer) FROM services WHERE vehicle_id=:v AND ${cond('date')}
      UNION ALL SELECT MAX(odometer) FROM accidents WHERE vehicle_id=:v AND ${cond('occurred_at')})`,
    { v: vehicleId, m: month }).km;
  const inMonth = maxWhere((c) => `substr(${c},1,7)=:m`);
  if (inMonth === null || inMonth === undefined) return 0;
  const before = maxWhere((c) => `substr(${c},1,7)<:m`);
  const start = get(`SELECT initial_km FROM vehicles WHERE id=?`, vehicleId)?.initial_km ?? 0;
  return Math.max(0, inMonth - Math.max(start, before ?? 0));
}
const fuelRow = (r) => {
  const { qty_kg, price_per_kg, ...rest } = r;
  return { ...rest, quantity: qty_kg, unit: FUELS[r.fuel_type]?.unit || '', price_per_unit: price_per_kg };
};

// ---------------------------------------------------------------- auth helpers
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
}

// First run: create an admin account.
if (!get(`SELECT id FROM users WHERE role='admin' LIMIT 1`)) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  const { hash, salt } = hashPassword(pw);
  run(`INSERT INTO users (username,name,role,pass_hash,salt) VALUES ('admin','Fleet Admin','admin',?,?)`, hash, salt);
  console.log(`Created admin account  ->  username: admin   password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : 'admin123'}`);
  if (!process.env.ADMIN_PASSWORD) console.log('!! Change this password after your first login (Profile page).');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = get(
    `SELECT u.id,u.username,u.name,u.phone,u.license_no,u.role,u.active,s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`, token);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  delete row.expires_at;
  return row;
}

// ---------------------------------------------------------------- http helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const num = (v, field, { required = true, min = 0 } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) bad(`${field} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) bad(`${field} must be a number${min === 0 ? ' ≥ 0' : ''}`);
  return n;
};
const str = (v, field, { required = false, max = 2000 } = {}) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) bad(`${field} is required`);
  return s.slice(0, max) || null;
};
const isoDate = (v, field = 'date') => {
  const s = str(v, field, { required: true });
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s))) bad(`${field} must be a valid date`);
  return s;
};

/** Save a data-URL image (from the browser) and return the stored file name. */
function saveImage(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) bad('Photo must be a JPEG, PNG or WebP image');
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) bad('Each photo must be under 10 MB');
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext === 'jpeg' ? 'jpg' : ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

// ---------------------------------------------------------------- domain helpers
function vehicleOdometer(vehicleId) {
  const r = get(`
    SELECT MAX(km) AS km FROM (
      SELECT initial_km AS km FROM vehicles WHERE id=:v
      UNION ALL SELECT MAX(start_km) FROM trips WHERE vehicle_id=:v
      UNION ALL SELECT MAX(end_km)   FROM trips WHERE vehicle_id=:v
      UNION ALL SELECT MAX(odometer) FROM fuel_logs WHERE vehicle_id=:v
      UNION ALL SELECT MAX(odometer) FROM services WHERE vehicle_id=:v
      UNION ALL SELECT MAX(odometer) FROM accidents WHERE vehicle_id=:v
    )`, { v: vehicleId });
  return r?.km ?? 0;
}

function oilStatus(vehicle) {
  if (!usesOil(vehicle.fuel_type)) {
    return { current_km: vehicleOdometer(vehicle.id), last_oil_change_km: null, last_oil_change_date: null,
      oil_due_km: null, oil_remaining_km: null, oil_status: 'na' };
  }
  const last = get(
    `SELECT odometer, next_due_km, date FROM services
      WHERE vehicle_id=? AND type='oil_change' ORDER BY odometer DESC LIMIT 1`, vehicle.id);
  const current = vehicleOdometer(vehicle.id);
  const base = last ? last.odometer : vehicle.initial_km;
  const dueAt = last?.next_due_km || base + vehicle.oil_interval_km;
  const remaining = dueAt - current;
  return {
    current_km: current,
    last_oil_change_km: last?.odometer ?? null,
    last_oil_change_date: last?.date ?? null,
    oil_due_km: dueAt,
    oil_remaining_km: remaining,
    oil_status: remaining <= 0 ? 'overdue' : remaining <= OIL_ALERT_KM ? 'due_soon' : 'ok',
  };
}

function getVehicle(id, user) {
  const v = get(`SELECT * FROM vehicles WHERE id=?`, Number(id));
  if (!v) bad('Vehicle not found');
  if (user.role === 'driver' && !v.active) bad('This vehicle is not active');
  return v;
}

/** Shared filter builder for list endpoints. Drivers only ever see their own rows. */
function listFilters(user, query, dateCol, alias = 't', { fuel = false } = {}) {
  const where = [];
  const params = {};
  if (user.role === 'driver') { where.push(`${alias}.driver_id=:me`); params.me = user.id; }
  else if (query.get('driver')) { where.push(`${alias}.driver_id=:driver`); params.driver = Number(query.get('driver')); }
  if (query.get('vehicle')) { where.push(`${alias}.vehicle_id=:vehicle`); params.vehicle = Number(query.get('vehicle')); }
  if (query.get('from')) { where.push(`substr(${dateCol},1,10)>=:from`); params.from = query.get('from'); }
  if (query.get('to')) { where.push(`substr(${dateCol},1,10)<=:to`); params.to = query.get('to'); }
  if (fuel && FUELS[query.get('fuel_type')]) { where.push(`${alias}.fuel_type=:fuel_type`); params.fuel_type = query.get('fuel_type'); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const JOIN_NAMES = (a) => `JOIN users u ON u.id=${a}.driver_id JOIN vehicles v ON v.id=${a}.vehicle_id`;

const listers = {
  trips(user, query) {
    const f = listFilters(user, query, 't.date');
    return all(`SELECT t.*, (t.end_km - t.start_km) AS distance_km, u.name AS driver_name, v.reg_no
                FROM trips t ${JOIN_NAMES('t')} ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, f.params);
  },
  fuel(user, query) {
    const f = listFilters(user, query, 't.date', 't', { fuel: true });
    return all(`SELECT t.*, u.name AS driver_name, v.reg_no
                FROM fuel_logs t ${JOIN_NAMES('t')} ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, f.params).map(fuelRow);
  },
  services(user, query) {
    const f = listFilters(user, query, 't.date');
    return all(`SELECT t.*, u.name AS driver_name, v.reg_no
                FROM services t ${JOIN_NAMES('t')} ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, f.params);
  },
  accidents(user, query) {
    const f = listFilters(user, query, 't.occurred_at');
    const rows = all(`SELECT t.*, u.name AS driver_name, v.reg_no
                FROM accidents t ${JOIN_NAMES('t')} ${f.sql} ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1000`, f.params);
    const photos = q(`SELECT file FROM accident_photos WHERE accident_id=? ORDER BY id`);
    for (const r of rows) r.photos = photos.all(r.id).map((p) => p.file);
    return rows;
  },
};

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]).filter((c) => !['pass_hash', 'salt'].includes(c));
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join(' ') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// Local calendar date in the server's time zone (set TZ, e.g. TZ=Asia/Kolkata).
const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('en-CA');

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
};

// --- auth
// Add the Secure flag when served over HTTPS (directly or via a reverse proxy).
const secure = (req) => (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

route('POST', '/api/login', { auth: 'none' }, async ({ req, body, res }) => {
  const user = get(`SELECT * FROM users WHERE username=?`, String(body.username || '').trim());
  if (!user || !user.active || !verifyPassword(body.password || '', user)) {
    throw new HttpError(401, 'Wrong username or password');
  }
  const token = crypto.randomBytes(32).toString('hex');
  run(`DELETE FROM sessions WHERE expires_at < ?`, Date.now());
  run(`INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)`, token, user.id, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure(req)}`);
  return { id: user.id, username: user.username, name: user.name, role: user.role };
});
route('POST', '/api/logout', { auth: 'none' }, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) run(`DELETE FROM sessions WHERE token=?`, token);
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure(req)}`);
  return { ok: true };
});
route('GET', '/api/me', ({ user }) => user);
route('POST', '/api/me/password', ({ user, body }) => {
  const full = get(`SELECT * FROM users WHERE id=?`, user.id);
  if (!verifyPassword(body.current || '', full)) bad('Current password is wrong');
  if (String(body.next || '').length < 6) bad('New password must be at least 6 characters');
  const { hash, salt } = hashPassword(body.next);
  run(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`, hash, salt, user.id);
  return { ok: true };
});

// --- drivers (admin)
route('GET', '/api/drivers', { auth: 'admin' }, () =>
  all(`SELECT id,username,name,phone,license_no,role,active,created_at FROM users ORDER BY role, name`));
route('POST', '/api/drivers', { auth: 'admin' }, ({ body }) => {
  const username = str(body.username, 'Username', { required: true, max: 50 });
  if (!/^[a-z0-9._-]{3,50}$/i.test(username)) bad('Username: 3+ letters/numbers, no spaces');
  if (String(body.password || '').length < 6) bad('Password must be at least 6 characters');
  if (get(`SELECT id FROM users WHERE username=?`, username)) bad('Username already taken');
  const { hash, salt } = hashPassword(body.password);
  const role = body.role === 'admin' ? 'admin' : 'driver';
  const r = run(`INSERT INTO users (username,name,phone,license_no,role,pass_hash,salt) VALUES (?,?,?,?,?,?,?)`,
    username, str(body.name, 'Name', { required: true, max: 100 }), str(body.phone, 'Phone', { max: 30 }),
    str(body.license_no, 'License', { max: 50 }), role, hash, salt);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/drivers/:id', { auth: 'admin' }, ({ params, body, user }) => {
  const id = Number(params.id);
  const target = get(`SELECT * FROM users WHERE id=?`, id);
  if (!target) bad('User not found');
  if (id === user.id && body.active === false) bad('You cannot deactivate yourself');
  run(`UPDATE users SET name=?, phone=?, license_no=?, active=? WHERE id=?`,
    str(body.name ?? target.name, 'Name', { required: true, max: 100 }),
    str(body.phone ?? target.phone, 'Phone', { max: 30 }),
    str(body.license_no ?? target.license_no, 'License', { max: 50 }),
    body.active === undefined ? target.active : body.active ? 1 : 0, id);
  if (body.password) {
    if (String(body.password).length < 6) bad('Password must be at least 6 characters');
    const { hash, salt } = hashPassword(body.password);
    run(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`, hash, salt, id);
    run(`DELETE FROM sessions WHERE user_id=?`, id);
  }
  if (body.active === false) run(`DELETE FROM sessions WHERE user_id=?`, id);
  return { ok: true };
});

// --- vehicles
route('GET', '/api/vehicles', ({ user }) => {
  const rows = all(`SELECT v.*, u.name AS driver_name FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_driver_id
                     ${user.role === 'driver' ? 'WHERE v.active=1' : ''} ORDER BY v.reg_no`);
  return rows.map((v) => ({ ...v, ...oilStatus(v) }));
});
const vehicleFuel = (v, fallback = 'CNG') => {
  if (v === undefined || v === null || v === '') return fallback;
  return VEHICLE_FUELS.includes(v) ? v : bad(`Fuel must be one of: ${VEHICLE_FUELS.join(', ')}`);
};
route('POST', '/api/vehicles', { auth: 'admin' }, ({ body }) => {
  const reg = str(body.reg_no, 'Registration number', { required: true, max: 30 }).toUpperCase();
  if (get(`SELECT id FROM vehicles WHERE reg_no=?`, reg)) bad('A vehicle with this registration already exists');
  const r = run(`INSERT INTO vehicles (reg_no,model,fuel_type,initial_km,oil_interval_km,assigned_driver_id) VALUES (?,?,?,?,?,?)`,
    reg, str(body.model, 'Model', { max: 100 }), vehicleFuel(body.fuel_type),
    num(body.initial_km, 'Current odometer', { required: false }) ?? 0,
    num(body.oil_interval_km, 'Oil change interval', { required: false }) || 5000,
    body.assigned_driver_id ? Number(body.assigned_driver_id) : null);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/vehicles/:id', { auth: 'admin' }, ({ params, body }) => {
  const v = get(`SELECT * FROM vehicles WHERE id=?`, Number(params.id));
  if (!v) bad('Vehicle not found');
  run(`UPDATE vehicles SET model=?, fuel_type=?, oil_interval_km=?, assigned_driver_id=?, active=? WHERE id=?`,
    str(body.model ?? v.model, 'Model', { max: 100 }),
    vehicleFuel(body.fuel_type, v.fuel_type),
    num(body.oil_interval_km ?? v.oil_interval_km, 'Oil change interval') || 5000,
    body.assigned_driver_id === undefined ? v.assigned_driver_id : body.assigned_driver_id ? Number(body.assigned_driver_id) : null,
    body.active === undefined ? v.active : body.active ? 1 : 0, v.id);
  return { ok: true };
});

// --- daily kilometers (trips)
route('GET', '/api/trips', ({ user, query }) => listers.trips(user, query));
route('GET', '/api/trips/open', ({ user }) =>
  all(`SELECT t.*, v.reg_no FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
        WHERE t.driver_id=? AND t.end_km IS NULL ORDER BY t.id DESC`, user.id));
route('POST', '/api/trips', ({ user, body }) => {
  const v = getVehicle(body.vehicle_id, user);
  const open = get(`SELECT t.id, u.name FROM trips t JOIN users u ON u.id=t.driver_id
                     WHERE t.vehicle_id=? AND t.end_km IS NULL`, v.id);
  if (open) bad(`This vehicle already has an open trip (${open.name}). End it first.`);
  const start = num(body.start_km, 'Starting kilometer');
  const current = vehicleOdometer(v.id);
  if (start < current) bad(`Starting kilometer cannot be lower than the last reading (${current} km)`);
  const r = run(`INSERT INTO trips (driver_id,vehicle_id,date,start_km,start_photo,notes) VALUES (?,?,?,?,?,?)`,
    user.id, v.id, body.date ? isoDate(body.date) : today(), start, saveImage(body.start_photo), str(body.notes, 'Notes'));
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/trips/:id/end', ({ user, params, body }) => {
  const t = get(`SELECT * FROM trips WHERE id=?`, Number(params.id));
  if (!t) bad('Trip not found');
  if (user.role === 'driver' && t.driver_id !== user.id) throw new HttpError(403, 'Not your trip');
  if (t.end_km !== null) bad('Trip already ended');
  const end = num(body.end_km, 'Ending kilometer');
  if (end < t.start_km) bad(`Ending kilometer must be at least the starting kilometer (${t.start_km})`);
  if (end - t.start_km > 2000) bad('More than 2000 km in one trip — please check the reading');
  run(`UPDATE trips SET end_km=?, end_photo=?, notes=COALESCE(?,notes), ended_at=datetime('now') WHERE id=?`,
    end, saveImage(body.end_photo), str(body.notes, 'Notes'), t.id);
  return { ok: true, distance_km: end - t.start_km };
});

// --- fuel & charging (CNG / Petrol / Diesel / EV)
route('GET', '/api/fuels', () => ({ fuels: FUELS, vehicle_fuels: VEHICLE_FUELS }));
route('GET', '/api/fuel', ({ user, query }) => listers.fuel(user, query));
route('POST', '/api/fuel', ({ user, body }) => {
  const v = getVehicle(body.vehicle_id, user);
  const type = body.fuel_type ? (FUELS[body.fuel_type] ? body.fuel_type : bad('Choose CNG, Petrol, Diesel or EV')) : primaryFuel(v.fuel_type);
  const unit = FUELS[type].unit;
  const isEV = type === 'EV';
  const date = isoDate(body.date);
  const odometer = num(body.odometer, 'Odometer');
  // EVs: kWh and cost are optional – a reading with only the odometer records usage (home/office charging).
  const qty = num(body.quantity ?? body.qty_kg, `Quantity (${unit})`, { required: !isEV }) ?? 0;
  if (!isEV && qty <= 0) bad('Quantity must be more than 0');
  const price = num(body.price_per_unit ?? body.price_per_kg, `Price per ${unit}`, { required: false });
  const amount = num(body.amount, 'Amount', { required: false })
    ?? (price !== null && qty > 0 ? +(price * qty).toFixed(2) : isEV ? 0 : null);
  if (amount === null) bad(`Enter the total amount or the price per ${unit}`);
  if (isEV) {
    if (odometer < v.initial_km) bad(`Odometer cannot be lower than the vehicle's starting reading (${v.initial_km} km)`);
    const prev = get(`SELECT MAX(odometer) AS km FROM fuel_logs WHERE vehicle_id=? AND fuel_type='EV' AND date<=?`, v.id, date).km;
    if (prev !== null && odometer < prev) bad(`Odometer is lower than the previous EV reading (${prev} km)`);
    const next = get(`SELECT MIN(odometer) AS km FROM fuel_logs WHERE vehicle_id=? AND fuel_type='EV' AND date>?`, v.id, date).km;
    if (next !== null && odometer > next) bad(`Odometer is higher than a later EV reading (${next} km) – check the date`);
  }
  let b1 = null, b2 = null;
  if (isEV) {
    b1 = num(body.battery_start_pct, 'Battery % before', { required: false });
    b2 = num(body.battery_end_pct, 'Battery % after', { required: false });
    if ((b1 !== null && b1 > 100) || (b2 !== null && b2 > 100)) bad('Battery % must be between 0 and 100');
    if (b1 !== null && b2 !== null && b2 < b1 && qty > 0) bad('Battery % after charging must be higher than before');
  }
  const r = run(`INSERT INTO fuel_logs (driver_id,vehicle_id,date,odometer,fuel_type,qty_kg,price_per_kg,amount,station,battery_start_pct,battery_end_pct,photo,notes)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, v.id, date, odometer, type, qty,
    qty > 0 ? price ?? +(amount / qty).toFixed(2) : price, amount, str(body.station, 'Station', { max: 200 }), b1, b2,
    saveImage(body.photo), str(body.notes, 'Notes'));
  return { id: Number(r.lastInsertRowid) };
});

// Add the odometer reading to a fill that has none (e.g. imported from Loyverse)
route('PUT', '/api/fuel/:id/odometer', ({ user, params, body }) => {
  const f = get(`SELECT f.*, v.assigned_driver_id FROM fuel_logs f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.id=?`, Number(params.id));
  if (!f) bad('Record not found');
  if (user.role === 'driver' && f.driver_id !== user.id && f.assigned_driver_id !== user.id) throw new HttpError(403, 'Not your vehicle');
  if (user.role === 'driver' && f.odometer !== null) bad('Odometer already recorded – ask the admin to change it');
  run(`UPDATE fuel_logs SET odometer=? WHERE id=?`, num(body.odometer, 'Odometer'), f.id);
  return { ok: true };
});

// --- Loyverse POS (admin)
const loyverse = require('./loyverse')({ db, all, get, run });
const lvErr = (e) => { throw new HttpError(e.status && e.status < 500 ? e.status : 502, e.message); };
route('GET', '/api/loyverse', { auth: 'admin' }, () => loyverse.status());
route('PUT', '/api/loyverse', { auth: 'admin' }, async ({ body }) => {
  if (body.token) await loyverse.test(String(body.token).trim()).catch(lvErr); // only save a token that works
  try { loyverse.configure(body); } catch (e) { lvErr(e); }
  return loyverse.status();
});
route('POST', '/api/loyverse/test', { auth: 'admin' }, () => loyverse.test().catch(lvErr));
route('POST', '/api/loyverse/sync', { auth: 'admin' }, () => loyverse.sync().catch(lvErr));
route('POST', '/api/loyverse/push-vehicles', { auth: 'admin' }, () => loyverse.pushVehicles().catch(lvErr));
route('GET', '/api/loyverse/unmatched', { auth: 'admin' }, ({ query }) =>
  all(`SELECT * FROM pos_unmatched WHERE status=? ORDER BY receipt_date DESC, id DESC LIMIT 500`, query.get('status') || 'pending'));
route('POST', '/api/loyverse/unmatched/:id/assign', { auth: 'admin' }, ({ params, body }) => {
  try { return loyverse.assignUnmatched(Number(params.id), Number(body.vehicle_id)); } catch (e) { return lvErr(e); }
});
route('POST', '/api/loyverse/unmatched/:id/ignore', { auth: 'admin' }, ({ params }) => {
  run(`UPDATE pos_unmatched SET status='ignored' WHERE id=? AND status='pending'`, Number(params.id));
  return { ok: true };
});

// --- vehicle documents: insurance / pollution / fitness / tax / permit (admin)
const documents = require('./documents')({ db, all, get, run, today });
const docErr = (e) => { throw new HttpError(e.status && e.status < 500 ? e.status : 502, e.message); };
route('GET', '/api/documents', { auth: 'admin' }, () => ({ vehicles: documents.list(), settings: documents.status() }));
route('PUT', '/api/documents/settings', { auth: 'admin' }, ({ body }) => {
  try { documents.configure(body); } catch (e) { docErr(e); }
  return documents.status();
});
route('POST', '/api/documents/sync', { auth: 'admin' }, async ({ body }) => {
  if (body.vehicle_id) return documents.syncOne(Number(body.vehicle_id)).catch(docErr);
  return documents.syncAll().catch(docErr);
});
route('PUT', '/api/documents/:vehicleId', { auth: 'admin' }, ({ params, body }) => {
  try { return documents.updateManual(Number(params.vehicleId), body); } catch (e) { return docErr(e); }
});

// --- one vehicle: everything about it
route('GET', '/api/vehicles/:id/summary', ({ user, params, query }) => {
  const v = get(`SELECT v.*, u.name AS driver_name, u.phone AS driver_phone FROM vehicles v
                 LEFT JOIN users u ON u.id=v.assigned_driver_id WHERE v.id=?`, Number(params.id));
  if (!v || (user.role === 'driver' && !v.active)) throw new HttpError(404, 'Vehicle not found');
  const month = (query.get('month') || today().slice(0, 7)).slice(0, 7);
  const main = primaryFuel(v.fuel_type);
  const mine = user.role === 'driver' ? 'AND t.driver_id=:me' : '';
  const prm = { v: v.id, ...(user.role === 'driver' ? { me: user.id } : {}) };
  const list = (sql) => all(sql, prm);
  const monthKm = get(`SELECT COALESCE(SUM(end_km-start_km),0) AS km FROM trips WHERE vehicle_id=? AND end_km IS NOT NULL AND substr(date,1,7)=?`, v.id, month).km;
  const fuelMonth = all(`SELECT fuel_type, SUM(qty_kg) AS quantity, SUM(amount) AS amount FROM fuel_logs
                         WHERE vehicle_id=? AND substr(date,1,7)=? GROUP BY fuel_type`, v.id, month)
    .map((r) => ({ ...r, unit: FUELS[r.fuel_type]?.unit || '' }));
  const total = (sql) => get(sql, v.id).n;
  return {
    vehicle: { ...v, ...oilStatus(v), main_fuel: main, mileage: mileage(v.id, main), mileage_unit: `km/${FUELS[main].unit}` },
    month, month_km: monthKm, month_odometer_km: odometerKm(v.id, month), month_fuel: fuelMonth,
    month_fuel_amount: fuelMonth.reduce((t, r) => t + r.amount, 0),
    month_service_cost: get(`SELECT COALESCE(SUM(cost),0) AS c FROM services WHERE vehicle_id=? AND substr(date,1,7)=?`, v.id, month).c,
    totals: {
      km: total(`SELECT COALESCE(SUM(end_km-start_km),0) AS n FROM trips WHERE vehicle_id=? AND end_km IS NOT NULL`),
      fuel_amount: total(`SELECT COALESCE(SUM(amount),0) AS n FROM fuel_logs WHERE vehicle_id=?`),
      service_cost: total(`SELECT COALESCE(SUM(cost),0) AS n FROM services WHERE vehicle_id=?`),
      accidents: total(`SELECT COUNT(*) AS n FROM accidents WHERE vehicle_id=?`),
    },
    fuel: list(`SELECT t.*, u.name AS driver_name FROM fuel_logs t JOIN users u ON u.id=t.driver_id
                WHERE t.vehicle_id=:v ${mine} ORDER BY t.date DESC, t.id DESC LIMIT 30`).map(fuelRow),
    trips: list(`SELECT t.*, (t.end_km-t.start_km) AS distance_km, u.name AS driver_name FROM trips t JOIN users u ON u.id=t.driver_id
                 WHERE t.vehicle_id=:v ${mine} ORDER BY t.date DESC, t.id DESC LIMIT 30`),
    services: list(`SELECT t.*, u.name AS driver_name FROM services t JOIN users u ON u.id=t.driver_id
                    WHERE t.vehicle_id=:v ${mine} ORDER BY t.date DESC, t.id DESC LIMIT 30`),
    accidents: listers.accidents(user, new URLSearchParams({ vehicle: String(v.id) })).slice(0, 30),
    documents: documents.forVehicle(v.id),
  };
});

// --- oil change / service
const SERVICE_TYPES = ['oil_change', 'general_service', 'tyre', 'brake', 'battery', 'cng_kit', 'ev_battery', 'other'];
route('GET', '/api/services', ({ user, query }) => listers.services(user, query));
route('POST', '/api/services', ({ user, body }) => {
  const v = getVehicle(body.vehicle_id, user);
  const type = SERVICE_TYPES.includes(body.type) ? body.type : bad('Choose a service type');
  if (type === 'oil_change' && !usesOil(v.fuel_type)) bad('Electric vehicles do not need oil changes – choose another service type');
  const odo = num(body.odometer, 'Odometer');
  let next = num(body.next_due_km, 'Next due km', { required: false });
  if (type === 'oil_change' && !next) next = odo + v.oil_interval_km;
  if (next !== null && next <= odo) bad('Next due km must be higher than the current odometer');
  const r = run(`INSERT INTO services (driver_id,vehicle_id,date,odometer,type,cost,garage,next_due_km,photo,notes)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    user.id, v.id, isoDate(body.date), odo, type, num(body.cost, 'Cost', { required: false }) ?? 0,
    str(body.garage, 'Garage', { max: 200 }), next, saveImage(body.photo), str(body.notes, 'Notes'));
  return { id: Number(r.lastInsertRowid) };
});

// --- accidents
route('GET', '/api/accidents', ({ user, query }) => listers.accidents(user, query));
route('POST', '/api/accidents', ({ user, body }) => {
  const v = getVehicle(body.vehicle_id, user);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 8) : [];
  if (!photos.length) bad('Please attach at least one photo of the accident');
  const occurred = str(body.occurred_at, 'Date & time', { required: true });
  if (Number.isNaN(Date.parse(occurred))) bad('Date & time is not valid');
  const severity = ['minor', 'moderate', 'major'].includes(body.severity) ? body.severity : 'minor';
  const lat = num(body.lat, 'Latitude', { required: false, min: -90 });
  const lng = num(body.lng, 'Longitude', { required: false, min: -180 });
  const files = photos.map(saveImage);
  db.exec('BEGIN');
  try {
    const r = run(`INSERT INTO accidents (driver_id,vehicle_id,occurred_at,odometer,location,lat,lng,description,severity,injuries,third_party,police_report)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      user.id, v.id, occurred, num(body.odometer, 'Odometer'), str(body.location, 'Location', { max: 300 }),
      lat, lng, str(body.description, 'Description', { required: true }), severity, body.injuries ? 1 : 0,
      str(body.third_party, 'Third party', { max: 500 }), str(body.police_report, 'Police report', { max: 100 }));
    const id = Number(r.lastInsertRowid);
    for (const f of files) run(`INSERT INTO accident_photos (accident_id,file) VALUES (?,?)`, id, f);
    db.exec('COMMIT');
    return { id };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});
route('PUT', '/api/accidents/:id', { auth: 'admin' }, ({ params, body }) => {
  const a = get(`SELECT * FROM accidents WHERE id=?`, Number(params.id));
  if (!a) bad('Accident not found');
  const status = ['reported', 'in_review', 'insurance_claimed', 'closed'].includes(body.status) ? body.status : a.status;
  run(`UPDATE accidents SET status=?, admin_notes=? WHERE id=?`, status, str(body.admin_notes ?? a.admin_notes, 'Notes'), a.id);
  return { ok: true };
});

// --- delete (admin)
const DELETABLE = { trips: 'trips', fuel: 'fuel_logs', services: 'services', accidents: 'accidents' };
route('DELETE', '/api/:kind/:id', { auth: 'admin' }, ({ params }) => {
  const table = DELETABLE[params.kind];
  if (!table) throw new HttpError(404, 'Not found');
  run(`DELETE FROM ${table} WHERE id=?`, Number(params.id));
  return { ok: true };
});

// --- dashboard
route('GET', '/api/dashboard', ({ user }) => {
  const mine = user.role === 'driver';
  const dw = mine ? 'AND driver_id=:me' : '';
  const p = mine ? { me: user.id } : {};
  const d = today();
  const month = d.slice(0, 7);
  const kmSum = (cond) => get(`SELECT COALESCE(SUM(end_km-start_km),0) AS km FROM trips WHERE end_km IS NOT NULL ${dw} AND ${cond}`, p).km;
  /** Totals per fuel type: [{ fuel_type, unit, quantity, amount }] plus overall amount. */
  const fuelSum = (cond, params = p, extra = dw) => {
    const by = all(`SELECT fuel_type, COALESCE(SUM(qty_kg),0) AS quantity, COALESCE(SUM(amount),0) AS amount
                    FROM fuel_logs WHERE 1=1 ${extra} AND ${cond} GROUP BY fuel_type ORDER BY fuel_type`, params)
      .map((r) => ({ ...r, unit: FUELS[r.fuel_type]?.unit || '' }));
    return { by_type: by, amount: by.reduce((s, r) => s + r.amount, 0) };
  };
  const monthFuel = fuelSum(`substr(date,1,7)='${month}'`);
  const monthKm = kmSum(`substr(date,1,7)='${month}'`);

  const vehicles = all(`SELECT v.*, u.name AS driver_name FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_driver_id
                        WHERE v.active=1 ORDER BY v.reg_no`).map((v) => {
    const s = oilStatus(v);
    const mk = get(`SELECT COALESCE(SUM(end_km-start_km),0) AS km FROM trips WHERE vehicle_id=? AND end_km IS NOT NULL AND substr(date,1,7)=?`, v.id, month).km;
    const mf = fuelSum(`vehicle_id=:v AND substr(date,1,7)=:m`, { v: v.id, m: month }, '');
    // Mileage from fill-to-fill odometer readings of the vehicle's main fuel (km/kg, km/L or km/kWh)
    const main = primaryFuel(v.fuel_type);
    const eff = mileage(v.id, main);
    return { id: v.id, reg_no: v.reg_no, model: v.model, fuel_type: v.fuel_type, driver_name: v.driver_name, month_km: mk,
      month_odometer_km: odometerKm(v.id, month), assigned_driver_id: v.assigned_driver_id,
      month_fuel: mf.by_type, month_fuel_amount: mf.amount, mileage: eff, mileage_unit: `km/${FUELS[main].unit}`, ...s };
  });

  // Admin: km per vehicle = trips or odometer readings, whichever is higher (EVs often have readings only)
  const kmForCost = mine ? monthKm : vehicles.reduce((t, v) => t + Math.max(v.month_km, v.month_odometer_km), 0);
  const daily = all(`SELECT date, SUM(end_km-start_km) AS km FROM trips WHERE end_km IS NOT NULL ${dw}
                     AND date >= :since GROUP BY date ORDER BY date`, { ...p, since: today(-13) });

  return {
    today: { km: kmSum(`date='${d}'`), fuel: fuelSum(`date='${d}'`),
      trips: get(`SELECT COUNT(*) AS n FROM trips WHERE date=:d ${dw}`, { ...p, d }).n },
    month: { km: monthKm, fleet_km: vehicles.reduce((t, v) => t + Math.max(v.month_km, v.month_odometer_km), 0),
      fuel: monthFuel.by_type, fuel_amount: monthFuel.amount,
      service_cost: get(`SELECT COALESCE(SUM(cost),0) AS c FROM services WHERE substr(date,1,7)='${month}' ${dw}`, p).c,
      accidents: get(`SELECT COUNT(*) AS n FROM accidents WHERE substr(occurred_at,1,7)='${month}' ${dw}`, p).n,
      cost_per_km: kmForCost > 0 ? +(monthFuel.amount / kmForCost).toFixed(2) : null },
    open_accidents: get(`SELECT COUNT(*) AS n FROM accidents WHERE status!='closed' ${dw}`, p).n,
    pos_unmatched: mine ? 0 : get(`SELECT COUNT(*) AS n FROM pos_unmatched WHERE status='pending'`).n,
    doc_alerts: documents.alerts(mine ? all(`SELECT id FROM vehicles WHERE assigned_driver_id=?`, user.id).map((x) => x.id) : null),
    vehicles: mine ? vehicles.filter((v) => v.assigned_driver_id === user.id || ['overdue', 'due_soon'].includes(v.oil_status)
      || get(`SELECT 1 AS x FROM trips WHERE vehicle_id=:v AND driver_id=:me UNION SELECT 1 FROM fuel_logs WHERE vehicle_id=:v AND driver_id=:me LIMIT 1`, { v: v.id, me: user.id })) : vehicles,
    daily,
    active_trips: all(`SELECT t.id, t.start_km, t.date, t.started_at, u.name AS driver_name, v.reg_no FROM trips t
                       ${JOIN_NAMES('t')} WHERE t.end_km IS NULL ${mine ? 'AND t.driver_id=:me' : ''} ORDER BY t.id DESC`, p),
    recent_accidents: listers.accidents(user, new URLSearchParams()).slice(0, 5),
  };
});

// --- CSV export
route('GET', '/api/export/:kind', ({ user, params, query, res }) => {
  const kind = params.kind.replace(/\.csv$/, '');
  if (!listers[kind]) throw new HttpError(404, 'Unknown export');
  res.csv = { name: `${kind}-${today()}.csv`, body: toCsv(listers[kind](user, query)) };
});

// ---------------------------------------------------------------- static files
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', ...extraHeaders });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    // Uploaded photos — only for logged-in users
    if (pathname.startsWith('/uploads/')) {
      if (!currentUser(req)) return send(res, 401, 'Login required');
      const name = path.basename(pathname);
      if (!/^[\w.-]+$/.test(name)) return send(res, 400, 'Bad file name');
      return serveFile(res, path.join(UPLOAD_DIR, name), { 'Cache-Control': 'private, max-age=86400' });
    }

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const user = currentUser(req);
        if (r.auth !== 'none' && !user) throw new HttpError(401, 'Please log in');
        if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
        // Basic CSRF protection: state-changing requests must come from our own page.
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fleet-app') throw new HttpError(403, 'Bad request origin');
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await r.handler({ req, res, user, params, body, query: url.searchParams });
        if (res.csv) {
          return send(res, 200, '﻿' + res.csv.body, { 'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${res.csv.name}"` });
        }
        return send(res, 200, result ?? { ok: true });
      }
      throw new HttpError(404, 'Not found');
    }

    // Static front-end (single page app)
    const file = path.join(PUBLIC_DIR, path.normalize(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 400, 'Bad path');
    // index.html must always be fresh (it points to versioned app.js?v=N / styles.css?v=N)
    const noCache = { 'Cache-Control': 'no-cache' };
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, file.endsWith('.html') ? noCache : {});
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), noCache);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: status === 500 ? 'Server error' : err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Fleet Driver Monitor running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
server.documents = documents; // exposed for tests
module.exports = { server, db };
