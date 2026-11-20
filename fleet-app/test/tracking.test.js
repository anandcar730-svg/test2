'use strict';
// GPS tracking during trips.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { haversineKm, summarize } = require('../tracking.js');

// ---- distance maths: Chennai Central → Chennai airport ≈ 14.8 km in a straight line
const central = { lat: 13.0827, lng: 80.2757 }, airport = { lat: 12.9941, lng: 80.1709 };
const d = haversineKm(central, airport);
assert.ok(d > 14.5 && d < 15.2, `haversine ${d}`);
// GPS glitch (a point 300 km away for one fix) is ignored; inaccurate points do not count
const t0 = Date.parse('2026-11-20T08:00:00Z');
const at = (min) => new Date(t0 + min * 60e3).toISOString();
const s = summarize([
  { ...central, accuracy: 10, speed: null, recorded_at: at(0) },
  { lat: 15.8, lng: 80.2, accuracy: 15, speed: null, recorded_at: at(5) },     // glitch
  { lat: 13.05, lng: 80.24, accuracy: 900, speed: null, recorded_at: at(10) }, // poor fix
  { ...airport, accuracy: 12, speed: 11, recorded_at: at(30) },
]);
assert.equal(s.points, 4); assert.equal(s.used, 3);
assert.ok(Math.abs(s.gps_km - d) < 0.05, `gps_km ${s.gps_km}`);
assert.equal(s.minutes, 30);
assert.ok(s.avg_kmh >= 29 && s.avg_kmh <= 30);
assert.ok(s.max_kmh >= 39 && s.max_kmh < 45, `max ${s.max_kmh}`); // 11 m/s = 39.6 km/h, or the leg speed

// a wrong FIRST fix (300 km away) must not wipe out the whole trip
const s2 = summarize([
  { lat: 15.8, lng: 80.2, accuracy: 15, speed: null, recorded_at: at(0) },   // bad first fix
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ lat: central.lat - i * 0.009, lng: central.lng, accuracy: 10, speed: null, recorded_at: at(i * 2) })),
]);
assert.ok(s2.gps_km >= 2.9 && s2.gps_km < 3.1, `recovered after bad first fix: ${s2.gps_km}`); // 3 legs of ~1 km after the anchor resets

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gps-'));
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
  const admin = client(), ravi = client(), suresh = client();
  await admin('/api/login', 'POST', { username: 'admin', password: 'admin123' });
  await admin('/api/drivers', 'POST', { name: 'Ravi', username: 'ravi', password: 'ravi123' });
  await admin('/api/drivers', 'POST', { name: 'Suresh', username: 'suresh', password: 'suresh123' });
  const car = (await admin('/api/vehicles', 'POST', { reg_no: 'TN01AB1234', initial_km: 1000 })).data.id;
  await ravi('/api/login', 'POST', { username: 'ravi', password: 'ravi123' });
  await suresh('/api/login', 'POST', { username: 'suresh', password: 'suresh123' });

  // start with position
  const trip = (await ravi('/api/trips', 'POST', { vehicle_id: car, start_km: 1000, start_lat: central.lat, start_lng: central.lng, start_accuracy: 8 })).data.id;
  const now = Date.now();
  // (test timing) the start fix happened an hour ago, before the driving points below
  require('../server.js').db.prepare(`UPDATE trip_locations SET recorded_at=? WHERE trip_id=?`).run(new Date(now - 3600e3).toISOString(), trip);
  // batch from the phone: route towards the airport, one bad point, one duplicate
  const iso = (sec) => new Date(now - 3600e3 + sec * 1000).toISOString();
  const points = [];
  for (let i = 1; i <= 10; i++) {
    const f = i / 10;
    points.push({ lat: central.lat + (airport.lat - central.lat) * f, lng: central.lng + (airport.lng - central.lng) * f, accuracy: 12, speed: 12.5, heading: 225, at: iso(i * 180) });
  }
  const batch = await ravi(`/api/trips/${trip}/locations`, 'POST', { points: [...points, { lat: 999, lng: 1 }, points[3]] });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));
  assert.deepEqual([batch.data.saved, batch.data.rejected, batch.data.closed], [10, 1, false]);
  assert.equal((await suresh(`/api/trips/${trip}/locations`, 'POST', { points })).status, 403, 'only the trip driver');
  assert.equal((await admin(`/api/trips/${trip}/locations`, 'POST', { points })).status, 403, 'not even admin can inject points');

  // live: admin sees the vehicle on the road with its last position; Suresh sees nothing
  const live = (await admin('/api/live')).data;
  assert.equal(live.length, 1);
  assert.deepEqual([live[0].reg_no, live[0].driver_name, live[0].points], ['TN01AB1234', 'Ravi', 11]);
  assert.ok(Math.abs(live[0].last.lat - airport.lat) < 1e-4);
  assert.equal((await suresh('/api/live')).data.length, 0);
  assert.equal((await ravi('/api/live')).data.length, 1);

  // end with position; route summary
  await ravi(`/api/trips/${trip}/end`, 'PUT', { end_km: 1016, end_lat: airport.lat + 0.001, end_lng: airport.lng, end_accuracy: 9 });
  const rt = (await admin(`/api/trips/${trip}/route`)).data;
  assert.equal(rt.points.length, 12);
  assert.deepEqual([rt.trip.odometer_km, rt.trip.open, rt.trip.start.lat, rt.trip.end.lng], [16, false, central.lat, airport.lng]);
  assert.ok(rt.summary.gps_km > 14.5 && rt.summary.gps_km < 15.5, `route ${rt.summary.gps_km}`);
  assert.equal((await ravi(`/api/trips/${trip}/route`)).status, 200, 'driver sees own route');
  assert.equal((await suresh(`/api/trips/${trip}/route`)).status, 403, 'other drivers cannot');
  assert.equal((await admin('/api/live')).data.length, 0, 'ended trips leave the live map');
  const list = (await admin('/api/trips')).data;
  assert.equal(list[0].gps_points, 12);

  // late batch right after the end is still accepted (phone was offline) …
  const late = await ravi(`/api/trips/${trip}/locations`, 'POST', { points: [{ ...airport, accuracy: 5, at: new Date().toISOString() }] });
  assert.deepEqual([late.data.saved, late.data.closed], [1, true]);
  // … but not 31 minutes after
  require('../server.js').db.prepare(`UPDATE trips SET ended_at=datetime('now','-31 minutes') WHERE id=?`).run(trip);
  const tooLate = await ravi(`/api/trips/${trip}/locations`, 'POST', { points: [{ ...airport, accuracy: 5, at: new Date().toISOString() }] });
  assert.deepEqual([tooLate.data.saved, tooLate.data.closed], [0, true]);

  // trips without GPS (phone said no) still work
  const t2 = (await ravi('/api/trips', 'POST', { vehicle_id: car, start_km: 1016 })).data.id;
  assert.equal((await admin(`/api/trips/${t2}/route`)).data.points.length, 0);
  assert.equal((await admin('/api/live')).data[0].last, null);

  // ---- background tracking with a GPS app (Traccar Client) ----------------------------------------
  const tok = (await ravi('/api/me/tracking')).data.device_id;
  assert.match(tok, /^[A-Z0-9]{12}$/);
  assert.equal((await ravi('/api/me/tracking')).data.device_id, tok, 'stable until reset');
  const app = async (qs, init = {}) => {
    const r = await fetch(`${base}/api/osmand${qs}`, init);   // no cookie, no special header – like the app
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  // Ravi has trip t2 open (started just now). Classic OsmAnd format, speed in knots, unix seconds.
  const nowS = Math.floor(Date.now() / 1000);
  let a1 = await app(`?id=${tok}&lat=13.0700&lon=80.2600&timestamp=${nowS}&speed=20&bearing=90&accuracy=6`, { method: 'POST' });
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  assert.equal(a1.data.saved, 1);
  // same through GET, lower-case id works too
  assert.equal((await app(`?id=${tok.toLowerCase()}&lat=13.0710&lon=80.2610&timestamp=${nowS + 30}`)).data.saved, 1);
  // JSON format (Traccar Client 9+): m/s speed, ISO time, a queued batch
  const js = await app('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: tok,
    location: [{ timestamp: new Date((nowS + 60) * 1000).toISOString(), coords: { latitude: 13.072, longitude: 80.262, accuracy: 5, speed: 9.5, heading: 80 } },
      { timestamp: new Date((nowS + 90) * 1000).toISOString(), coords: { latitude: 13.073, longitude: 80.263, accuracy: 5, speed: -1, heading: -1 } }] }) });
  assert.deepEqual([js.status, js.data.saved], [200, 2]);
  // form-encoded body also accepted
  assert.equal((await app('', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `id=${tok}&lat=13.074&lon=80.264&timestamp=${nowS + 120}` })).data.saved, 1);
  // wrong id → refused; a point from before the trip started → dropped (not stored)
  assert.equal((await app(`?id=WRONGID00000&lat=13&lon=80`, { method: 'POST' })).status, 403);
  const before = await app(`?id=${tok}&lat=13.06&lon=80.25&timestamp=${nowS - 3600}`, { method: 'POST' });
  assert.deepEqual([before.data.saved, before.data.outside], [0, 1]);
  const r2 = (await admin(`/api/trips/${t2}/route`)).data;
  assert.equal(r2.points.length, 5);
  assert.ok(r2.points.every((p) => p.source === 'app'));
  const knots = r2.points.find((p) => p.recorded_at === new Date(nowS * 1000).toISOString());
  assert.ok(Math.abs(knots.speed - 10.29) < 0.01, 'knots → m/s');
  const lv = (await admin('/api/live')).data[0];
  assert.equal(lv.last.source, 'app');
  assert.ok((await admin('/api/drivers')).data.find((u) => u.username === 'ravi').tracking_last_at, 'admin sees the app is working');
  // after End trip, a late (queued) point from during the trip still goes into that trip; later points are dropped
  await ravi(`/api/trips/${t2}/end`, 'PUT', { end_km: 1030 });
  assert.equal((await app(`?id=${tok}&lat=13.075&lon=80.265&timestamp=${nowS + 100}`, { method: 'POST' })).data.saved, 1, 'queued point inside the trip');
  const after = await app(`?id=${tok}&lat=13.08&lon=80.27&timestamp=${nowS + 240}`, { method: "POST" }); // 4 min after End trip
  assert.deepEqual([after.data.saved, after.data.outside], [0, 1], 'no trip → not stored');
  // reset id: old one stops working
  const tok2 = (await ravi('/api/me/tracking/reset', 'POST')).data.device_id;
  assert.notEqual(tok2, tok);
  assert.equal((await app(`?id=${tok}&lat=13&lon=80`, { method: 'POST' })).status, 403);

  console.log('✔ tracking tests passed');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
