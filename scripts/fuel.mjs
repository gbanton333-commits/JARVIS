// Collects UK fuel prices into one compact fuel.json for JARVIS. Runs in GitHub Actions.
// 1) Official GOV.UK Fuel Finder API (via your Cloudflare proxy, because the API blocks non-UK servers)
// 2) Fallback: the retailers' own open-data feeds (partial coverage)
import { writeFileSync } from 'node:fs';

const env = process.env;
const PROXY = (env.FUEL_PROXY_URL || '').trim().replace(/\/+$/, '');
const PROXY_KEY = (env.FUEL_PROXY_KEY || '').trim();
const CLIENT_ID = (env.FUEL_CLIENT_ID || '').trim(), CLIENT_SECRET = (env.FUEL_CLIENT_SECRET || '').trim();
const BASE = PROXY || 'https://www.fuel-finder.service.gov.uk';
const SLEEP = (+env.FUEL_BATCH_SLEEP >= 0 && env.FUEL_BATCH_SLEEP !== undefined && env.FUEL_BATCH_SLEEP !== '') ? +env.FUEL_BATCH_SLEEP : 4; // API allows 30 requests/minute
const MAX_PRICE_AGE_DAYS = +env.FUEL_MAX_AGE_DAYS || 21;
const WAIT429 = (+env.FUEL_429_WAIT || 65) * 1000;
const MIN_OK = +env.FUEL_MIN_OK || 1500;   // fewer stations than this counts as a failed Fuel Finder run
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '' ? NaN : +String(v).replace(/[^\d.\-]/g, ''));
const inUK = (la, lo) => la > 49.8 && la < 60.95 && lo > -8.7 && lo < 1.9;

class Http extends Error { constructor(status, body) { super('HTTP ' + status); this.status = status; this.body = body; } }

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'user-agent': UA, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (PROXY) headers['x-proxy-key'] = PROXY_KEY;
  for (let attempt = 0; attempt < 6; attempt++) {
    let r, text = '';
    try {
      r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      text = await r.text();
    } catch (e) { if (attempt === 5) throw e; await sleep(2000 * (attempt + 1)); continue; }
    if (r.status === 429) { console.log('  rate limited (429); waiting', WAIT429 / 1000, 's'); await sleep(WAIT429); continue; }
    if ([500, 502, 503, 504].includes(r.status)) { console.log('  HTTP', r.status, '; retrying'); await sleep(3000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Http(r.status, text.slice(0, 200));
    try { return JSON.parse(text); } catch { throw new Http(r.status, 'not JSON: ' + text.slice(0, 120)); }
  }
  throw new Http(0, 'gave up after retries');
}

async function pages(path, token) {
  const out = [];
  for (let n = 1; n <= 60; n++) {
    let j;
    try { j = await call(`${path}?batch-number=${n}`, { token }); }
    catch (e) { if (e.status === 404) break; throw e; }
    const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : []);
    if (n === 1) console.log(path, 'first record keys:', arr[0] ? Object.keys(arr[0]).join(',') : '(none)');
    out.push(...arr);
    if (arr.length < 500) break;
    await sleep(SLEEP * 1000);
  }
  console.log(path, 'records:', out.length);
  return out;
}

function pence(v) { let p = num(v); if (!(p > 0)) return null; if (p < 5) p *= 100; return p >= 100 && p <= 300 ? +p.toFixed(1) : null; }

async function fuelFinder() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('FUEL_CLIENT_ID / FUEL_CLIENT_SECRET not set');
  console.log('Fuel Finder via', PROXY ? 'proxy ' + PROXY : 'direct connection (likely blocked outside the UK)');
  const t = await call('/api/v1/oauth/generate_access_token', { method: 'POST', body: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
  const token = (t.data || t).access_token;
  if (!token) throw new Error('no access_token in the login reply');
  console.log('login ok');
  await sleep(SLEEP * 1000);
  const stations = await pages('/api/v1/pfs', token);
  await sleep(SLEEP * 1000);
  const prices = await pages('/api/v1/pfs/fuel-prices', token);

  const info = new Map();
  for (const s of stations) {
    const loc = s.location || {}, la = num(loc.latitude), lo = num(loc.longitude);
    if (!s.node_id || !inUK(la, lo) || s.temporary_closure || s.permanent_closure) continue;
    const brand = String(s.brand_name || '').trim();
    const generic = !brand || /^(independent|unbranded|other|none)$/i.test(brand);
    info.set(s.node_id, { b: (generic ? String(s.trading_name || 'Station') : brand).slice(0, 24), pc: String(loc.postcode || '').trim().slice(0, 9), la: +la.toFixed(5), lo: +lo.toFixed(5) });
  }
  const cutoff = Date.now() - MAX_PRICE_AGE_DAYS * 864e5;
  const by = new Map();
  for (const p of prices) {
    if (!info.has(p.node_id)) continue;
    const row = by.get(p.node_id) || {};
    for (const f of p.fuel_prices || []) {
      const when = f.price_last_updated ? Date.parse(String(f.price_last_updated).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(f.price_last_updated) ? '' : 'Z')) : NaN;
      if (!isNaN(when) && when < cutoff) continue;           // stale price
      const v = pence(f.price); if (v == null) continue;
      const k = f.fuel_type === 'E10' ? 'e10' : f.fuel_type === 'E5' ? 'e5' : f.fuel_type === 'B7_STANDARD' ? 'b7' : null;
      if (k) row[k] = v;
    }
    by.set(p.node_id, row);
  }
  const rows = [];
  for (const [id, s] of info) { const r = by.get(id); if (r && (r.e10 != null || r.e5 != null || r.b7 != null)) rows.push([s.b, s.pc, s.la, s.lo, r.e10 ?? null, r.e5 ?? null, r.b7 ?? null]); }
  console.log(`Fuel Finder: ${info.size} open UK stations, ${rows.length} with fresh prices`);
  return rows;
}

// ---------------- fallback: retailer feeds ----------------
const FEEDS = {
  'Applegreen': 'https://applegreenstores.com/fuel-prices/data.json',
  'Ascona': 'https://fuelprices.asconagroup.co.uk/newfuel.json',
  'BP': 'https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json',
  'Esso/Tesco Alliance': 'https://fuelprices.esso.co.uk/latestdata.json',
  'JET': 'https://jetlocal.co.uk/fuel_prices_data.json',
  'Morrisons': 'https://www.morrisons.com/fuel-prices/fuel.json',
  'Moto': 'https://moto-way.com/fuel-price/fuel_prices.json',
  'Motor Fuel Group': 'https://fuel.motorfuelgroup.com/fuel_prices_data.json',
  'Rontec': 'https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json',
  "Sainsbury's": 'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json',
  'SGN': 'https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json',
  'Shell': 'https://www.shell.co.uk/fuel-prices-data.html',
  'Tesco': 'https://www.tesco.com/fuel_prices/fuel_prices_data.json',
};
function parseStamp(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  const t = Date.parse(s); return isNaN(t) ? NaN : t;
}
async function retailerFeeds() {
  const seen = new Set(), rows = [];
  const res = await Promise.all(Object.entries(FEEDS).map(async ([name, url]) => {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json,*/*' } }); if (!r.ok) return { name, error: 'HTTP ' + r.status }; return { name, j: JSON.parse((await r.text()).replace(/^\uFEFF/, '')) }; }
    catch (e) { return { name, error: String(e.name === 'AbortError' ? 'timeout' : e.message) }; } finally { clearTimeout(timer); }
  }));
  for (const { name, j, error } of res) {
    if (error) { console.log(name.padEnd(20), 'FAILED', error); continue; }
    const list = Array.isArray(j) ? j : (j.stations || []);
    const stamp = parseStamp(j.last_updated);
    if (!isNaN(stamp) && (Date.now() - stamp) / 864e5 > 6) { console.log(name.padEnd(20), 'STALE, skipped'); continue; }
    let kept = 0;
    for (const s of list) {
      const la = num(s.location && s.location.latitude), lo = num(s.location && s.location.longitude);
      if (!inUK(la, lo)) continue;
      const p = s.prices || {}, e10 = pence(p.E10), e5 = pence(p.E5), b7 = pence(p.B7);
      if (e10 == null && e5 == null && b7 == null) continue;
      const key = la.toFixed(4) + ',' + lo.toFixed(4); if (seen.has(key)) continue; seen.add(key);
      rows.push([String(s.brand || name).trim().slice(0, 24), String(s.postcode || '').trim().slice(0, 9), +la.toFixed(5), +lo.toFixed(5), e10, e5, b7]); kept++;
    }
    console.log(name.padEnd(20), 'ok', String(kept).padStart(5), 'stations');
  }
  return rows;
}

// ---------------- main ----------------
let rows = [], source = '';
try { rows = await fuelFinder(); source = 'fuel-finder'; }
catch (e) { console.log('Fuel Finder failed:', e.message, e.body || ''); }
if (rows.length < MIN_OK) {
  if (rows.length) console.log('Fuel Finder returned too few stations; trying the retailer feeds as well.');
  console.log('Falling back to the retailer feeds.');
  const fb = await retailerFeeds();
  if (fb.length > rows.length) { rows = fb; source = 'retailer-feeds'; }
}
console.log('total stations:', rows.length, '| source:', source || 'none');
if (rows.length < Math.min(200, MIN_OK)) { console.log('Too few stations; not writing fuel.json.'); process.exit(1); }
writeFileSync('fuel.json', JSON.stringify({
  updated: new Date().toISOString(), source,
  note: 'Pence per litre. Rows: [brand, postcode, lat, lon, E10, E5, B7]. ' + (source === 'fuel-finder' ? 'Contains public sector information licensed under the Open Government Licence v3.0 (GOV.UK Fuel Finder).' : 'Retailer open-data feeds (CMA road fuel scheme).'),
  stations: rows,
}));
console.log('fuel.json written,', rows.length, 'stations');
