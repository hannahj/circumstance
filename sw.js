// minimal shell cache so the sampler opens offline; network-first so updates land
const CACHE = "circumstance-v10";
const SHELL = ["./", "index.html", "styles.css", "app.js", "sun.js", "weather.js", "classify.js", "classify-wc.js", "wc/index.json", "db.js", "media.js", "share.js", "telemetry.js", "backup.js", "board-export.js", "manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    // no-cache: revalidate with the server (ETag 304s are cheap) so deploys land immediately
    fetch(e.request, { cache: "no-cache" }).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
