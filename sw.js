// オフライン用：アプリ本体はキャッシュ優先、データは通信優先、画像は一度見たらキャッシュ
const V = "scb-v1";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith(".json")) {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); }
    return r;
  })));
});
