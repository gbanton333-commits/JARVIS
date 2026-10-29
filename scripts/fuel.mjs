// Collects UK petrol/diesel prices from the retailers' own open-data feeds (CMA road fuel scheme)
// and writes one compact fuel.json. No keys or logins needed. Runs in GitHub Actions.
import { writeFileSync } from 'node:fs';

const FEEDS = {
  // official list: https://www.gov.uk/guidance/access-fuel-price-data
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
  // Asda is left out on purpose: its robots.txt asks automated tools not to fetch the feed path.
};
if (process.env.FUEL_FEEDS) Object.assign(FEEDS, JSON.parse(process.env.FUEL_FEEDS)); // for testing
const MAX_AGE_DAYS = 6;          // ignore feeds that have not been updated for this long
const num = v => (v == null || v === '' ? NaN : +String(v).replace(/[^\d.\-]/g, ''));
const inUK = (la, lo) => la > 49.8 && la < 60.95 && lo > -8.7 && lo < 1.9;

function parseStamp(s) {
  if (!s) return NaN;
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})/);   // dd/mm/yyyy hh:mm:ss
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  const t = Date.parse(s);
  return isNaN(t) ? NaN : t;
}
const pick = (p, ...keys) => { for (const k of keys) { const v = num(p && p[k]); if (v >= 100 && v <= 300) return +v.toFixed(1); } return null; };

async function getFeed(name, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'JARVIS-personal-fuel-finder/1.0 (+personal use, runs every few hours)', accept: 'application/json,*/*' } });
    if (!r.ok) return { name, error: 'HTTP ' + r.status };
    const text = await r.text();
    let j; try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { name, error: 'not JSON' }; }
    return { name, j };
  } catch (e) { return { name, error: String(e.name === 'AbortError' ? 'timeout' : e.message || e) }; }
  finally { clearTimeout(timer); }
}

const seen = new Set(), stations = [], report = {};
const results = await Promise.all(Object.entries(FEEDS).map(([n, u]) => getFeed(n, u)));
for (const { name, j, error } of results) {
  if (error) { report[name] = { error }; console.log(name.padEnd(20), 'FAILED', error); continue; }
  const list = Array.isArray(j) ? j : (j.stations || j.sites || []);
  const stamp = parseStamp(j.last_updated || j.lastUpdated || j.last_updated_time);
  const ageDays = isNaN(stamp) ? null : (Date.now() - stamp) / 864e5;
  if (ageDays != null && ageDays > MAX_AGE_DAYS) { report[name] = { stale: Math.round(ageDays) + 'd', stations: list.length }; console.log(name.padEnd(20), 'STALE', Math.round(ageDays) + ' days, skipped'); continue; }
  let kept = 0;
  for (const s of list) {
    const la = num(s.location && s.location.latitude), lo = num(s.location && s.location.longitude);
    if (!inUK(la, lo)) continue;
    const p = s.prices || {};
    const e10 = pick(p, 'E10', 'e10'), e5 = pick(p, 'E5', 'e5'), b7 = pick(p, 'B7', 'b7');
    if (e10 == null && e5 == null && b7 == null) continue;
    const key = la.toFixed(4) + ',' + lo.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    stations.push([String(s.brand || name).trim().slice(0, 24), String(s.postcode || '').trim().slice(0, 9), +la.toFixed(5), +lo.toFixed(5), e10, e5, b7]);
    kept++;
  }
  report[name] = { stations: kept, updated: isNaN(stamp) ? null : new Date(stamp).toISOString().slice(0, 16) };
  console.log(name.padEnd(20), 'ok', String(kept).padStart(5), 'stations');
}
console.log('total stations:', stations.length);
if (stations.length < 200) { console.log('Too few stations collected; not writing fuel.json.'); process.exit(1); }

writeFileSync('fuel.json', JSON.stringify({
  updated: new Date().toISOString(),
  note: 'Pence per litre. Station rows: [brand, postcode, lat, lon, E10, E5, B7]. Source: retailer open-data feeds under the CMA road fuel scheme.',
  feeds: report,
  stations,
}));
console.log('fuel.json written,', stations.length, 'stations');
