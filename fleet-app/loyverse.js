'use strict';
/**
 * Loyverse POS integration.
 *
 * Every few minutes the server reads new receipts from the Loyverse API and turns each
 * Petrol / Diesel / CNG line into a fuel record for the right vehicle.
 *
 * How a receipt is matched to a vehicle (first match wins):
 *   1. the receipt's customer is a vehicle that was added to Loyverse with "Add vehicles to Loyverse"
 *   2. the vehicle number appears in the receipt comment, the line comment, or the customer's
 *      name / note / code  (spaces and dashes are ignored: "TN 01 AB-1234" = "TN01AB1234")
 *   3. the last 4 digits of exactly one vehicle appear in those texts
 * Receipts with fuel but no recognisable vehicle are kept as "unmatched" so an admin can
 * assign them. Refunds and cancelled receipts remove the records they created.
 *
 * Only the Loyverse access token is needed (Back Office → Settings → Access tokens).
 */

const API = (process.env.LOYVERSE_API || 'https://api.loyverse.com/v1.0').replace(/\/$/, '');
const SYNC_MINUTES = Math.max(1, Number(process.env.LOYVERSE_SYNC_MINUTES) || 5);

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Fuel type from a Loyverse item / variant name, or null if it is not fuel. */
function detectFuel(name) {
  const s = String(name || '').toLowerCase();
  if (/\bcng\b/.test(s)) return 'CNG';
  if (/diesel|\bhsd\b|turbojet|xtra ?green|hi-?speed/.test(s)) return 'Diesel';
  if (/petrol|gasoline|unleaded|\bms\b|xp ?9\d|power|speed|premium/.test(s)) return 'Petrol';
  return null;
}

module.exports = function createLoyverse({ db, all, get, run }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS pos_unmatched (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      receipt_number TEXT NOT NULL,
      receipt_date TEXT NOT NULL,
      item_name TEXT,
      fuel_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      amount REAL NOT NULL,
      info TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | assigned | ignored
      fuel_log_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (!all(`PRAGMA table_info(vehicles)`).some((c) => c.name === 'loyverse_customer_id')) {
    db.exec(`ALTER TABLE vehicles ADD COLUMN loyverse_customer_id TEXT`);
  }

  const getSetting = (k) => get(`SELECT value FROM settings WHERE key=?`, k)?.value ?? null;
  const setSetting = (k, v) => (v === null || v === undefined
    ? run(`DELETE FROM settings WHERE key=?`, k)
    : run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v)));

  async function lv(path, { method = 'GET', body, token = getSetting('loyverse_token') } = {}) {
    if (!token) throw new Error('Loyverse is not connected. Paste an access token first.');
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`Could not reach Loyverse (${e.cause?.code || e.name || e.message})`);
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) {
      // 400 (not 401) so the website does not think the *user* was logged out
      throw Object.assign(new Error('Loyverse rejected the access token. Create a new one in Loyverse Back Office → Settings → Access tokens.'), { status: 400 });
    }
    if (!res.ok) {
      const err = new Error(`Loyverse error ${res.status}: ${data.errors?.[0]?.details || data.errors?.[0]?.code || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Read every page of a Loyverse list endpoint. */
  async function listAll(path, key, params = {}) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 200; page++) {
      const qs = new URLSearchParams({ limit: '250', ...params, ...(cursor ? { cursor } : {}) });
      const data = await lv(`${path}?${qs}`);
      out.push(...(data[key] || []));
      cursor = data.cursor;
      if (!cursor) break;
    }
    return out;
  }

  function vehiclesForMatching() {
    return all(`SELECT id, reg_no, assigned_driver_id, loyverse_customer_id FROM vehicles`)
      .map((v) => ({ ...v, key: norm(v.reg_no), last4: (norm(v.reg_no).match(/(\d{4})$/) || [])[1] || null }));
  }

  function findVehicle(receipt, line, customer, vehicles) {
    if (receipt.customer_id) {
      const byCustomer = vehicles.find((v) => v.loyverse_customer_id && v.loyverse_customer_id === receipt.customer_id);
      if (byCustomer) return byCustomer;
    }
    const texts = [receipt.note, line.line_note, customer?.name, customer?.note, customer?.customer_code].filter(Boolean);
    const hay = norm(texts.join(' '));
    if (hay) {
      const full = vehicles.filter((v) => v.key.length >= 4).sort((a, b) => b.key.length - a.key.length).find((v) => hay.includes(v.key));
      if (full) return full;
    }
    // Last 4 digits, only when exactly one vehicle fits
    const digits = new Set(texts.join(' ').match(/\d{4}/g) || []);
    const hits = vehicles.filter((v) => v.last4 && digits.has(v.last4));
    return hits.length === 1 ? hits[0] : null;
  }

  const fallbackDriver = () => get(`SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1`)?.id
    ?? get(`SELECT id FROM users ORDER BY id LIMIT 1`)?.id;
  const localDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? new Date().toLocaleDateString('en-CA') : d.toLocaleDateString('en-CA');
  };

  function insertFuelLog(v, rec) {
    const r = run(`INSERT OR IGNORE INTO fuel_logs (driver_id,vehicle_id,date,odometer,fuel_type,qty_kg,price_per_kg,amount,station,notes,source,external_id)
                   VALUES (?,?,?,NULL,?,?,?,?,?,?,'loyverse',?)`,
      v.assigned_driver_id || fallbackDriver(), v.id, rec.date, rec.fuel_type, rec.quantity, rec.price, rec.amount,
      rec.station, rec.notes, rec.external_id);
    return r.changes ? Number(r.lastInsertRowid) : null;
  }

  /** Remove everything that came from one receipt (used for refunds and cancellations). */
  function removeReceipt(number) {
    const prefix = `${number}:`;
    const a = run(`DELETE FROM fuel_logs WHERE source='loyverse' AND substr(external_id,1,length(?))=?`, prefix, prefix).changes;
    const b = run(`DELETE FROM pos_unmatched WHERE substr(external_id,1,length(?))=?`, prefix, prefix).changes;
    return a + b;
  }

  let running = null;
  function sync() {
    if (!running) running = doSync().finally(() => { running = null; });
    return running;
  }

  async function doSync() {
    const started = new Date();
    const stats = { receipts: 0, imported: 0, unmatched: 0, removed: 0, skipped_non_fuel: 0 };
    try {
      const last = getSetting('loyverse_last_sync');
      // 10 minutes overlap so late edits/refunds are not missed; already-imported lines are skipped.
      const since = last ? new Date(new Date(last).getTime() - 10 * 60e3) : new Date(getSetting('loyverse_since') || Date.now() - 7 * 864e5);
      const receipts = await listAll('/receipts', 'receipts', { updated_at_min: since.toISOString() });
      receipts.sort((a, b) => String(a.receipt_date || a.created_at).localeCompare(String(b.receipt_date || b.created_at)));
      const vehicles = vehiclesForMatching();
      const customers = new Map();
      const stores = new Map();
      const known = (ext) => get(`SELECT 1 FROM fuel_logs WHERE external_id=?`, ext) || get(`SELECT 1 FROM pos_unmatched WHERE external_id=?`, ext);

      for (const receipt of receipts) {
        stats.receipts++;
        const number = String(receipt.receipt_number || '');
        if (!number) continue;
        if (receipt.cancelled_at) { stats.removed += removeReceipt(number); continue; }
        if (receipt.receipt_type === 'REFUND') {
          if (receipt.refund_for) stats.removed += removeReceipt(String(receipt.refund_for));
          continue;
        }
        let customer = null;
        if (receipt.customer_id) {
          if (!customers.has(receipt.customer_id)) {
            customers.set(receipt.customer_id, await lv(`/customers/${encodeURIComponent(receipt.customer_id)}`).catch(() => null));
          }
          customer = customers.get(receipt.customer_id);
        }
        let storeName = null;
        if (receipt.store_id) {
          if (!stores.has(receipt.store_id)) stores.set(receipt.store_id, await lv(`/stores/${encodeURIComponent(receipt.store_id)}`).then((s) => s.name).catch(() => null));
          storeName = stores.get(receipt.store_id);
        }
        (receipt.line_items || []).forEach((line, i) => {
          const itemName = [line.item_name, line.variant_name].filter(Boolean).join(' ');
          const fuel = detectFuel(itemName);
          if (!fuel) { stats.skipped_non_fuel++; return; }
          const external_id = `${number}:${line.id || i}`;
          if (known(external_id)) return;
          const quantity = Number(line.quantity);
          if (!(quantity > 0)) return;
          const amount = Number(line.total_money ?? line.gross_total_money ?? quantity * Number(line.price || 0));
          const price = Number(line.price) > 0 ? Number(line.price) : +(amount / quantity).toFixed(2);
          const rec = {
            external_id, fuel_type: fuel, quantity, price, amount, date: localDate(receipt.receipt_date || receipt.created_at),
            station: storeName ? `${storeName} (Loyverse)` : 'Loyverse', notes: `Loyverse receipt ${number} · ${itemName}`,
          };
          const v = findVehicle(receipt, line, customer, vehicles);
          if (v) {
            if (insertFuelLog(v, rec)) stats.imported++;
          } else {
            const info = [receipt.note && `Comment: ${receipt.note}`, line.line_note && `Line: ${line.line_note}`,
              customer?.name && `Customer: ${customer.name}`].filter(Boolean).join(' · ');
            run(`INSERT OR IGNORE INTO pos_unmatched (external_id,receipt_number,receipt_date,item_name,fuel_type,quantity,price,amount,info)
                 VALUES (?,?,?,?,?,?,?,?,?)`, external_id, number, rec.date, itemName, fuel, quantity, price, amount, info || null);
            stats.unmatched++;
          }
        });
      }
      setSetting('loyverse_last_sync', started.toISOString());
      setSetting('loyverse_last_result', JSON.stringify({ at: started.toISOString(), ...stats }));
      setSetting('loyverse_last_error', null);
      return stats;
    } catch (e) {
      setSetting('loyverse_last_error', JSON.stringify({ at: started.toISOString(), message: e.message }));
      throw e;
    }
  }

  async function test(token) {
    const data = await lv('/stores', { token: token || undefined });
    return { stores: (data.stores || []).map((s) => s.name) };
  }

  /** Create (or update) one Loyverse customer per vehicle, named by the vehicle number. */
  async function pushVehicles() {
    const vehicles = all(`SELECT id, reg_no, model, loyverse_customer_id FROM vehicles WHERE active=1 ORDER BY reg_no`);
    const existing = await listAll('/customers', 'customers');
    const byName = new Map(existing.map((c) => [norm(c.name), c]));
    const ids = new Set(existing.map((c) => c.id));
    const stats = { created: 0, linked: 0, updated: 0 };
    for (const v of vehicles) {
      const body = { name: v.reg_no, note: `Fleet vehicle${v.model ? ' – ' + v.model : ''}. Select this customer when fuelling ${v.reg_no}.` };
      let id = v.loyverse_customer_id && ids.has(v.loyverse_customer_id) ? v.loyverse_customer_id : null;
      let linkedByName = false;
      if (!id && byName.has(norm(v.reg_no))) { id = byName.get(norm(v.reg_no)).id; linkedByName = true; }
      const saved = await lv('/customers', { method: 'POST', body: id ? { id, ...body } : body });
      if (!id) stats.created++; else if (linkedByName) stats.linked++; else stats.updated++;
      run(`UPDATE vehicles SET loyverse_customer_id=? WHERE id=?`, saved.id || id, v.id);
    }
    return stats;
  }

  function assignUnmatched(id, vehicleId) {
    const u = get(`SELECT * FROM pos_unmatched WHERE id=?`, id);
    if (!u) throw Object.assign(new Error('Not found'), { status: 404 });
    if (u.status !== 'pending') throw Object.assign(new Error('Already handled'), { status: 400 });
    const v = get(`SELECT id, assigned_driver_id FROM vehicles WHERE id=?`, vehicleId);
    if (!v) throw Object.assign(new Error('Choose a vehicle'), { status: 400 });
    const fid = insertFuelLog(v, { external_id: u.external_id, fuel_type: u.fuel_type, quantity: u.quantity, price: u.price,
      amount: u.amount, date: u.receipt_date, station: 'Loyverse', notes: `Loyverse receipt ${u.receipt_number} · ${u.item_name || ''}` });
    run(`UPDATE pos_unmatched SET status='assigned', fuel_log_id=? WHERE id=?`, fid, u.id);
    return { fuel_log_id: fid };
  }

  function status() {
    const token = getSetting('loyverse_token');
    const parse = (k) => { try { return JSON.parse(getSetting(k) || 'null'); } catch { return null; } };
    return {
      connected: Boolean(token),
      token_hint: token ? `••••${token.slice(-4)}` : null,
      enabled: getSetting('loyverse_enabled') !== '0',
      since: getSetting('loyverse_since'),
      last_sync: getSetting('loyverse_last_sync'),
      last_result: parse('loyverse_last_result'),
      last_error: parse('loyverse_last_error'),
      interval_minutes: SYNC_MINUTES,
      unmatched_pending: get(`SELECT COUNT(*) AS n FROM pos_unmatched WHERE status='pending'`).n,
      linked_vehicles: get(`SELECT COUNT(*) AS n FROM vehicles WHERE loyverse_customer_id IS NOT NULL AND active=1`).n,
    };
  }

  function configure({ token, enabled, since }) {
    if (token !== undefined) {
      const t = String(token || '').trim();
      setSetting('loyverse_token', t || null);
      if (!t) setSetting('loyverse_last_error', null);
    }
    if (enabled !== undefined) setSetting('loyverse_enabled', enabled ? '1' : '0');
    if (since !== undefined) {
      if (since && Number.isNaN(Date.parse(since))) throw Object.assign(new Error('Invalid start date'), { status: 400 });
      setSetting('loyverse_since', since ? new Date(since).toISOString() : null);
      setSetting('loyverse_last_sync', null); // re-read from the new start date (already imported lines are skipped)
    }
  }

  // Background sync
  const timer = setInterval(() => {
    if (getSetting('loyverse_token') && getSetting('loyverse_enabled') !== '0') sync().catch((e) => console.error('Loyverse sync:', e.message));
  }, SYNC_MINUTES * 60e3);
  timer.unref();

  return { sync, test, pushVehicles, assignUnmatched, status, configure, detectFuel, getSetting };
};

module.exports.detectFuel = detectFuel;
