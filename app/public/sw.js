// Yes Chef! service worker — the shell installs; data stays fresh.
// Strategy: cache-first for the versioned static shell; network-first with cache
// fallback for GET /api reads (offline = last-known kitchen, mutations need network —
// the app's deferred-post queue + error toasts already handle flaky posts honestly).
const VERSION = "yc-v4"; // BUMP on ANY shell change (html/css/js/fonts) or clients keep the old build
const SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/fonts/manrope-var.woff2",
  "/fonts/inter-var.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-512-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // mutations & cross-origin: straight through

  if (url.pathname.startsWith("/api/")) {
    // Network-first: fresh kitchen data when online, last-known GOOD when not —
    // only 2xx responses are cached, so a transient 500 can never become the
    // offline "last-known kitchen".
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Any navigation (/, /index.html, /?source=pwa …) resolves to the cached shell,
  // so offline launches survive URL variants.
  if (e.request.mode === "navigate") {
    e.respondWith(caches.match("/").then((hit) => hit || fetch(e.request)));
    return;
  }

  // Static shell: cache-first (bump VERSION to ship updates).
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
