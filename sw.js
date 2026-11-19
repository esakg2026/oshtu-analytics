// Офлайн: страница открывается из кэша, данные — из localStorage приложения.
const CACHE = "oa-shell-v5";
const SHELL = ["./", "index.html", "style.css", "config.js", "auth.js", "i18n.js", "cam-i18n.js", "engine.js", "app.js", "cameras.html", "cameras.css", "cameras.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/sb/")) return;
  // переходы: «/» → index.html, остальные страницы (cameras.html) — по своему имени
  const page = url.pathname.endsWith("/") ? "index.html" : url.pathname.split("/").pop();
  const key = req.mode === "navigate" ? page : req;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res.ok && res.type === "basic") c.put(key, res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response("Офлайн", { status: 503 });
    }),
  );
});
