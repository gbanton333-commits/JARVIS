# JARVIS PWA — v0.1 foundation + live destination weather

This is a first incremental upgrade of the existing JARVIS PWA. It keeps the dark/cyan interface and existing voice/chat experience, adds a live destination-weather panel, and hardens basic Worker request handling.

## Files
- `index.html` — PWA interface, voice/chat, live destination weather lookup.
- `worker.js` — Cloudflare Worker backend. Deploy this file's contents as the Worker entry point.
- `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png` — installable PWA shell.

## Cloudflare Worker setup
Set these Worker variables/secrets:
- `ALLOWED_ORIGIN` (variable): exact GitHub Pages origin, e.g. `https://gbanton333-commits.github.io` (origin only; no repository path or trailing slash).
- `ANTHROPIC_API_KEY` (secret): your Anthropic API key. Never put it in GitHub Pages or this ZIP.
- `ANTHROPIC_MODEL` (optional variable): defaults to `claude-sonnet-4-6`; set to a model available to your account if you choose to change it.

Deploy `worker.js`, then open the PWA and use **Set up** to enter the Worker URL.

## What works in this increment
- Existing AI chat and browser speech features remain.
- Destination lookup uses Open-Meteo geocoding and forecast endpoints. No Open-Meteo API key is needed for this non-commercial prototype; follow Open-Meteo terms and attribution requirements.
- Weather card shows current conditions, apparent temperature, wind/gusts, precipitation and today's forecast, with a retrieval timestamp and source attribution.
- Worker validates request shape and limits message lengths/count, handles invalid JSON and upstream timeouts, and does not expose the Anthropic secret to the browser.
- Service worker updates its cache version and avoids caching cross-origin API requests.

## Important limitations before public use
- Weather is for the destination only, not yet a route-corridor or arrival-time forecast.
- Fuel Finder, traffic, roadworks and news are not connected yet. The app must not claim otherwise.
- `ALLOWED_ORIGIN` / CORS is not authentication: non-browser clients can forge an Origin header. Before public use, add rate limiting (e.g. Cloudflare rate limiting or a Durable Object), abuse monitoring, and spend alerts. Consider a private access mechanism if the Worker should only be used by you.
- No automatic route calculation or fuel station ranking yet. Fuel Finder integration requires confirming the current API access/authentication requirements and handling its terms correctly.

## Local sanity checks
Run `node --check worker.js` and inspect `index.html` in a browser. Test a valid town, an unknown town, missing Worker URL, unavailable weather service and a normal chat request before replacing the live deployment.
