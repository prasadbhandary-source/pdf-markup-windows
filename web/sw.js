// Offline support: keeps the app's files on this computer after the first visit.
const VERSION = "__BUILD__";
const CACHE = `pdf-markup-${VERSION}`;
const CORE = [
  "./", "index.html", "styles.css", "app.js", "platform.js", "pdfcore.js", "toword.js",
  "vendor/docx/index.mjs",
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

// App files: always try the network first so updates arrive straight away; the
// offline copy is the fallback. Large libraries (vendor/) come from the cache first.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const vendor = url.pathname.includes("/vendor/");
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (vendor) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      const res = await fetch(req, vendor ? undefined : { cache: "no-cache" });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await cache.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
