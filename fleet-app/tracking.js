'use strict';
/**
 * GPS location tracking while a driver is on a trip (Start trip → End trip).
 *
 *  - The driver's phone sends points in batches (kept on the phone while offline, sent later).
 *  - Only for the trip's own driver, only while the trip is open (plus a short grace period for late batches).
 *  - Admin: live map of vehicles on the road; everyone: route of their trips (admin: all trips).
 *  - Old points are deleted after LOCATION_KEEP_DAYS (default 180).
 */

const KEEP_DAYS = Math.max(7, Number(process.env.LOCATION_KEEP_DAYS) || 180);
const GOOD_ACCURACY_M = 100;   // points less accurate than this are kept but not used for distance
const MAX_SPEED_KMH = 200;     // jumps faster than this are GPS glitches
const LATE_MINUTES = 30;       // batches for a trip are accepted this long after it ended

const rad = (d) => (d * Math.PI) / 180;
/** Distance in km between two lat/lng points (haversine). */
function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Distance, duration and speeds from an ordered list of points, ignoring inaccurate points and GPS jumps. */
function summarize(points) {
  const good = points.filter((p) => p.accuracy === null || p.accuracy === undefined || p.accuracy <= GOOD_ACCURACY_M);
  let km = 0, maxKmh = 0, prev = null, rejected = 0;
  for (const p of good) {
    if (prev) {
      const d = haversineKm(prev, p);
      const hours = (Date.parse(p.recorded_at) - Date.parse(prev.recorded_at)) / 3600e3;
      const kmh = hours > 0 ? d / hours : Infinity;
      if (kmh <= MAX_SPEED_KMH) { km += d; if (hours > 0 && d > 0.05) maxKmh = Math.max(maxKmh, kmh); prev = p; rejected = 0; continue; }
      // a jump: skip it – but after 3 jumps in a row the anchor itself was the bad fix, so start again from here
      if (++rejected >= 3) { prev = p; rejected = 0; }
      continue;
    }
    prev = p;
  }
  for (const p of good) if (p.speed !== null && p.speed !== undefined && p.speed * 3.6 <= MAX_SPEED_KMH) maxKmh = Math.max(maxKmh, p.speed * 3.6);
  const first = points[0], last = points[points.length - 1];
  const minutes = first && last ? (Date.parse(last.recorded_at) - Date.parse(first.recorded_at)) / 60e3 : 0;
  return { points: points.length, used: good.length, gps_km: +km.toFixed(2), minutes: Math.round(minutes),
    max_kmh: Math.round(maxKmh), avg_kmh: minutes > 0 ? Math.round(km / (minutes / 60)) : 0 };
}

module.exports = function createTracking({ db, all, get, run, route, bad, HttpError }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_locations (
      id INTEGER PRIMARY KEY,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES users(id),
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      lat REAL NOT NULL, lng REAL NOT NULL,
      accuracy REAL, speed REAL, heading REAL,
      recorded_at TEXT NOT NULL,          -- time on the phone (ISO)
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (trip_id, recorded_at)
    );
    CREATE INDEX IF NOT EXISTS trip_locations_trip ON trip_locations(trip_id, recorded_at);
  `);
  const have = new Set(all(`PRAGMA table_info(trips)`).map((c) => c.name));
  for (const c of ['start_lat', 'start_lng', 'end_lat', 'end_lng']) if (!have.has(c)) db.exec(`ALTER TABLE trips ADD COLUMN ${c} REAL`);

  const validPoint = (p) => {
    const lat = Number(p?.lat), lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    if (lat === 0 && lng === 0) return null;
    const n = (v, max) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > max ? null : Number(v));
    const at = p.at ? new Date(p.at) : new Date();
    if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60e3 || at.getTime() < Date.now() - 7 * 864e5) return null;
    return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), accuracy: n(p.accuracy, 100000), speed: n(p.speed, 120), heading: n(p.heading, 360), at: at.toISOString() };
  };
  const insertPoint = (t, p) => run(`INSERT OR IGNORE INTO trip_locations (trip_id,driver_id,vehicle_id,lat,lng,accuracy,speed,heading,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    t.id, t.driver_id, t.vehicle_id, p.lat, p.lng, p.accuracy, p.speed, p.heading, p.at).changes;

  /** Called when a trip starts / ends with the phone's position (optional). */
  function onStart(tripId, body) {
    const p = validPoint({ lat: body.start_lat, lng: body.start_lng, accuracy: body.start_accuracy });
    if (!p) return;
    run(`UPDATE trips SET start_lat=?, start_lng=? WHERE id=?`, p.lat, p.lng, tripId);
    insertPoint(get(`SELECT * FROM trips WHERE id=?`, tripId), p);
  }
  function onEnd(tripId, body) {
    const p = validPoint({ lat: body.end_lat, lng: body.end_lng, accuracy: body.end_accuracy });
    if (!p) return;
    run(`UPDATE trips SET end_lat=?, end_lng=? WHERE id=?`, p.lat, p.lng, tripId);
    insertPoint(get(`SELECT * FROM trips WHERE id=?`, tripId), p);
  }

  const canSee = (user, t) => user.role === 'admin' || t.driver_id === user.id;
  const tripOr404 = (id) => get(`SELECT t.*, v.reg_no, u.name AS driver_name FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
                                 JOIN users u ON u.id=t.driver_id WHERE t.id=?`, Number(id)) || bad('Trip not found');

  // Phone → server: a batch of points for the driver's own open trip
  route('POST', '/api/trips/:id/locations', ({ user, params, body }) => {
    const t = tripOr404(params.id);
    if (t.driver_id !== user.id) throw new HttpError(403, 'Only the trip\'s driver can share its location');
    if (t.end_km !== null && t.ended_at && Date.now() - Date.parse(t.ended_at.replace(' ', 'T') + 'Z') > LATE_MINUTES * 60e3) {
      return { saved: 0, closed: true }; // trip finished – stop sending
    }
    const pts = Array.isArray(body.points) ? body.points.slice(0, 500) : [];
    let saved = 0, rejected = 0;
    for (const raw of pts) {
      const p = validPoint(raw);
      if (!p) { rejected++; continue; }
      saved += insertPoint(t, p);
    }
    return { saved, rejected, closed: t.end_km !== null };
  });

  // Route of one trip
  route('GET', '/api/trips/:id/route', ({ user, params }) => {
    const t = tripOr404(params.id);
    if (!canSee(user, t)) throw new HttpError(403, 'Not your trip');
    const points = all(`SELECT lat, lng, accuracy, speed, heading, recorded_at FROM trip_locations WHERE trip_id=? ORDER BY recorded_at`, t.id);
    return {
      trip: { id: t.id, reg_no: t.reg_no, vehicle_id: t.vehicle_id, driver_name: t.driver_name, date: t.date, start_km: t.start_km, end_km: t.end_km,
        odometer_km: t.end_km === null ? null : t.end_km - t.start_km, started_at: t.started_at, ended_at: t.ended_at, open: t.end_km === null,
        start: t.start_lat !== null ? { lat: t.start_lat, lng: t.start_lng } : null, end: t.end_lat !== null ? { lat: t.end_lat, lng: t.end_lng } : null },
      summary: summarize(points),
      points,
    };
  });

  // Vehicles on the road now, with their last position (admin: all, driver: own)
  route('GET', '/api/live', ({ user }) => {
    const rows = all(`SELECT t.id AS trip_id, t.vehicle_id, t.driver_id, t.date, t.start_km, t.started_at, v.reg_no, v.model, v.fuel_type,
                        u.name AS driver_name, u.phone AS driver_phone
                      FROM trips t JOIN vehicles v ON v.id=t.vehicle_id JOIN users u ON u.id=t.driver_id
                      WHERE t.end_km IS NULL ${user.role === 'admin' ? '' : 'AND t.driver_id=:me'} ORDER BY v.reg_no`,
    user.role === 'admin' ? {} : { me: user.id });
    const last = db.prepare(`SELECT lat, lng, accuracy, speed, heading, recorded_at FROM trip_locations WHERE trip_id=? ORDER BY recorded_at DESC LIMIT 1`);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM trip_locations WHERE trip_id=?`);
    return rows.map((r) => {
      const l = last.get(r.trip_id);
      return { ...r, last: l || null, points: count.get(r.trip_id).n,
        age_min: l ? Math.round((Date.now() - Date.parse(l.recorded_at)) / 60e3) : null };
    });
  });

  // Delete old points once a day
  const cleanup = () => run(`DELETE FROM trip_locations WHERE recorded_at < ?`, new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  cleanup();
  setInterval(cleanup, 24 * 3600e3).unref();

  /** For trip lists: how many points each trip has */
  const pointCounts = (tripIds) => {
    if (!tripIds.length) return {};
    const rows = all(`SELECT trip_id, COUNT(*) AS n FROM trip_locations WHERE trip_id IN (${tripIds.map(() => '?').join(',')}) GROUP BY trip_id`, ...tripIds);
    return Object.fromEntries(rows.map((r) => [r.trip_id, r.n]));
  };

  return { onStart, onEnd, pointCounts, summarize, haversineKm, KEEP_DAYS };
};
module.exports.summarize = summarize;
module.exports.haversineKm = haversineKm;
