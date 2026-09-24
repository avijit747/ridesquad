// Best-effort road speed limit lookup via OpenStreetMap's public Overpass API.
// This is genuinely "best effort": OSM speed-limit tagging is sparse in many regions
// (India especially), the public Overpass instance is a shared free resource with a
// fair-use expectation (hence the long poll interval callers should use), and this
// can simply fail or return nothing. Always treat a null result as "no data", never
// as "no limit" — and never as a substitute for actual road signage.
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export async function fetchRoadSpeedLimit(lat, lng) {
  const query = `[out:json][timeout:8];way(around:25,${lat},${lng})[highway][maxspeed];out tags 5;`;
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const el of data.elements || []) {
      const raw = el.tags?.maxspeed;
      if (!raw) continue;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0 && n < 300) return n;
    }
    return null;
  } catch {
    return null;
  }
}
