'use strict';
/**
 * Vehicle upkeep:
 *   - parts with warranty / expiry  (battery with serial number + warranty, or any other part: extinguisher, wipers, FASTag…)
 *   - wheel & tyre log              (alignment, balancing, rotation, puncture, damage, replacement…)
 *   - daily oil & coolant check     (one per vehicle per day, by the driver)
 *   - complaints                    (problems, damage found, damage left by another driver) with photos and status
 */

const PART_KINDS = { battery: 'Battery', tyre: 'Tyre', other: 'Other part' };
const WHEEL_KINDS = {
  alignment: 'Wheel alignment', balancing: 'Wheel balancing', rotation: 'Tyre rotation', pressure: 'Air pressure check',
  puncture: 'Puncture repair', damage: 'Tyre / wheel damage', replacement: 'Tyre replacement', other: 'Other',
};
const WHEEL_POSITIONS = ['FL', 'FR', 'RL', 'RR', 'SPARE', 'ALL'];
const CHECK_VALUES = ['ok', 'topped_up', 'low'];
const COMPLAINT_CATEGORIES = {
  mechanical: 'Mechanical / running problem', damage_found: 'Damage found on vehicle', other_driver: 'Damage / misuse by another driver',
  electrical: 'Electrical / AC / lights', tyres: 'Tyres / wheels', cleanliness: 'Cleanliness', missing_item: 'Missing item / tool', other: 'Other',
};
const COMPLAINT_STATUS = ['open', 'in_progress', 'resolved', 'rejected'];
const PRIORITIES = ['low', 'normal', 'high'];
const DUE_DAYS = 30;

module.exports = function createMaintenance({ db, all, get, run, route, saveImage, getVehicle, num, str, isoDate, bad, HttpError, today, logChange = () => {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_parts (
      id INTEGER PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,             -- battery | tyre | other
      name TEXT NOT NULL,
      brand TEXT, serial_no TEXT, position TEXT,
      installed_on TEXT, installed_km REAL,
      warranty_months INTEGER, expiry_date TEXT,   -- expiry = given date, else installed_on + warranty
      cost REAL, vendor TEXT, photo TEXT, notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',       -- active | replaced
      replaced_on TEXT,
      created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wheel_events (
      id INTEGER PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL, odometer REAL, kind TEXT NOT NULL, positions TEXT,
      cost REAL, garage TEXT, notes TEXT, photo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_checks (
      id INTEGER PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      oil TEXT, coolant TEXT,         -- ok | topped_up | low   (oil NULL for EVs)
      notes TEXT, photo TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (vehicle_id, date)
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      reported_by INTEGER NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      other_user_id INTEGER REFERENCES users(id), other_user_name TEXT,  -- who used the vehicle before
      occurred_on TEXT, odometer REAL,
      title TEXT, description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      admin_notes TEXT, resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS complaint_photos (
      id INTEGER PRIMARY KEY,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      file TEXT NOT NULL
    );
  `);

  const addMonths = (date, months) => {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + months, d));
    if (t.getUTCDate() !== d) t.setUTCDate(0); // 31 Jan + 1 month → 28/29 Feb
    return t.toISOString().slice(0, 10);
  };
  const daysLeft = (date, t = today()) => (date ? Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 864e5) : null);
  const partStatus = (p) => {
    if (p.status !== 'active') return { state: 'replaced', days_left: null };
    const d = daysLeft(p.expiry_date);
    if (d === null) return { state: 'unknown', days_left: null };
    return { state: d < 0 ? 'expired' : d <= DUE_DAYS ? 'due' : 'ok', days_left: d };
  };
  const withPart = (p) => ({ ...p, kind_label: PART_KINDS[p.kind] || p.kind, ...partStatus(p) });
  const pick = (v, list, field) => (list.includes(v) ? v : bad(`Choose a valid ${field}`));
  const mustVehicle = (id) => get(`SELECT * FROM vehicles WHERE id=?`, Number(id)) || bad('Vehicle not found');
  const isAdmin = (u) => u.role === 'admin';

  // ------------------------------------------------------------------ parts (battery / tyre / other) – admin
  function partBody(body, existing = {}) {
    const kind = body.kind !== undefined ? pick(body.kind, Object.keys(PART_KINDS), 'part type') : existing.kind;
    if (!kind) bad('Choose a part type');
    const installed = body.installed_on ? isoDate(body.installed_on, 'Installed on') : body.installed_on === '' ? null : existing.installed_on ?? null;
    const months = body.warranty_months !== undefined && body.warranty_months !== ''
      ? Math.round(num(body.warranty_months, 'Warranty (months)')) : body.warranty_months === '' ? null : existing.warranty_months ?? null;
    let expiry = body.expiry_date ? isoDate(body.expiry_date, 'Expiry date') : body.expiry_date === '' ? null : existing.expiry_date ?? null;
    if (body.expiry_date === undefined || body.expiry_date === '') {
      if (installed && months) expiry = addMonths(installed, months); // warranty years/months → expiry
    }
    const name = str(body.name ?? existing.name ?? (kind === 'battery' ? 'Battery' : ''), 'Name', { max: 100 })
      || (kind === 'battery' ? 'Battery' : bad('Enter the part name'));
    return {
      kind, name, installed_on: installed, warranty_months: months, expiry_date: expiry,
      brand: str(body.brand ?? existing.brand, 'Brand', { max: 100 }),
      serial_no: str(body.serial_no ?? existing.serial_no, 'Serial number', { max: 100 }),
      position: str(body.position ?? existing.position, 'Position', { max: 30 }),
      installed_km: body.installed_km !== undefined ? num(body.installed_km, 'Odometer', { required: false }) : existing.installed_km ?? null,
      cost: body.cost !== undefined ? num(body.cost, 'Cost', { required: false }) : existing.cost ?? null,
      vendor: str(body.vendor ?? existing.vendor, 'Shop / vendor', { max: 150 }),
      notes: str(body.notes ?? existing.notes, 'Notes'),
    };
  }
  // Drivers and admin can add / edit parts; only the admin can delete.
  const partLabel = (p) => `${PART_KINDS[p.kind] || 'Part'}${p.kind === 'battery' ? '' : ` "${p.name}"`}${p.serial_no ? ` (S/N ${p.serial_no})` : ''}`;
  route('POST', '/api/parts', ({ user, body }) => {
    const v = getVehicle(body.vehicle_id, user);
    const p = partBody(body);
    // A new battery normally replaces the old one
    if (p.kind === 'battery' && body.replace_previous !== false) {
      run(`UPDATE vehicle_parts SET status='replaced', replaced_on=? WHERE vehicle_id=? AND kind='battery' AND status='active'`, p.installed_on || today(), v.id);
    }
    const r = run(`INSERT INTO vehicle_parts (vehicle_id,kind,name,brand,serial_no,position,installed_on,installed_km,warranty_months,expiry_date,cost,vendor,photo,notes,created_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      v.id, p.kind, p.name, p.brand, p.serial_no, p.position, p.installed_on, p.installed_km, p.warranty_months, p.expiry_date, p.cost, p.vendor,
      saveImage(body.photo), p.notes, user.id);
    const added = withPart(get(`SELECT * FROM vehicle_parts WHERE id=?`, Number(r.lastInsertRowid)));
    logChange(v.id, user.id, `Added ${partLabel(added)}${added.expiry_date ? ` – valid till ${added.expiry_date}` : ''}`);
    return added;
  });
  route('PUT', '/api/parts/:id', ({ user, params, body }) => {
    const cur = get(`SELECT * FROM vehicle_parts WHERE id=?`, Number(params.id)) || bad('Part not found');
    getVehicle(cur.vehicle_id, user); // drivers: active vehicles only
    const p = partBody(body, cur);
    let photo = cur.photo;
    if (body.photo === null) photo = null; else if (typeof body.photo === 'string' && body.photo.startsWith('data:')) photo = saveImage(body.photo);
    let status = cur.status, replacedOn = cur.replaced_on;
    if (body.status !== undefined) {
      status = pick(body.status, ['active', 'replaced'], 'status');
      replacedOn = status === 'replaced' ? (body.replaced_on ? isoDate(body.replaced_on) : today()) : null;
    }
    run(`UPDATE vehicle_parts SET kind=?,name=?,brand=?,serial_no=?,position=?,installed_on=?,installed_km=?,warranty_months=?,expiry_date=?,
           cost=?,vendor=?,photo=?,notes=?,status=?,replaced_on=? WHERE id=?`,
      p.kind, p.name, p.brand, p.serial_no, p.position, p.installed_on, p.installed_km, p.warranty_months, p.expiry_date,
      p.cost, p.vendor, photo, p.notes, status, replacedOn, cur.id);
    const after = withPart(get(`SELECT * FROM vehicle_parts WHERE id=?`, cur.id));
    const changed = ['name', 'brand', 'serial_no', 'position', 'installed_on', 'installed_km', 'expiry_date', 'cost', 'vendor', 'notes', 'photo', 'status']
      .filter((k) => String(cur[k] ?? '') !== String(after[k] ?? ''));
    if (changed.length) {
      logChange(cur.vehicle_id, user.id, after.status === 'replaced' && cur.status !== 'replaced'
        ? `Marked ${partLabel(cur)} as replaced`
        : `Updated ${partLabel(after)}: ${changed.map((k) => (k === 'photo' ? 'photo' : `${k.replace('_', ' ')} ${cur[k] ?? '—'} → ${after[k] ?? '—'}`)).join(', ')}`);
    }
    return after;
  });
  route('DELETE', '/api/parts/:id', { auth: 'admin' }, ({ user, params }) => {
    const p = get(`SELECT * FROM vehicle_parts WHERE id=?`, Number(params.id));
    if (p) { run(`DELETE FROM vehicle_parts WHERE id=?`, p.id); logChange(p.vehicle_id, user.id, `Deleted ${partLabel(p)}`); }
    return { ok: true };
  });

  // ------------------------------------------------------------------ wheels & tyres – drivers and admin
  route('POST', '/api/wheels', ({ user, body }) => {
    const v = getVehicle(body.vehicle_id, user);
    const kind = pick(body.kind, Object.keys(WHEEL_KINDS), 'type of work');
    const positions = (Array.isArray(body.positions) ? body.positions : String(body.positions || '').split(','))
      .map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    if (positions.some((x) => !WHEEL_POSITIONS.includes(x))) bad('Unknown wheel position');
    const r = run(`INSERT INTO wheel_events (vehicle_id,user_id,date,odometer,kind,positions,cost,garage,notes,photo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      v.id, user.id, isoDate(body.date), num(body.odometer, 'Odometer', { required: false }), kind, positions.join(',') || null,
      num(body.cost, 'Cost', { required: false }), str(body.garage, 'Garage', { max: 150 }), str(body.notes, 'Notes'), saveImage(body.photo));
    return { id: Number(r.lastInsertRowid) };
  });
  route('DELETE', '/api/wheels/:id', { auth: 'admin' }, ({ params }) => { run(`DELETE FROM wheel_events WHERE id=?`, Number(params.id)); return { ok: true }; });

  // ------------------------------------------------------------------ daily oil & coolant check
  route('POST', '/api/checks', ({ user, body }) => {
    const v = getVehicle(body.vehicle_id, user);
    const ev = v.fuel_type === 'EV';
    const oil = ev ? null : pick(body.oil, CHECK_VALUES, 'engine oil level');
    const coolant = pick(body.coolant, CHECK_VALUES, 'coolant level');
    const date = body.date ? isoDate(body.date) : today();
    if (date > today()) bad('The check cannot be for a future date');
    const photo = saveImage(body.photo);
    run(`INSERT INTO daily_checks (vehicle_id,user_id,date,oil,coolant,notes,photo) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(vehicle_id,date) DO UPDATE SET user_id=excluded.user_id, oil=excluded.oil, coolant=excluded.coolant,
           notes=excluded.notes, photo=COALESCE(excluded.photo, daily_checks.photo), checked_at=datetime('now')`,
      v.id, user.id, date, oil, coolant, str(body.notes, 'Notes'), photo);
    return get(`SELECT * FROM daily_checks WHERE vehicle_id=? AND date=?`, v.id, date);
  });
  /** Today's check for every active vehicle (drivers: all active vehicles, so a shared vehicle can be checked by anyone). */
  function todayChecks(t = today()) {
    return all(`SELECT v.id AS vehicle_id, v.reg_no, v.fuel_type, v.assigned_driver_id, c.id, c.oil, c.coolant, c.notes, c.checked_at, u.name AS checked_by
                FROM vehicles v LEFT JOIN daily_checks c ON c.vehicle_id=v.id AND c.date=? LEFT JOIN users u ON u.id=c.user_id
                WHERE v.active=1 ORDER BY v.reg_no`, t).map((r) => ({ ...r, done: Boolean(r.id) }));
  }
  route('GET', '/api/checks/today', () => todayChecks());
  route('GET', '/api/checks', ({ user, query }) => {
    const where = ['1=1'], p = {};
    if (query.get('vehicle')) { where.push('c.vehicle_id=:v'); p.v = Number(query.get('vehicle')); }
    if (query.get('from')) { where.push('c.date>=:f'); p.f = query.get('from'); }
    if (query.get('to')) { where.push('c.date<=:t'); p.t = query.get('to'); }
    if (!isAdmin(user)) { where.push('c.user_id=:me'); p.me = user.id; }
    return all(`SELECT c.*, v.reg_no, u.name AS checked_by FROM daily_checks c JOIN vehicles v ON v.id=c.vehicle_id JOIN users u ON u.id=c.user_id
                WHERE ${where.join(' AND ')} ORDER BY c.date DESC, v.reg_no LIMIT 500`, p);
  });

  // ------------------------------------------------------------------ complaints
  const complaintRows = (where, p) => {
    const rows = all(`SELECT c.*, v.reg_no, u.name AS reported_by_name, o.name AS other_user_display
                      FROM complaints c JOIN vehicles v ON v.id=c.vehicle_id JOIN users u ON u.id=c.reported_by
                      LEFT JOIN users o ON o.id=c.other_user_id WHERE ${where} ORDER BY
                      CASE c.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                      CASE c.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, c.id DESC LIMIT 500`, p);
    const ph = db.prepare(`SELECT file FROM complaint_photos WHERE complaint_id=? ORDER BY id`);
    return rows.map((r) => ({ ...r, category_label: COMPLAINT_CATEGORIES[r.category] || r.category, photos: ph.all(r.id).map((x) => x.file),
      other_user: r.other_user_display || r.other_user_name || null }));
  };
  route('GET', '/api/complaints', ({ user, query }) => {
    const where = ['1=1'], p = {};
    if (!isAdmin(user)) { where.push('(c.reported_by=:me OR c.other_user_id=:me)'); p.me = user.id; }
    if (query.get('vehicle')) { where.push('c.vehicle_id=:v'); p.v = Number(query.get('vehicle')); }
    if (query.get('status')) { where.push('c.status=:s'); p.s = query.get('status'); }
    return complaintRows(where.join(' AND '), p);
  });
  route('POST', '/api/complaints', ({ user, body }) => {
    const v = getVehicle(body.vehicle_id, user);
    const category = pick(body.category, Object.keys(COMPLAINT_CATEGORIES), 'complaint type');
    const description = str(body.description, 'What is the problem?', { required: true });
    let otherId = null;
    if (body.other_user_id) {
      const o = get(`SELECT id FROM users WHERE id=?`, Number(body.other_user_id)) || bad('Driver not found');
      if (o.id === user.id) bad('Choose the other driver, not yourself');
      otherId = o.id;
    }
    const otherName = str(body.other_user_name, 'Who used the vehicle', { max: 100 });
    if (category === 'other_driver' && !otherId && !otherName) bad('Choose or type who was using the vehicle before you');
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, 8);
    if ((category === 'damage_found' || category === 'other_driver') && !photos.length) bad('Please add at least one photo of the damage');
    const files = photos.map((x) => saveImage(x));
    db.exec('BEGIN');
    try {
      const r = run(`INSERT INTO complaints (vehicle_id,reported_by,category,other_user_id,other_user_name,occurred_on,odometer,title,description,priority)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
        v.id, user.id, category, otherId, otherId ? null : otherName, body.occurred_on ? isoDate(body.occurred_on) : today(),
        num(body.odometer, 'Odometer', { required: false }), str(body.title, 'Title', { max: 150 }), description,
        PRIORITIES.includes(body.priority) ? body.priority : 'normal');
      const id = Number(r.lastInsertRowid);
      for (const f of files) run(`INSERT INTO complaint_photos (complaint_id,file) VALUES (?,?)`, id, f);
      db.exec('COMMIT');
      return { id };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
  route('PUT', '/api/complaints/:id', { auth: 'admin' }, ({ params, body }) => {
    const c = get(`SELECT * FROM complaints WHERE id=?`, Number(params.id)) || bad('Complaint not found');
    const status = body.status !== undefined ? pick(body.status, COMPLAINT_STATUS, 'status') : c.status;
    const priority = body.priority !== undefined ? pick(body.priority, PRIORITIES, 'priority') : c.priority;
    const resolved = ['resolved', 'rejected'].includes(status) ? c.resolved_at || new Date().toISOString() : null;
    run(`UPDATE complaints SET status=?, priority=?, admin_notes=?, resolved_at=?, updated_at=datetime('now') WHERE id=?`,
      status, priority, str(body.admin_notes ?? c.admin_notes, 'Notes'), resolved, c.id);
    return complaintRows('c.id=:id', { id: c.id })[0];
  });
  route('DELETE', '/api/complaints/:id', { auth: 'admin' }, ({ params }) => { run(`DELETE FROM complaints WHERE id=?`, Number(params.id)); return { ok: true }; });

  // Names of active users – for "who used the vehicle before you" (no phone numbers or roles)
  route('GET', '/api/people', () => all(`SELECT id, name FROM users WHERE active=1 ORDER BY name`));

  route('GET', '/api/maintenance/options', () => ({ part_kinds: PART_KINDS, wheel_kinds: WHEEL_KINDS, wheel_positions: WHEEL_POSITIONS,
    complaint_categories: COMPLAINT_CATEGORIES, complaint_status: COMPLAINT_STATUS, priorities: PRIORITIES }));

  // ------------------------------------------------------------------ for the vehicle page & dashboard
  function forVehicle(vehicleId, user) {
    const mineOnly = !isAdmin(user);
    return {
      parts: all(`SELECT * FROM vehicle_parts WHERE vehicle_id=? ORDER BY status='replaced', kind, COALESCE(installed_on,'') DESC, id DESC`, vehicleId).map(withPart),
      wheels: all(`SELECT w.*, u.name AS by_name FROM wheel_events w JOIN users u ON u.id=w.user_id WHERE w.vehicle_id=? ORDER BY w.date DESC, w.id DESC LIMIT 50`, vehicleId)
        .map((w) => ({ ...w, kind_label: WHEEL_KINDS[w.kind] || w.kind })),
      checks: all(`SELECT c.*, u.name AS checked_by FROM daily_checks c JOIN users u ON u.id=c.user_id WHERE c.vehicle_id=? ORDER BY c.date DESC LIMIT 14`, vehicleId),
      complaints: complaintRows(mineOnly ? 'c.vehicle_id=:v AND (c.reported_by=:me OR c.other_user_id=:me)' : 'c.vehicle_id=:v',
        mineOnly ? { v: vehicleId, me: user.id } : { v: vehicleId }).slice(0, 30),
    };
  }
  function dashboard(user) {
    const admin = isAdmin(user);
    const mine = admin ? null : new Set(all(`SELECT id FROM vehicles WHERE assigned_driver_id=?`, user.id).map((x) => x.id));
    const scope = (vid) => admin || mine.has(vid);
    const parts = all(`SELECT p.*, v.reg_no FROM vehicle_parts p JOIN vehicles v ON v.id=p.vehicle_id
                       WHERE p.status='active' AND v.active=1 AND p.expiry_date IS NOT NULL`).map(withPart)
      .filter((p) => (p.state === 'expired' || p.state === 'due') && scope(p.vehicle_id)).sort((a, b) => a.days_left - b.days_left);
    const checks = todayChecks();
    const low = all(`SELECT c.*, v.reg_no FROM daily_checks c JOIN vehicles v ON v.id=c.vehicle_id
                     WHERE c.date>=? AND (c.oil='low' OR c.coolant='low') ORDER BY c.date DESC`, today(-2)).filter((c) => scope(c.vehicle_id));
    const openComplaints = admin
      ? get(`SELECT COUNT(*) AS n, SUM(priority='high') AS high FROM complaints WHERE status IN ('open','in_progress')`)
      : get(`SELECT COUNT(*) AS n, 0 AS high FROM complaints WHERE status IN ('open','in_progress') AND reported_by=?`, user.id);
    return {
      part_alerts: parts,
      checks_today: admin ? checks : checks.filter((c) => mine.has(c.vehicle_id)),
      fluid_alerts: low,
      complaints_open: openComplaints.n || 0,
      complaints_high: openComplaints.high || 0,
    };
  }

  return { forVehicle, dashboard, todayChecks, addMonths };
};
