/* Hémicycle : règles du jeu, sans interface ni stockage.

Chaque action du joueur est une opération nommée qui reçoit l'état et le catalogue, vérifie qu'elle est
permise, modifie l'état et renvoie son résultat : ouvrirPaquet, recycler, echangerPoints, reclamer.
L'interface (index.html) n'écrit jamais l'état elle-même. Ce découpage prépare le passage à des comptes :
un serveur pourra reprendre ce fichier tel quel (il s'exécute aussi sous Node) et devenir seul juge des
tirages et des récompenses, l'interface se contentant alors d'appeler ces mêmes opérations à distance.

État (version 2) :
  possedees  { id de carte: nombre d'exemplaires }
  jour       date du dernier paquet du jour ouvert (AAAA-M-J, heure locale)
  ouverts    paquets du jour déjà ouverts ce jour-là
  points     points de recyclage non encore échangés
  offerts    paquets gagnés (objectifs, échanges de points), sans limite de jour
  objectifs  { "identifiant@seuil" ou "identifiant@complet": date de la réclamation }
  journal    dernières opérations [date, opération, détail], pour le suivi et une future reprise côté serveur
*/
(function (racine, fabrique) {
  const Regles = fabrique();
  if (typeof module === "object" && module.exports) module.exports = Regles;
  else racine.Regles = Regles;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION_ETAT = 2;
  const PAQUETS_PAR_JOUR = 3, CARTES_PAR_PAQUET = 5;
  const ORDRE = ["commune", "peu-commune", "rare", "epique", "hors-categorie", "legendaire", "mythique"];
  // Probabilité de chaque rareté pour une carte tirée : les plus hautes restent rares, quel que soit leur nombre
  const POIDS = {"mythique": 0.4, "legendaire": 1.6, "epique": 6, "rare": 15, "peu-commune": 30, "commune": 46, "hors-categorie": 1};
  // Recyclage : points rendus par exemplaire en trop, à peu près inverses de la fréquence de tirage.
  // Un paquet de doubles recyclé rapporte en moyenne 21 points, pour un paquet à 25 : recycler ne rend jamais
  // plus de paquets qu'il n'en consomme, sans quoi les doubles d'une collection avancée tourneraient sans fin.
  const VALEUR_RECYCLAGE = {"commune": 1, "peu-commune": 2, "rare": 5, "epique": 15, "hors-categorie": 40, "legendaire": 40, "mythique": 100};
  const PRIX_PAQUET = 25;
  const JOURNAL_MAX = 200;

  /* ---------- État ---------- */
  function etatVide() {
    return {version: VERSION_ETAT, possedees: {}, jour: "", ouverts: 0, points: 0, offerts: 0, objectifs: {}, journal: []};
  }
  function entier(v) { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? v : 0; }
  // Accepte l'état de la première version (possedees, jour, ouverts) et tout état abîmé
  function migrer(brut) {
    const e = etatVide();
    if (!brut || typeof brut !== "object" || !brut.possedees || typeof brut.possedees !== "object") return e;
    for (const [id, n] of Object.entries(brut.possedees)) if (entier(n)) e.possedees[id] = entier(n);
    e.jour = typeof brut.jour === "string" ? brut.jour : "";
    e.ouverts = entier(brut.ouverts);
    e.points = entier(brut.points);
    e.offerts = entier(brut.offerts);
    if (brut.objectifs && typeof brut.objectifs === "object") Object.assign(e.objectifs, brut.objectifs);
    if (Array.isArray(brut.journal)) e.journal = brut.journal.slice(-JOURNAL_MAX);
    return e;
  }
  function noter(etat, operation, detail) {
    etat.journal.push([new Date().toISOString(), operation, detail]);
    if (etat.journal.length > JOURNAL_MAX) etat.journal.splice(0, etat.journal.length - JOURNAL_MAX);
  }
  function jourLocal(d = new Date()) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  /* ---------- Catalogue ---------- */
  function normer(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-/g, " ").trim(); }
  // cartes : objets lus dans jeu.json (id, rarete, actuel, distinctions, mandats, assemblees) ; assemblees : table de jeu.json
  function catalogue(cartes, assemblees = []) {
    const parRarete = {}, actuelsParRarete = {}, parId = {};
    for (const c of cartes) {
      parId[c.id] = c;
      (parRarete[c.rarete] ||= []).push(c);
      if (c.actuel) (actuelsParRarete[c.rarete] ||= []).push(c);
    }
    const cat = {cartes, parRarete, actuelsParRarete: Object.keys(actuelsParRarete).length ? actuelsParRarete : parRarete, parId, assemblees};
    cat.objectifs = definirObjectifs(cat);
    cat.objectifParId = Object.fromEntries(cat.objectifs.map(o => [o.id, o]));
    return cat;
  }

  /* ---------- Paquets ---------- */
  function paquetsDisponibles(etat, jour = jourLocal()) {
    const duJour = etat.jour === jour ? Math.max(0, PAQUETS_PAR_JOUR - etat.ouverts) : PAQUETS_PAR_JOUR;
    return {duJour, offerts: etat.offerts, echangeables: Math.floor(etat.points / PRIX_PAQUET), total: duJour + etat.offerts};
  }
  function tirerRarete(pool, aleatoire) {
    // Probabilités ramenées aux seules raretés présentes dans le vivier : une rareté absente
    // (aucun élu en exercice « commun », par exemple) ne reporte jamais sa part sur les plus hautes
    const dispo = Object.entries(POIDS).filter(([r]) => pool[r] && pool[r].length);
    let x = aleatoire() * dispo.reduce((a, [, p]) => a + p, 0);
    for (const [r, p] of dispo) if ((x -= p) < 0) return r;
    return dispo[dispo.length - 1][0];
  }
  function tirerCarte(pool, aleatoire) { const l = pool[tirerRarete(pool, aleatoire)]; return l[Math.floor(aleatoire() * l.length)]; }
  // Consomme un paquet du jour s'il en reste, sinon un paquet offert. Renvoie null si aucun n'est disponible.
  function ouvrirPaquet(etat, cat, {jour = jourLocal(), aleatoire = Math.random} = {}) {
    const dispo = paquetsDisponibles(etat, jour);
    if (dispo.total <= 0) return null;
    let origine;
    if (dispo.duJour > 0) {
      if (etat.jour !== jour) { etat.jour = jour; etat.ouverts = 0; }
      etat.ouverts += 1; origine = "jour";
    } else { etat.offerts -= 1; origine = "offert"; }
    // Une carte au moins parmi les élus et ministres en exercice, les autres au hasard
    const tirage = [tirerCarte(cat.actuelsParRarete, aleatoire)]
      .concat(Array.from({length: CARTES_PAR_PAQUET - 1}, () => tirerCarte(cat.parRarete, aleatoire)))
      .sort((a, b) => ORDRE.indexOf(a.rarete) - ORDRE.indexOf(b.rarete) || a.score - b.score);
    const neuves = new Set(tirage.filter(c => !etat.possedees[c.id]).map(c => c.id));
    for (const c of tirage) etat.possedees[c.id] = (etat.possedees[c.id] || 0) + 1;
    noter(etat, "paquet", {origine, cartes: tirage.map(c => c.id)});
    return {tirage, neuves, origine};
  }

  /* ---------- Recyclage ---------- */
  // Exemplaires en trop (au-delà du premier), regroupés par rareté
  function doubles(etat, cat) {
    const parRarete = {};
    for (const [id, n] of Object.entries(etat.possedees)) {
      const c = cat.parId[id];
      if (!c || n < 2) continue;
      const r = parRarete[c.rarete] ||= {cartes: 0, exemplaires: 0, points: 0};
      r.cartes += 1; r.exemplaires += n - 1; r.points += (n - 1) * VALEUR_RECYCLAGE[c.rarete];
    }
    return parRarete;
  }
  // Recycle tous les exemplaires en trop des raretés choisies ; le premier exemplaire de chaque carte est gardé
  function recycler(etat, cat, raretes) {
    const choisies = new Set(raretes);
    let exemplaires = 0, points = 0;
    for (const [id, n] of Object.entries(etat.possedees)) {
      const c = cat.parId[id];
      if (!c || n < 2 || !choisies.has(c.rarete)) continue;
      exemplaires += n - 1; points += (n - 1) * VALEUR_RECYCLAGE[c.rarete];
      etat.possedees[id] = 1;
    }
    if (exemplaires) { etat.points += points; noter(etat, "recyclage", {raretes: [...choisies], exemplaires, points}); }
    return {exemplaires, points};
  }
  function echangerPoints(etat) {
    if (etat.points < PRIX_PAQUET) return false;
    etat.points -= PRIX_PAQUET; etat.offerts += 1;
    noter(etat, "echange", {points: PRIX_PAQUET});
    return true;
  }

  /* ---------- Objectifs ---------- */
  // Paliers [nombre de cartes, paquets offerts]. Les collections historiques sont faites surtout de cartes
  // épiques ou légendaires (une tous les quinze jours à trois semaines au rythme de trois paquets par jour) :
  // leurs premiers paliers sont bas. Les législatures et départements, faits surtout de cartes communes,
  // montent plus haut. Un palier au-delà de la taille de l'objectif est retiré ; la collection complète
  // donne toujours le dernier palier.
  const PALIERS = {
    historique: [[1, 1], [5, 2], [15, 3]],
    presidents: [[1, 1], [5, 2], [15, 3], [40, 4]],
    legislature: [[10, 1], [50, 2], [150, 3]],
    departement: [[5, 1], [15, 2], [40, 3]],
  };
  const COMPLETE = 5;  // paquets offerts pour une collection complète
  function paliers(famille, total) {
    const p = PALIERS[famille].filter(([s]) => s < total);
    p.push([total, Math.max(COMPLETE, (p.length ? p[p.length - 1][1] : 0) + 1)]);
    return p;
  }
  function objectif(id, famille, titre, ids, sousTitre = "") {
    return {id, famille, titre, sousTitre, ids, total: ids.length, paliers: paliers(famille, ids.length)};
  }
  function definirObjectifs(cat) {
    const avec = code => cat.cartes.filter(c => c.distinctions.includes(code)).map(c => c.id);
    const liste = [
      objectif("quatre-vingts", "historique", "Les Quatre-vingts", avec("quatre-vingts"), "Parlementaires qui refusèrent les pleins pouvoirs à Pétain le 10 juillet 1940"),
      objectif("compagnons", "historique", "Compagnons de la Libération", avec("compagnon-liberation"), "Parlementaires faits Compagnons de la Libération"),
      objectif("presidents-assemblee", "presidents", "Présidents de l'Assemblée",
        cat.cartes.filter(c => c.distinctions.includes("presidence-an-longue") || c.distinctions.includes("presidence-an-courte")).map(c => c.id),
        "Présidents de l'Assemblée et des chambres qui l'ont précédée"),
    ];
    // Une législature : cartes ayant siégé dans cette assemblée (index dans la table assemblees de jeu.json)
    const parAssemblee = cat.assemblees.map(() => []);
    for (const c of cat.cartes) for (const i of c.assemblees || []) if (parAssemblee[i]) parAssemblee[i].push(c.id);
    cat.assemblees.forEach(([cle, titre, annee], i) => {
      if (parAssemblee[i].length) liste.push(objectif("legislature:" + cle, "legislature", titre, parAssemblee[i], annee ? "Élue en " + annee : ""));
    });
    // Un département : cartes élues dans ce département (Assemblée ou Sénat), à partir de cinq cartes
    const deps = {};
    for (const c of cat.cartes) for (const m of c.mandats) {
      if (!m[1]) continue;
      const d = deps[normer(m[1])] ||= {titre: m[1], ids: new Set()};
      d.ids.add(c.id);
    }
    Object.entries(deps).filter(([, d]) => d.ids.size >= 5)
      .sort(([, a], [, b]) => a.titre.localeCompare(b.titre, "fr"))
      .forEach(([cle, d]) => liste.push(objectif("departement:" + cle, "departement", d.titre, [...d.ids])));
    return liste;
  }
  function avancement(etat, obj) {
    const obtenues = obj.ids.reduce((n, id) => n + (etat.possedees[id] ? 1 : 0), 0);
    // La collection complète a sa propre clé : si l'objectif grandit avec les données, elle ne se réclame qu'une fois
    const cle = seuil => obj.id + "@" + (seuil === obj.total ? "complet" : seuil);
    const etapes = obj.paliers.map(([seuil, paquets]) => ({seuil, paquets, cle: cle(seuil), atteint: obtenues >= seuil, reclame: !!etat.objectifs[cle(seuil)]}));
    return {obtenues, etapes, aReclamer: etapes.filter(e => e.atteint && !e.reclame), prochain: etapes.find(e => !e.atteint) || null};
  }
  // Réclame tous les paliers atteints et non encore réclamés d'un objectif ; renvoie le nombre de paquets offerts
  function reclamer(etat, cat, id) {
    const obj = cat.objectifParId[id];
    if (!obj) return 0;
    let paquets = 0;
    for (const e of avancement(etat, obj).aReclamer) {
      etat.objectifs[e.cle] = new Date().toISOString();
      paquets += e.paquets;
    }
    if (paquets) { etat.offerts += paquets; noter(etat, "objectif", {id, paquets}); }
    return paquets;
  }
  function recompensesEnAttente(etat, cat) {
    return cat.objectifs.reduce((n, o) => n + avancement(etat, o).aReclamer.reduce((a, e) => a + e.paquets, 0), 0);
  }

  return {VERSION_ETAT, PAQUETS_PAR_JOUR, CARTES_PAR_PAQUET, ORDRE, POIDS, VALEUR_RECYCLAGE, PRIX_PAQUET, PALIERS,
    etatVide, migrer, jourLocal, normer, catalogue, paquetsDisponibles, ouvrirPaquet, doubles, recycler, echangerPoints,
    avancement, reclamer, recompensesEnAttente};
});
