// Cloudflare Worker — Overpass proxy with mirror racing, a second round, and success caching.
// Paste into the Worker at dash.cloudflare.com and deploy. Not part of the static site.
const MIRRORS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function race(query, timeoutMs) {
  return Promise.any(MIRRORS.map(async (url) => {
    const host = new URL(url).hostname;
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Circumstance/0.1 (research prototype; contact: uglywalks@gmail.com)",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(host + ": HTTP " + res.status);
    return await res.text();
  }));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
    const query = await request.text();
    if (!query) return new Response("missing query", { status: 400, headers: CORS });

    // cache successful answers by query hash (map data changes slowly)
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    const cacheKey = new Request("https://" + new URL(request.url).hostname + "/q/" + hash);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, { headers: { "Content-Type": "application/json", "X-Cache": "hit", ...CORS } });
    }

    let body = null, errs = [];
    try { body = await race(query, 7000); }
    catch (e) { errs = errs.concat((e.errors || [e]).map(x => x.message || String(x))); }
    if (body === null) {
      await new Promise(r => setTimeout(r, 400)); // brief pause, then a second round
      try { body = await race(query, 6000); }
      catch (e) { errs = errs.concat((e.errors || [e]).map(x => x.message || String(x))); }
    }
    if (body === null)
      return new Response("all mirrors failed \u2014 " + errs.join("; "), { status: 502, headers: CORS });

    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=604800" },
    })));
    return new Response(body, { headers: { "Content-Type": "application/json", "X-Cache": "miss", ...CORS } });
  },
};
