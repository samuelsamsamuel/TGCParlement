/* Hémicycle : service de travail de l'application installable.
   Réseau d'abord pour tout le site (le cache HTTP du navigateur évite de retélécharger ce qui n'a pas changé),
   copie locale seulement hors connexion. L'API (/api/) n'est jamais mise en cache. */
const CACHE = "hemicycle-1";
const ESSENTIEL = ["./", "index.html", "regles.js", "jeu.json", "manifest.webmanifest", "icone-192.png", "icone-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESSENTIEL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copie = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
