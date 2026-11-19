'use strict';
/**
 * Vehicle documents: insurance, pollution (PUC), fitness, road tax and permit expiry dates.
 *
 * Dates come from an RC-verification API (VAHAN data via a licensed provider such as Surepass,
 * Signzy, IDfy, Cashfree…) looked up by vehicle number – automatically every morning and on
 * "Sync now" – or are typed in by the admin.  There is no free public VAHAN API.
 *
 * Providers:
 *   rtosarthi – RTO Sarthi Vahan API (from ₹1.5/successful search, prepaid). The endpoint and key format come in the
 *               private integration guide RTO Sarthi sends with the key; the response format is the one published on
 *               rtosarthi.com/vahan-api ({success, data: {INSURANCE_UPTO, PUCC_UPTO, FIT_UPTO, TAX_UPTO, …}, usage}).
 *   surepass – POST https://kyc-api.surepass.io/api/v1/rc/rc-full  {"id_number": "<number>"}  (Bearer token)
 *   custom   – any JSON API: URL (may contain {vehicle_number}), GET/POST, auth header, body template.
 * The response is searched for common field names (insurance_upto, pucc_upto, fit_up_to, tax_upto, …),
 * so most providers work without code changes.
 *
 * Smart sync (default): every morning only vehicles that need it are looked up –
 *   never fetched yet · a document expired or expiring within 30 days · last online check older than 30 days.
 * That keeps renewals showing up the next day while cutting paid lookups by ~90 %.
 */

const DOCS = ['insurance', 'pucc', 'fitness', 'tax', 'permit'];
const DOC_LABEL = { insurance: 'Insurance', pucc: 'Pollution (PUC)', fitness: 'Fitness', tax: 'Road tax', permit: 'Permit' };
const DUE_DAYS = 30;

const PRESETS = {
  rtosarthi: {
    // URL / header / body: fill in from RTO Sarthi's integration guide (not published).
    url: '', method: 'POST', auth_header: 'Authorization', auth_prefix: 'Bearer ', body: '{"vehicleNumber": "{vehicle_number}"}',
    editable: true, aliases: { rc_status: ['status'] },
  },
  surepass: {
    url: 'https://kyc-api.surepass.io/api/v1/rc/rc-full', method: 'POST',
    auth_header: 'Authorization', auth_prefix: 'Bearer ', body: '{"id_number": "{vehicle_number}"}',
  },
  custom: { url: '', method: 'POST', auth_header: 'Authorization', auth_prefix: 'Bearer ', body: '{"vehicle_number": "{vehicle_number}"}', editable: true },
};

// Field names used by different providers (compared lower-case, without _ - spaces)
const FIELDS = {
  insurance_upto: ['insurance_upto', 'insurance_valid_upto', 'insurance_validity', 'insurance_expiry', 'insurance_expiry_date',
    'insurance_upto_date', 'vehicle_insurance_upto', 'insurance_end_date', 'policy_expiry', 'policy_end_date'],
  insurance_company: ['insurance_company', 'insurance_comp', 'insurance_company_name', 'insurer', 'insurer_name', 'vehicle_insurance_company_name'],
  insurance_policy: ['insurance_policy_number', 'insurance_policy_no', 'ins_policy_no', 'policy_number', 'policy_no', 'vehicle_insurance_policy_number'],
  pucc_upto: ['pucc_upto', 'puc_upto', 'pucc_valid_upto', 'puc_valid_upto', 'pucc_validity', 'puc_validity', 'puc_expiry',
    'pollution_upto', 'pollution_valid_upto', 'pollution_expiry', 'vehicle_pucc_upto', 'pucc_end_date'],
  pucc_number: ['pucc_number', 'puc_number', 'pucc_no', 'puc_no', 'pollution_certificate_number'],
  fitness_upto: ['fit_up_to', 'fit_upto', 'fitness_upto', 'fitness_up_to', 'fitness_valid_upto', 'fitness_validity', 'fitness_expiry',
    'rc_fit_upto', 'vehicle_fitness_upto', 'fit_upto_date'],
  tax_upto: ['tax_upto', 'tax_up_to', 'tax_paid_upto', 'tax_valid_upto', 'mv_tax_upto', 'vehicle_tax_upto', 'road_tax_upto'],
  permit_upto: ['permit_valid_upto', 'permit_upto', 'permit_validity', 'permit_expiry', 'national_permit_upto', 'permit_valid_till'],
  owner_name: ['owner_name', 'owner', 'registered_owner', 'rc_owner_name'],
  maker_model: ['maker_model', 'maker_description', 'vehicle_model', 'model', 'maker_desc', 'maker'],
  rc_status: ['rc_status', 'vehicle_status', 'rc_status_as_on'],
};
const nk = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = Object.fromEntries(Object.entries(FIELDS).map(([f, list]) => [f, list.map(nk)]));
const LIFETIME = '9999-12-31'; // "LTT" – lifetime road tax
const SMART = { dueDays: DUE_DAYS, refreshDays: 30, failRetryDays: 7, staleExpiredDays: 60 };

/** Find the first value for any alias anywhere in a nested JSON object (breadth-first). */
function pick(obj, aliases) {
  const queue = [obj];
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const cur = queue[i];
    if (!cur || typeof cur !== 'object') continue;
    for (const alias of aliases) {
      for (const [k, v] of Object.entries(cur)) {
        if (nk(k) === alias && v !== null && v !== undefined && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push(v);
  }
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Parse Indian/ISO date strings to YYYY-MM-DD; null for "NA", "LTT" etc. */
function parseDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m;
  const ok = (y, mo, d) => {
    y = Number(y); mo = Number(mo); d = Number(d);
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y > 1950 && y < 2200
      ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  };
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return ok(m[1], m[2], m[3]);            // 2026-05-31
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) return ok(m[3], m[2], m[1]);           // 31-05-2026 / 31/05/2026
  if ((m = /^(\d{1,2})[-/ .]([A-Za-z]{3})[A-Za-z]*[-/ .,]+(\d{2,4})$/.exec(s)) && MONTHS[m[2].toLowerCase()]) {
    return ok(m[3], MONTHS[m[2].toLowerCase()], m[1]);                                                    // 31-May-2026
  }
  if ((m = /^([A-Za-z]{3})[A-Za-z]* (\d{1,2}),? (\d{4})$/.exec(s)) && MONTHS[m[1].toLowerCase()]) {
    return ok(m[3], MONTHS[m[1].toLowerCase()], m[2]);                                                    // May 31, 2026
  }
  if (/^\d{10,13}$/.test(s)) { const d = new Date(Number(s.length === 10 ? s * 1000 : s)); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
  return null;
}

/** Turn a provider response into our fields. */
function extract(json, extra = {}) {
  const out = {};
  for (const f of Object.keys(FIELDS)) {
    const raw = pick(json, [...ALIASES[f], ...(extra[f] || []).map(nk)]);
    out[f] = f.endsWith('_upto') ? (f === 'tax_upto' && /^(LTT|LIFE ?TIME|OTT)/i.test(raw || '') ? LIFETIME : parseDate(raw)) : raw;
  }
  return out;
}
/** Remaining prepaid searches if the provider reports them (e.g. RTO Sarthi "usage": {limit, used, remaining}). */
function usageOf(json) {
  const u = json?.usage || json?.data?.usage || json?.quota;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  const r = { limit: n(u.limit ?? u.total), used: n(u.used), remaining: n(u.remaining ?? u.balance) };
  return r.remaining === null && r.limit === null ? null : r;
}

const vehicleNumber = (reg) => String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function daysLeft(date, today) {
  if (!date) return null;
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
}
function docStatus(date, today) {
  const d = daysLeft(date, today);
  if (d === null) return { status: 'unknown', days_left: null };
  return { status: d < 0 ? 'expired' : d <= DUE_DAYS ? 'due' : 'ok', days_left: d };
}

module.exports = function createDocuments({ db, all, get, run, today }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS vehicle_docs (
      vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
      insurance_upto TEXT, insurance_company TEXT, insurance_policy TEXT,
      pucc_upto TEXT, pucc_number TEXT,
      fitness_upto TEXT, tax_upto TEXT, permit_upto TEXT,
      owner_name TEXT, maker_model TEXT, rc_status TEXT,
      source TEXT,              -- api | manual
      fetched_at TEXT,          -- last successful online update
      updated_at TEXT,
      last_error TEXT,
      last_attempt_at TEXT
    );
  `);
  const getSetting = (k) => get(`SELECT value FROM settings WHERE key=?`, k)?.value ?? null;
  const setSetting = (k, v) => (v === null || v === undefined
    ? run(`DELETE FROM settings WHERE key=?`, k)
    : run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v)));

  function config() {
    const provider = getSetting('docs_provider') || 'rtosarthi';
    const preset = PRESETS[provider] || PRESETS.custom;
    const own = (k, d) => (preset.editable ? getSetting(`docs_${provider}_${k}`) ?? d : d);
    return {
      provider,
      editable: Boolean(preset.editable),
      aliases: preset.aliases || {},
      url: preset.editable ? own('url', preset.url) : process.env.DOCS_PRESET_URL || preset.url, // env: tests only
      method: own('method', preset.method),
      auth_header: own('auth_header', preset.auth_header),
      auth_prefix: own('auth_prefix', preset.auth_prefix),
      body: own('body', preset.body),
      mode: getSetting('docs_mode') || 'smart',
      key: getSetting('docs_key'),
      enabled: getSetting('docs_enabled') !== '0',
      hour: Number(getSetting('docs_hour') ?? 6),
    };
  }

  /** Ask the provider about one vehicle number. Returns extracted fields. */
  async function lookup(reg, cfg = config()) {
    if (!cfg.key) throw Object.assign(new Error('No API key saved. Add your RC-verification API key in Documents → Online lookup settings.'), { status: 400 });
    if (!cfg.url) throw Object.assign(new Error(cfg.provider === 'rtosarthi'
      ? 'Enter the RTO Sarthi API URL from their integration guide (Documents → Online lookup settings).' : 'No API URL set.'), { status: 400 });
    const number = vehicleNumber(reg);
    const fill = (t) => String(t).replaceAll('{vehicle_number}', number);
    const headers = { Accept: 'application/json' };
    if (cfg.auth_header) headers[cfg.auth_header] = `${cfg.auth_prefix || ''}${cfg.key}`;
    let body;
    if (cfg.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = fill(cfg.body);
      try { JSON.parse(body); } catch { throw Object.assign(new Error('The request body template is not valid JSON.'), { status: 400 }); }
    }
    let res;
    try {
      res = await fetch(fill(cfg.url).replace('{vehicle_number_encoded}', encodeURIComponent(number)), {
        method: cfg.method, headers, body, signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      throw new Error(`Could not reach the lookup service (${e.cause?.code || e.name || e.message})`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const msg = json && (json.message || json.error?.message || json.error || json.msg);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`The lookup service rejected the API key${msg ? `: ${msg}` : ''}`), { status: 400 });
    if (!res.ok) throw new Error(`Lookup failed for ${number} (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
    if (!json) throw new Error(`Lookup for ${number} did not return JSON`);
    if (json.success === false || json.status === false || json.status === 'error') throw new Error(`Lookup failed for ${number}: ${msg || 'not found'}`);
    const usage = usageOf(json);
    if (usage) setSetting('docs_usage', JSON.stringify({ ...usage, at: new Date().toISOString() }));
    const fields = extract(json, cfg.aliases);
    if (!DOCS.some((d) => fields[`${d}_upto`])) throw new Error(`No expiry dates found in the response for ${number}`);
    return fields;
  }

  function saveDocs(vehicleId, fields, source) {
    const cur = get(`SELECT * FROM vehicle_docs WHERE vehicle_id=?`, vehicleId) || {};
    const keep = (f) => (fields[f] !== undefined && fields[f] !== null && fields[f] !== '' ? fields[f] : source === 'manual' && f in fields ? null : cur[f] ?? null);
    const cols = Object.keys(FIELDS);
    const now = new Date().toISOString();
    run(`INSERT INTO vehicle_docs (vehicle_id, ${cols.join(',')}, source, fetched_at, updated_at, last_error, last_attempt_at)
         VALUES (?, ${cols.map(() => '?').join(',')}, ?, ?, ?, NULL, ?)
         ON CONFLICT(vehicle_id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(',')},
           source=excluded.source, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at, last_error=NULL,
           last_attempt_at=excluded.last_attempt_at`,
      vehicleId, ...cols.map(keep), source, source === 'api' ? now : cur.fetched_at ?? null, now, source === 'api' ? now : cur.last_attempt_at ?? null);
  }

  async function syncOne(vehicleId, cfg = config()) {
    const v = get(`SELECT id, reg_no FROM vehicles WHERE id=?`, vehicleId);
    if (!v) throw Object.assign(new Error('Vehicle not found'), { status: 404 });
    try {
      const fields = await lookup(v.reg_no, cfg);
      saveDocs(v.id, fields, 'api');
      return { vehicle_id: v.id, reg_no: v.reg_no, ok: true };
    } catch (e) {
      const now = new Date().toISOString();
      run(`INSERT INTO vehicle_docs (vehicle_id, last_error, last_attempt_at) VALUES (?,?,?)
           ON CONFLICT(vehicle_id) DO UPDATE SET last_error=excluded.last_error, last_attempt_at=excluded.last_attempt_at`, v.id, e.message, now);
      if (e.status === 400) throw e; // configuration problem: stop
      return { vehicle_id: v.id, reg_no: v.reg_no, ok: false, error: e.message };
    }
  }

  /**
   * Which vehicles need an online lookup now (smart sync) and why.
   * Docs without any date (e.g. no permit for a private car) never trigger a lookup.
   */
  function smartPlan(now = new Date()) {
    const t = now.toLocaleDateString('en-CA');
    const ageDays = (iso) => (iso ? (now.getTime() - Date.parse(iso)) / 864e5 : Infinity);
    const plan = [];
    for (const v of all(`SELECT v.id, v.reg_no, d.* FROM vehicles v LEFT JOIN vehicle_docs d ON d.vehicle_id=v.id WHERE v.active=1 ORDER BY v.reg_no`)) {
      let reason = null;
      if (!v.fetched_at) {
        // never fetched: try, but after a failure only once a week
        if (v.last_error && ageDays(v.last_attempt_at) < SMART.failRetryDays) {
          plan.push({ vehicle_id: v.id, reg_no: v.reg_no, lookup: false,
            reason: `last lookup failed (${String(v.last_error).slice(0, 80)}) – retrying weekly; check the vehicle number or enter dates by hand` });
          continue;
        }
        reason = 'not checked online yet';
      } else {
        const urgent = DOCS.map((d) => ({ d, ...docStatus(v[`${d}_upto`], t) }))
          .find((x) => (x.status === 'due') || (x.status === 'expired' && -x.days_left <= SMART.staleExpiredDays));
        if (urgent) reason = `${DOC_LABEL[urgent.d]} ${urgent.status === 'expired' ? 'expired' : 'expiring soon'} – checking for renewal`;
        else if (ageDays(v.fetched_at) >= SMART.refreshDays) reason = `monthly check (last ${Math.floor(ageDays(v.fetched_at))} days ago)`;
      }
      plan.push({ vehicle_id: v.id, reg_no: v.reg_no, lookup: Boolean(reason), reason: reason || 'up to date – skipped' });
    }
    return plan;
  }

  let running = null;
  /** Look up vehicles online. smart=true: only the ones smartPlan() selects. */
  function syncAll({ smart = false } = {}) {
    if (!running) {
      running = (async () => {
        const cfg = config();
        const results = [];
        const plan = smart ? smartPlan() : all(`SELECT id AS vehicle_id FROM vehicles WHERE active=1 ORDER BY reg_no`).map((v) => ({ ...v, lookup: true }));
        for (const v of plan.filter((x) => x.lookup)) {
          results.push(await syncOne(v.vehicle_id, cfg));
          await new Promise((r) => setTimeout(r, 300)); // be gentle with the provider
        }
        const summary = { at: new Date().toISOString(), mode: smart ? 'smart' : 'all', checked: results.length,
          skipped: plan.length - results.length, updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
        setSetting('docs_last_sync', JSON.stringify(summary));
        return summary;
      })().finally(() => { running = null; });
    }
    return running;
  }

  /** Daily automatic update: once per day after the configured hour (server time zone). */
  async function runDailyIfDue(now = new Date()) {
    const cfg = config();
    if (!cfg.key || !cfg.enabled) return null;
    const day = now.toLocaleDateString('en-CA');
    if (now.getHours() < cfg.hour || getSetting('docs_auto_day') === day) return null;
    setSetting('docs_auto_day', day);
    return syncAll({ smart: cfg.mode !== 'all' });
  }
  const timer = setInterval(() => runDailyIfDue().catch((e) => console.error('Documents sync:', e.message)), 10 * 60e3);
  timer.unref();

  function withStatus(row, t = today()) {
    const docs = {};
    for (const d of DOCS) docs[d] = { upto: row?.[`${d}_upto`] ?? null, ...docStatus(row?.[`${d}_upto`], t) };
    return docs;
  }

  function list() {
    const t = today();
    return all(`SELECT v.id, v.reg_no, v.model, v.fuel_type, v.active, d.* FROM vehicles v LEFT JOIN vehicle_docs d ON d.vehicle_id=v.id
                WHERE v.active=1 ORDER BY v.reg_no`).map((r) => ({ ...r, id: r.id ?? r.vehicle_id, vehicle_id: r.id, docs: withStatus(r, t) }));
  }

  function forVehicle(vehicleId) {
    const r = get(`SELECT * FROM vehicle_docs WHERE vehicle_id=?`, vehicleId) || null;
    return { ...(r || {}), docs: withStatus(r) };
  }

  /** Expired / due-soon documents, optionally only for some vehicles. */
  function alerts(vehicleIds = null) {
    const out = [];
    for (const r of list()) {
      if (vehicleIds && !vehicleIds.includes(r.vehicle_id)) continue;
      for (const d of DOCS) {
        const s = r.docs[d];
        if (s.status === 'expired' || s.status === 'due') out.push({ vehicle_id: r.vehicle_id, reg_no: r.reg_no, doc: d, label: DOC_LABEL[d], ...s });
      }
    }
    return out.sort((a, b) => a.days_left - b.days_left);
  }

  function updateManual(vehicleId, body) {
    if (!get(`SELECT id FROM vehicles WHERE id=?`, vehicleId)) throw Object.assign(new Error('Vehicle not found'), { status: 404 });
    const fields = {};
    for (const f of Object.keys(FIELDS)) {
      if (!(f in body)) continue;
      const v = body[f] === null ? '' : String(body[f]).trim().slice(0, 200);
      if (f.endsWith('_upto') && v) {
        const p = parseDate(v);
        if (!p) throw Object.assign(new Error(`${f.replace('_upto', '')} date is not valid`), { status: 400 });
        fields[f] = p;
      } else fields[f] = v || null;
    }
    saveDocs(vehicleId, fields, 'manual');
    return forVehicle(vehicleId);
  }

  function status() {
    const c = config();
    let last = null;
    try { last = JSON.parse(getSetting('docs_last_sync') || 'null'); } catch { /* ignore */ }
    let usage = null;
    try { usage = JSON.parse(getSetting('docs_usage') || 'null'); } catch { /* ignore */ }
    const plan = smartPlan();
    return { provider: c.provider, editable: c.editable, url: c.editable ? c.url : '', method: c.method, auth_header: c.auth_header,
      auth_prefix: c.auth_prefix, body: c.body, has_key: Boolean(c.key), key_hint: c.key ? `••••${c.key.slice(-4)}` : null,
      enabled: c.enabled, hour: c.hour, mode: c.mode, last_sync: last, usage, presets: Object.keys(PRESETS),
      next_run: { lookups: c.mode === 'all' ? plan.length : plan.filter((p) => p.lookup).length, vehicles: plan.length, plan } };
  }

  function configure(b) {
    if (b.provider !== undefined) {
      if (!PRESETS[b.provider]) throw Object.assign(new Error('Unknown provider'), { status: 400 });
      setSetting('docs_provider', b.provider);
    }
    if (b.key !== undefined) setSetting('docs_key', String(b.key || '').trim() || null);
    if (b.enabled !== undefined) setSetting('docs_enabled', b.enabled ? '1' : '0');
    if (b.hour !== undefined) {
      const h = Number(b.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('Hour must be 0–23'), { status: 400 });
      setSetting('docs_hour', h);
    }
    if (b.mode !== undefined) {
      if (!['smart', 'all'].includes(b.mode)) throw Object.assign(new Error('Mode must be smart or all'), { status: 400 });
      setSetting('docs_mode', b.mode);
    }
    // URL / method / header / body belong to the selected provider (if it is editable)
    const prov = getSetting('docs_provider') || 'rtosarthi';
    if (PRESETS[prov]?.editable) {
      const k = (x) => `docs_${prov}_${x}`;
      if (b.url !== undefined) {
        if (b.url && !/^https?:\/\//i.test(b.url)) throw Object.assign(new Error('API URL must start with https://'), { status: 400 });
        setSetting(k('url'), b.url || null);
      }
      if (b.method !== undefined) setSetting(k('method'), ['GET', 'POST'].includes(b.method) ? b.method : 'POST');
      if (b.auth_header !== undefined) setSetting(k('auth_header'), String(b.auth_header || '').replace(/[^\w-]/g, ''));
      if (b.auth_prefix !== undefined) setSetting(k('auth_prefix'), String(b.auth_prefix ?? ''));
      if (b.body !== undefined) {
        if (b.body) { try { JSON.parse(String(b.body).replaceAll('{vehicle_number}', 'X')); } catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); } }
        setSetting(k('body'), b.body || null);
      }
    }
  }

  return { list, forVehicle, alerts, syncAll, syncOne, runDailyIfDue, smartPlan, updateManual, status, configure, lookup, DOC_LABEL };
};
module.exports.parseDate = parseDate;
module.exports.extract = extract;
module.exports.usageOf = usageOf;
module.exports.LIFETIME = LIFETIME;
