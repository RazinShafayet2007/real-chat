/* real-chat offline shell: cache the app shell + static assets,
   never cache API or realtime traffic. */
const CACHE = "real-chat-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Realtime + API: always live, never cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/")
  ) {
    return;
  }

  // Static assets: cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    /\.(png|svg|ico|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return res;
          })
      )
    );
    return;
  }

  // Navigations: network-first, cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
  }
});
