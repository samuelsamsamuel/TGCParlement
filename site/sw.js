/* Hémicycle : service de travail de l'application installable.
   Réseau d'abord pour tout le site (le cache HTTP du navigateur évite de retélécharger ce qui n'a pas changé),
   copie locale seulement hors connexion. L'API (/api/) n'est jamais mise en cache. */
const CACHE = "hemicycle-6";
const ESSENTIEL = ["./", "index.html", "regles.js", "jeu.json", "manifest.webmanifest", "icone-192.png", "icone-512.png", "icone-maskable-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESSENTIEL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(cles => Promise.all(cles.filter(k => k !== CACHE && k !== PORTRAITS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Portraits lus en mode CORS (Wikimedia, Sénat) : gardés en cache, servis aussitôt aux visites suivantes ;
// 800 au plus, les plus anciens retirés d'abord
const PORTRAITS = "hemicycle-portraits", MAX_PORTRAITS = 800;
const HOTES_PORTRAITS = ["upload.wikimedia.org", "commons.wikimedia.org", "thumb.wikimedia.org", "www.senat.fr"];
async function portrait(requete) {
  const cache = await caches.open(PORTRAITS);
  const garde = await cache.match(requete);
  if (garde) return garde;
  const r = await fetch(requete);
  if (r.ok && r.type === "cors") {
    await cache.put(requete, r.clone());
    const cles = await cache.keys();
    for (const k of cles.slice(0, Math.max(0, cles.length - MAX_PORTRAITS))) await cache.delete(k);
  }
  return r;
}
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && e.request.mode === "cors" && HOTES_PORTRAITS.includes(url.hostname) && e.request.destination === "image") {
    e.respondWith(portrait(e.request)); return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copie = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
// Notifications : la poussée arrive sans contenu ; les messages en attente sont lus sur le serveur (session du
// joueur) puis affichés. Toucher une notification ouvre l'application.
self.addEventListener("push", e => {
  // Page de l'application ouverte : prévenue aussitôt (défi, coup d'un ami, échange…), sans attendre sa relecture
  self.clients.matchAll({type: "window"}).then(fs => fs.forEach(f => f.postMessage({signal: true})));
  e.waitUntil(fetch("/api/notifications", {credentials: "same-origin"}).then(r => r.ok ? r.json() : {notifications: []})
    .catch(() => ({notifications: []}))
    .then(d => {
      const liste = d.notifications.length ? d.notifications : [{texte: "Du nouveau vous attend dans l'hémicycle."}];
      return Promise.all(liste.slice(-3).map((n, i) => self.registration.showNotification("Hémicycle", {
        body: n.texte, icon: "icone-192.png", badge: "icone-192.png", tag: "hemicycle-" + Date.now() + "-" + i, data: {lien: n.lien || null}})));
    }));
});
// Une notification qui porte un lien (« partie:12 ») ouvre ce qu'elle annonce : la page déjà ouverte reçoit le lien et
// l'affiche, sinon l'application s'ouvre avec ?ouvrir=… (lu au chargement)
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const lien = e.notification.data && e.notification.data.lien;
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(fenetres => {
    const f = fenetres.find(x => new URL(x.url).origin === location.origin);
    if (f) { if (lien) f.postMessage({ouvrir: lien}); return f.focus(); }
    return self.clients.openWindow(lien ? "./?ouvrir=" + encodeURIComponent(lien) : "./");
  }));
});
