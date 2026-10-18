// Offline support: keeps the app's files on this computer after the first visit.
const VERSION = "__BUILD__";
const CACHE = `pdf-markup-${VERSION}`;
const CORE = [
  "./", "index.html", "styles.css", "app.js", "platform.js", "pdfcore.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
  "vendor/pdfjs/build/pdf.min.mjs", "vendor/pdfjs/build/pdf.worker.min.mjs",
  "vendor/mupdf/mupdf.js", "vendor/mupdf/mupdf-wasm.js", "vendor/mupdf/mupdf-wasm.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()); // fonts and character maps are cached as they're used
      return res;
    } catch {
      return (await cache.match("index.html")) || Response.error();
    }
  })());
});
