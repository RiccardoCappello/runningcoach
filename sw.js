// Offline: the app's files and Python (from the CDN) are kept in the cache. The CDN files are
// versioned and never change -> cache first. The app's own files -> the network if it answers
// within 3 s (a new version arrives at once), else the cached copy (offline, weak signal).
const VERSION = "8029238921";
const CACHE = "coach-phone-" + VERSION;
const CDN = "https://cdn.jsdelivr.net/pyodide/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "index.html", "shell.js?v=" + VERSION,
    "static/style.css?v=" + VERSION, "static/icon.svg", "manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, "coach-phone-cdn"]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.url.startsWith(CDN)) {
    e.respondWith(caches.open("coach-phone-cdn").then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  } else if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const key = url.pathname.endsWith("/") ? new Request(url.origin + url.pathname) : req;
      const net = fetch(req, { cache: "no-cache" }).then((res) => { if (res.ok) c.put(key, res.clone()); return res; });
      const late = new Promise((ok) => setTimeout(ok, 3000));
      const first = await Promise.race([net.catch(() => null), late]);
      if (first) return first;
      const hit = await c.match(key, { ignoreSearch: url.pathname.endsWith("version.txt") });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }));
  }
});
