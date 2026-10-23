// JARVIS Cloudflare Worker — keep ANTHROPIC_API_KEY as a Worker secret.
// Required vars: ALLOWED_ORIGIN. Optional vars: ANTHROPIC_MODEL.
const json = (body, status, cors) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').trim();
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (!allowed || origin !== allowed) return json({ error: 'Origin not allowed.' }, 403, cors);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
    const length = Number(req.headers.get('Content-Length') || 0);
    if (length > 24_000) return json({ error: 'Request too large.' }, 413, cors);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON.' }, 400, cors); }

    // First live-data capability: destination weather from Open-Meteo (no API key).
    if (body.action === 'weather') {
      const place = typeof body.place === 'string' ? body.place.trim().slice(0, 120) : '';
      if (!place) return json({ error: 'Enter a destination or town.' }, 400, cors);
      try {
        const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
        geoUrl.search = new URLSearchParams({ name: place, count: '1', language: 'en', format: 'json' });
        const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(7000) });
        if (!geoRes.ok) throw new Error('Geocoding service unavailable');
        const geo = await geoRes.json();
        const loc = geo.results?.[0];
        if (!loc) return json({ error: `I couldn't find a location matching “${place}”. Try a town or postcode.` }, 404, cors);
        const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
        forecastUrl.search = new URLSearchParams({
          latitude: String(loc.latitude), longitude: String(loc.longitude),
          current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,wind_speed_10m,wind_gusts_10m',
          hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
          forecast_days: '2', timezone: 'auto'
        });
        const wxRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(9000) });
        if (!wxRes.ok) throw new Error('Weather service unavailable');
        const wx = await wxRes.json();
        return json({ action: 'weather', place: `${loc.name}${loc.admin1 ? ', ' + loc.admin1 : ''}`, country: loc.country, latitude: loc.latitude, longitude: loc.longitude, timezone: wx.timezone, current: wx.current, daily: wx.daily, hourly: wx.hourly, retrievedAt: new Date().toISOString(), source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/' }, 200, cors);
      } catch (e) {
        return json({ error: e.name === 'TimeoutError' ? 'The weather lookup timed out. Please try again.' : 'Live weather is temporarily unavailable. Please try again shortly.' }, 502, cors);
      }
    }

    if (!env.ANTHROPIC_API_KEY) return json({ error: 'The AI key is not configured on the Worker.' }, 503, cors);
    const system = typeof body.system === 'string' ? body.system.slice(0, 6000) : '';
    const messages = body.messages;
    if (!system || !Array.isArray(messages) || messages.length < 1 || messages.length > 12) return json({ error: 'Invalid chat request.' }, 400, cors);
    const safeMessages = [];
    for (const m of messages) {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 3000) return json({ error: 'Invalid message format.' }, 400, cors);
      safeMessages.push({ role: m.role, content: m.content });
    }
    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(25000),
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 400, system, messages: safeMessages })
      });
      const raw = await upstream.text();
      return new Response(raw, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return json({ error: e.name === 'TimeoutError' ? 'The AI request timed out.' : 'Could not reach the AI service.' }, 502, cors);
    }
  }
};
