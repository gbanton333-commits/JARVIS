// Fetches UK Fuel Finder prices and writes a small fuel.json for JARVIS.
// Runs in GitHub Actions. Needs secrets FUEL_CLIENT_ID and FUEL_CLIENT_SECRET.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const BASE = process.env.FUEL_BASE || 'https://www.fuel-finder.service.gov.uk/api/v1';
const ID = (process.env.FUEL_CLIENT_ID || '').trim(), SECRET = (process.env.FUEL_CLIENT_SECRET || '').trim();
console.log('credential lengths:', ID.length, SECRET.length);
if (!ID || !SECRET) { console.log('No Fuel Finder credentials set; skipping.'); process.exit(0); }

const PLACES = { home: { lat: 50.886, lon: -1.245 }, work: { lat: 51.357, lon: -1.148 } };
const RADIUS_KM = 15;
const FUEL = /^E10$/i; // standard unleaded

const find = (o, key) => {
  if (!o || typeof o !== 'object') return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) { const r = find(v, key); if (r !== undefined) return r; }
};
const num = v => (v == null || v === '' ? NaN : +v);
const idOf = s => s.node_id ?? s.nodeId ?? s.id ?? s.site_id ?? s.forecourt_id;
const latOf = s => num(s.latitude ?? s.lat ?? find(s, 'latitude'));
const lonOf = s => num(s.longitude ?? s.lon ?? s.lng ?? find(s, 'longitude'));
const nameOf = s => String(s.trading_name ?? s.tradingName ?? s.name ?? s.brand_name ?? 'station').trim();

async function token() {
  const attempts = [
    { type: 'application/json', body: JSON.stringify({ client_id: ID, client_secret: SECRET }) },
    { type: 'application/x-www-form-urlencoded', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }).toString() },
  ];
  for (const a of attempts) {
    const r = await fetch(BASE + '/oauth/generate_access_token', {
      method: 'POST',
      headers: { 'content-type': a.type, accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; JARVIS-personal/1.0)' },
      body: a.body,
    });
    const raw = await r.text();
    let j = {};
    try { j = JSON.parse(raw); } catch {}
    const t = find(j, 'access_token');
    if (r.ok && t) return t;
    console.log('Auth attempt failed:', a.type, 'status', r.status, 'server', r.headers.get('server'), 'content-type', r.headers.get('content-type'), 'body', raw.slice(0, 300).replace(/\s+/g, ' '));
  }
  process.exit(1);
}

async function batches(path, tok) {
  const out = [];
  for (let n = 1; n <= 80; n++) {
    const r = await fetch(`${BASE}${path}?batch-number=${n}`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/json' } });
    if (r.status === 404) break;
    if (!r.ok) { console.log(path, 'batch', n, 'status', r.status); if (n === 1) process.exit(1); break; }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : (Object.values(j).find(Array.isArray) || []));
    if (!arr.length) break;
    if (n === 1) console.log(path, 'record keys:', Object.keys(arr[0]), 'sample:', JSON.stringify(arr[0]).slice(0, 500));
    out.push(...arr);
    if (arr.length < 500) break;
  }
  console.log(path, 'records:', out.length);
  return out;
}

function* priceRows(p) {
  const id = idOf(p);
  const list = p.fuel_prices ?? p.fuelPrices ?? p.prices;
  if (Array.isArray(list)) for (const f of list) yield { id, type: f.fuel_type ?? f.fuelType ?? f.type, price: num(f.price) };
  else yield { id, type: p.fuel_type ?? p.fuelType ?? p.type, price: num(p.price) };
}

const km = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const tok = await token();
const stations = await batches('/pfs', tok);
const prices = await batches('/pfs/fuel-prices', tok);

const byId = new Map();
for (const s of stations) byId.set(String(idOf(s)), { name: nameOf(s), lat: latOf(s), lon: lonOf(s) });

const petrol = new Map(); // id -> price
for (const p of prices) for (const row of priceRows(p))
  if (FUEL.test(String(row.type)) && row.price >= 100 && row.price <= 300) petrol.set(String(row.id), row.price);
console.log('E10 prices found:', petrol.size);

const result = {};
for (const [key, pt] of Object.entries(PLACES)) {
  const near = [];
  for (const [id, price] of petrol) {
    const s = byId.get(id);
    if (!s || isNaN(s.lat) || isNaN(s.lon)) continue;
    if (km(pt, s) <= RADIUS_KM) near.push({ price, name: s.name });
  }
  if (!near.length) { console.log('No stations near', key); continue; }
  near.sort((a, b) => a.price - b.price);
  const avg = near.reduce((t, x) => t + x.price, 0) / near.length;
  result[key] = { avg: +avg.toFixed(1), min: near[0].price, minName: near[0].name, count: near.length };
  console.log(key, result[key]);
}
if (!result.home) { console.log('No home result; leaving fuel.json unchanged.'); process.exit(1); }

// compact list of stations within 25 km of home or work, so the app can find the nearest ones to wherever you are
const stationsOut = [];
for (const [id, price] of petrol) {
  const s = byId.get(id);
  if (!s || isNaN(s.lat) || isNaN(s.lon)) continue;
  if (km(PLACES.home, s) <= 25 || km(PLACES.work, s) <= 25)
    stationsOut.push({ n: s.name, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), p: price });
}
stationsOut.sort((a, b) => a.p - b.p);
console.log('stations saved:', stationsOut.length);

let prev = {};
if (existsSync('fuel.json')) { try { prev = JSON.parse(readFileSync('fuel.json', 'utf8')); } catch {} }
const same = JSON.stringify(prev.home) === JSON.stringify(result.home) && JSON.stringify(prev.work) === JSON.stringify(result.work) && JSON.stringify(prev.stations) === JSON.stringify(stationsOut);
const fresh = prev.updated && Date.now() - Date.parse(prev.updated) < 12 * 3600e3;
if (same && fresh) { console.log('No change; not rewriting.'); process.exit(0); }

writeFileSync('fuel.json', JSON.stringify({ updated: new Date().toISOString(), fuel: 'E10', source: 'UK Fuel Finder (OGL v3.0)', ...result, stations: stationsOut }, null, 2));
console.log('fuel.json written');
