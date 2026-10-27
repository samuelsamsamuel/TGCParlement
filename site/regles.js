/* Hémicycle : règles du jeu, sans interface ni stockage.

Chaque action du joueur est une opération nommée qui reçoit l'état et le catalogue, vérifie qu'elle est
permise, modifie l'état et renvoie son résultat : ouvrirPaquet, recycler, echangerPoints, reclamer.
L'interface (index.html) n'écrit jamais l'état elle-même. Ce découpage prépare le passage à des comptes :
un serveur pourra reprendre ce fichier tel quel (il s'exécute aussi sous Node) et devenir seul juge des
tirages et des récompenses, l'interface se contentant alors d'appeler ces mêmes opérations à distance.

État (version 2) :
  possedees  { id de carte: nombre d'exemplaires }
  reserve    paquets en réserve à l'instant « ancre » ; un paquet s'y ajoute toutes les 30 minutes, jusqu'à dix
  ancre      instant (millisecondes) depuis lequel la réserve se recharge ; 0 : réserve pleine
  points     points de recyclage non encore échangés
  offerts    paquets gagnés (objectifs, échanges de points), sans limite de jour
  objectifs  { "identifiant@seuil" ou "identifiant@complet": date de la réclamation }
  journal    dernières opérations [date, opération, détail], pour le suivi
  quiz       jour (AAAA-MM-JJ, Paris) des dernières questions au Gouvernement récompensées
  favoris    cartes marquées d'une étoile (300 au plus)
  verrous    { id de carte: exemplaires bloqués } (compte seulement, fourni par le serveur) : exemplaires repris
             du navigateur à la création du compte et exemplaires en vente. Ils restent dans la collection et
             comptent pour les objectifs, mais ne se recyclent pas et ne se cèdent pas.
*/
(function (racine, fabrique) {
  const Regles = fabrique();
  if (typeof module === "object" && module.exports) module.exports = Regles;
  else racine.Regles = Regles;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION_ETAT = 3;
  // Rythme des paquets : un paquet toutes les 30 minutes, jusqu'à dix en réserve (décision de l'utilisateur, octobre
  // 2026, au lieu d'un par heure et huit ; un joueur qui passe matin, midi et soir en ouvre une trentaine par jour ;
  // un joueur absent ne perd que ce qui dépasse la réserve)
  const RECHARGE_MS = 30 * 60 * 1000, RESERVE_MAX = 10, CARTES_PAR_PAQUET = 5;
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
    return {version: VERSION_ETAT, possedees: {}, reserve: RESERVE_MAX, ancre: 0, points: 0, offerts: 0, objectifs: {}, quiz: "", favoris: [], journal: []};
  }
  function entier(v) { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? v : 0; }
  // Accepte les états des versions précédentes (paquets du jour : jour, ouverts) et tout état abîmé ; le passage
  // à la réserve horaire commence avec une réserve pleine
  function migrer(brut) {
    const e = etatVide();
    if (!brut || typeof brut !== "object" || !brut.possedees || typeof brut.possedees !== "object") return e;
    for (const [id, n] of Object.entries(brut.possedees)) if (entier(n)) e.possedees[id] = entier(n);
    if (Number.isFinite(Number(brut.ancre)) && brut.reserve !== undefined) {
      e.reserve = Math.min(RESERVE_MAX, entier(brut.reserve)); e.ancre = Math.max(0, Math.floor(Number(brut.ancre)));
    }
    e.points = entier(brut.points);
    e.quiz = typeof brut.quiz === "string" ? brut.quiz : "";
    if (Array.isArray(brut.favoris)) e.favoris = [...new Set(brut.favoris.map(String))].slice(0, 300);
    e.offerts = entier(brut.offerts);
    if (brut.objectifs && typeof brut.objectifs === "object") Object.assign(e.objectifs, brut.objectifs);
    if (Array.isArray(brut.journal)) e.journal = brut.journal.slice(-JOURNAL_MAX);
    if (brut.verrous && typeof brut.verrous === "object")
      for (const [id, n] of Object.entries(brut.verrous)) if (entier(n)) (e.verrous ||= {})[id] = entier(n);
    return e;
  }
  function noter(etat, operation, detail) {
    etat.journal.push([new Date().toISOString(), operation, detail]);
    if (etat.journal.length > JOURNAL_MAX) etat.journal.splice(0, etat.journal.length - JOURNAL_MAX);
  }
  // Jour du jeu : date de Paris, pour que le navigateur et le serveur changent de jour au même moment
  const FORMAT_JOUR = new Intl.DateTimeFormat("fr-CA", {timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"});
  function jourDuJeu(d = new Date()) { return FORMAT_JOUR.format(d); }

  /* ---------- Catalogue ---------- */
  function normer(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-/g, " ").trim(); }
  // cartes : objets lus dans jeu.json (id, rarete, actuel, distinctions, mandats, assemblees) ; assemblees : table de jeu.json.
  // objectifsDonnes : objectifs déjà calculés [id, famille, titre, sous-titre, ids] (catalogue du serveur)
  function catalogue(cartes, assemblees = [], objectifsDonnes = null) {
    const parRarete = {}, actuelsParRarete = {}, parId = {};
    for (const c of cartes) {
      parId[c.id] = c;
      (parRarete[c.rarete] ||= []).push(c);
      if (c.actuel) (actuelsParRarete[c.rarete] ||= []).push(c);
    }
    const cat = {cartes, parRarete, actuelsParRarete: Object.keys(actuelsParRarete).length ? actuelsParRarete : parRarete, parId, assemblees};
    cat.objectifs = objectifsDonnes ? objectifsDonnes.map(([id, famille, titre, sous, ids]) => objectif(id, famille, titre, ids, sous)) : definirObjectifs(cat);
    cat.objectifParId = Object.fromEntries(cat.objectifs.map(o => [o.id, o]));
    return cat;
  }

  // Cartes de jeu.json (tableaux compacts, voir scripts/export_jeu.py) en objets
  function cartesDeJeu(d) {
    return d.cartes.map(([id, nom, r, score, epoque, actuel, debut, fin, source, portrait, distinctions, chambres, sexe, fonctions, mandats, groupe, photo, assemblees]) => ({
      id, nom, rarete: d.raretes[r], score, epoque, actuel: !!actuel, debut, fin, source, portrait, distinctions: distinctions || [],
      chambres: chambres || "", sexe, fonctions: fonctions || [], mandats: mandats || [], groupe, photo, assemblees: assemblees || []}));
  }

  // Catalogue réduit pour le serveur (site/serveur.json) : seulement ce que les règles utilisent. Il est écrit
  // à partir du catalogue complet par scripts/catalogue_serveur.js : les objectifs sont donc calculés une seule
  // fois, par ce même fichier, et le serveur ne lit pas les 6 Mo de jeu.json.
  // Membres d'un objectif : index des cartes codés en plages contiguës [début, longueur, début, longueur...]
  // (« Remplir l'hémicycle » couvre toutes les cartes : une seule plage)
  function enPlages(indices) {
    const tries = [...indices].sort((a, b) => a - b), plages = [];
    for (const i of tries) {
      const n = plages.length;
      if (n && plages[n - 2] + plages[n - 1] === i) plages[n - 1] += 1; else plages.push(i, 1);
    }
    return plages;
  }
  function dePlages(plages, cartes) {
    const ids = [];
    for (let k = 0; k < plages.length; k += 2) for (let i = plages[k]; i < plages[k] + plages[k + 1]; i++) ids.push(cartes[i].id);
    return ids;
  }
  function compacter(cat) {
    const raretes = ORDRE.slice(), index = new Map(cat.cartes.map((c, i) => [c.id, i]));
    return {raretes, cartes: cat.cartes.map(c => [c.id, raretes.indexOf(c.rarete), c.actuel ? 1 : 0, c.score]),
      objectifs: cat.objectifs.map(o => [o.id, o.famille, o.titre, o.sousTitre, enPlages(o.ids.map(id => index.get(id)))])};
  }
  // Catalogue du serveur. Les membres d'un objectif ne sont décodés qu'à sa première évaluation (réclamation,
  // reprise d'une collection) : le serveur reste ainsi sous la limite de calcul d'une requête du plan gratuit.
  function catalogueCompact(data) {
    const cartes = data.cartes.map(([id, r, actuel, score]) => ({id, rarete: data.raretes[r], actuel: !!actuel, score}));
    const cat = catalogue(cartes, [], []);
    cat.indexDe = Object.fromEntries(cartes.map((c, i) => [c.id, i]));
    cat.objectifs = data.objectifs.map(([id, famille, titre, sous, plages]) => {
      let total = 0;
      for (let k = 1; k < plages.length; k += 2) total += plages[k];
      const o = {id, famille, titre, sousTitre: sous, total, paliers: paliers(famille, total), plages};
      let ids = null;
      Object.defineProperty(o, "ids", {enumerable: true, get: () => ids ||= dePlages(plages, cartes)});
      return o;
    });
    cat.objectifParId = Object.fromEntries(cat.objectifs.map(o => [o.id, o]));
    return cat;
  }

  /* ---------- Paquets ---------- */
  // Réserve à l'instant donné : la réserve de l'ancre plus un paquet par intervalle écoulé (RECHARGE_MS), plafonnée ;
  // prochain : instant du prochain paquet (null si la réserve est pleine)
  function reserveCourante(etat, maintenant = Date.now()) {
    const heures = Math.floor(Math.max(0, maintenant - (etat.ancre || 0)) / RECHARGE_MS);
    const n = Math.min(RESERVE_MAX, (etat.reserve || 0) + heures);
    return {n, heures, pleine: n >= RESERVE_MAX, prochain: n >= RESERVE_MAX ? null : (etat.ancre || 0) + (heures + 1) * RECHARGE_MS};
  }
  function paquetsDisponibles(etat, maintenant = Date.now()) {
    const r = reserveCourante(etat, maintenant);
    return {reserve: r.n, max: RESERVE_MAX, prochain: r.prochain, offerts: etat.offerts,
      echangeables: Math.floor(etat.points / PRIX_PAQUET), total: r.n + etat.offerts};
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
  // Consomme un paquet de la réserve s'il en reste, sinon un paquet offert. Renvoie null si aucun n'est disponible.
  function ouvrirPaquet(etat, cat, {maintenant = Date.now(), aleatoire = Math.random} = {}) {
    const r = reserveCourante(etat, maintenant);
    if (r.n + etat.offerts <= 0) return null;
    let origine;
    if (r.n > 0) {
      // Réserve pleine : la recharge repart de maintenant ; sinon l'heure entamée reste acquise
      etat.ancre = r.pleine ? maintenant : (etat.ancre || 0) + r.heures * RECHARGE_MS;
      etat.reserve = r.n - 1; origine = "reserve";
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
  // Exemplaires libres : ni repris du navigateur, ni en vente
  function disponibles(etat, id) { return Math.max(0, (etat.possedees[id] || 0) - ((etat.verrous && etat.verrous[id]) || 0)); }
  // Exemplaires recyclables : libres et en trop (le premier exemplaire de chaque carte est gardé)
  function recyclables(etat, id) { return Math.min(Math.max(0, (etat.possedees[id] || 0) - 1), disponibles(etat, id)); }
  // Exemplaires en trop recyclables, regroupés par rareté
  function doubles(etat, cat) {
    const parRarete = {};
    for (const id of Object.keys(etat.possedees)) {
      const c = cat.parId[id], k = recyclables(etat, id);
      if (!c || !k) continue;
      const r = parRarete[c.rarete] ||= {cartes: 0, exemplaires: 0, points: 0};
      r.cartes += 1; r.exemplaires += k; r.points += k * VALEUR_RECYCLAGE[c.rarete];
    }
    return parRarete;
  }
  // Recycle tous les exemplaires en trop des raretés choisies ; le premier exemplaire de chaque carte est gardé
  function recycler(etat, cat, raretes) {
    const choisies = new Set(raretes);
    let exemplaires = 0, points = 0;
    for (const id of Object.keys(etat.possedees)) {
      const c = cat.parId[id], k = recyclables(etat, id);
      if (!c || !k || !choisies.has(c.rarete)) continue;
      exemplaires += k; points += k * VALEUR_RECYCLAGE[c.rarete];
      etat.possedees[id] -= k;
    }
    if (exemplaires) { etat.points += points; noter(etat, "recyclage", {raretes: [...choisies], exemplaires, points}); }
    return {exemplaires, points};
  }
  // Dissolution des exemplaires en trop d'une seule carte (le premier exemplaire est toujours gardé)
  function dissoudre(etat, cat, id) {
    const c = cat.parId[id], k = c ? recyclables(etat, id) : 0;
    if (!k) return {exemplaires: 0, points: 0};
    const points = k * VALEUR_RECYCLAGE[c.rarete];
    etat.possedees[id] -= k; etat.points += points;
    noter(etat, "recyclage", {carte: id, exemplaires: k, points});
    return {exemplaires: k, points};
  }
  function echangerPoints(etat) {
    if (etat.points < PRIX_PAQUET) return false;
    etat.points -= PRIX_PAQUET; etat.offerts += 1;
    noter(etat, "echange", {points: PRIX_PAQUET});
    return true;
  }

  /* ---------- Objectifs ---------- */
  // Paliers [nombre de cartes, paquets offerts]. Les collections historiques sont faites surtout de cartes
  // épiques ou légendaires (une toutes les quelques semaines au rythme de la réserve) :
  // leurs premiers paliers sont bas. Les législatures et départements, faits surtout de cartes communes,
  // montent plus haut. Un palier au-delà de la taille de l'objectif est retiré ; la collection complète
  // donne toujours le dernier palier.
  const PALIERS = {
    // Premiers pas : une seule carte suffit (premier membre du Gouvernement, première sénatrice ou premier
    // sénateur, première carte épique...) ; de quoi gagner vite ses premiers paquets offerts
    // Récompenses : [seuil, quantité] en paquets offerts, ou [seuil, quantité, "voix"] pour les tâches les plus
    // simples, qui lancent la partie en voix ; les paquets restent aux tâches plus dures.
    premier: [[1, 10, "voix"]],
    // Taille de l'hémicycle (cartes différentes) : 348 sénateurs, 577 députés
    collection: [[10, 10, "voix"], [25, 15, "voix"], [50, 20, "voix"], [100, 25, "voix"], [250, 1], [348, 2], [577, 3], [1000, 3]],
    historique: [[1, 1], [5, 1], [15, 2]],
    presidents: [[1, 1], [5, 1], [15, 2], [40, 2]],
    // Législatures et départements : paliers hauts et récompenses modestes. Les paquets gagnés donnent des
    // cartes qui font avancer d'autres objectifs ; des paliers bas (10 cartes par législature, 5 par
    // département) relançaient la machine sans fin : en simulation, un joueur réunissait la moitié des cartes
    // dès le premier jour. Avec ces paliers, les objectifs rapportent bien moins d'un paquet par paquet ouvert.
    legislature: [[50, 1], [150, 2]],
    departement: [[15, 1], [40, 1]],
  };
  const COMPLETE = 5;  // paquets offerts pour une collection complète
  const ORDRE_EPOQUES = ["Révolution et Empire", "Monarchies constitutionnelles", "IIe République et Second Empire",
    "IIIe République", "Libération et IVe République", "Ve République"];
  function paliers(famille, total) {
    if (famille === "premier") return PALIERS.premier.slice();
    const p = PALIERS[famille].filter(([s]) => s < total);
    p.push([total, Math.max(COMPLETE, (p.length ? p[p.length - 1][1] : 0) + 1)]);
    return p;
  }
  function objectif(id, famille, titre, ids, sousTitre = "") {
    return {id, famille, titre, sousTitre, ids, total: ids.length, paliers: paliers(famille, ids.length)};
  }
  function definirObjectifs(cat) {
    const avec = code => cat.cartes.filter(c => c.distinctions.includes(code)).map(c => c.id);
    const premier = (id, titre, test, sous = "") => {
      const ids = cat.cartes.filter(test).map(c => c.id);
      if (ids.length) liste.push(objectif("premier:" + id, "premier", titre, ids, sous));
    };
    const liste = [];
    premier("gouvernement", "Premier membre du Gouvernement", c => c.chambres.includes("G"), "Un ministre ou un secrétaire d'État");
    premier("depute", "Premier député", c => c.chambres.includes("A"));
    premier("senateur", "Premier sénateur", c => c.chambres.includes("S"));
    premier("elue", "Première femme parlementaire", c => c.sexe === "F");
    premier("en-exercice", "Premier élu en exercice", c => c.actuel, "Un parlementaire ou un ministre d'aujourd'hui");
    premier("chef", "Premier chef de l'État ou du Gouvernement", c => c.distinctions.some(d => d === "chef-etat" || d === "chef-gouvernement" || d === "chef-etat-interim"));
    for (const [r, titre] of [["rare", "Première carte rare"], ["epique", "Première carte épique"], ["legendaire", "Première carte légendaire"], ["mythique", "Première carte mythique"]])
      premier("rarete:" + r, titre, c => c.rarete === r);
    for (const e of [...new Set(cat.cartes.map(c => c.epoque).filter(Boolean))].sort((a, b) => ORDRE_EPOQUES.indexOf(a) - ORDRE_EPOQUES.indexOf(b)))
      premier("epoque:" + normer(e).replace(/ /g, "-"), "Premier parlementaire : " + e, c => c.epoque === e);
    liste.push(objectif("hemicycle", "collection", "Remplir l'hémicycle", cat.cartes.map(c => c.id), "Cartes différentes de votre collection"));
    liste.push(
      objectif("quatre-vingts", "historique", "Les Quatre-vingts", avec("quatre-vingts"), "Parlementaires qui refusèrent les pleins pouvoirs à Pétain le 10 juillet 1940"),
      objectif("compagnons", "historique", "Compagnons de la Libération", avec("compagnon-liberation"), "Parlementaires faits Compagnons de la Libération"),
      objectif("presidents-assemblee", "presidents", "Présidents de l'Assemblée",
        cat.cartes.filter(c => c.distinctions.includes("presidence-an-longue") || c.distinctions.includes("presidence-an-courte")).map(c => c.id),
        "Présidents de l'Assemblée et des chambres qui l'ont précédée"));
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
  // La collection complète a sa propre clé : si l'objectif grandit avec les données, elle ne se réclame qu'une fois
  function clePalier(obj, seuil) { return obj.id + "@" + (seuil === obj.total && obj.famille !== "premier" ? "complet" : seuil); }
  function avancement(etat, obj) {
    const obtenues = obj.ids.reduce((n, id) => n + (etat.possedees[id] ? 1 : 0), 0);
    const etapes = obj.paliers.map(([seuil, quantite, type = "paquets"]) => ({seuil, quantite, type, paquets: type === "paquets" ? quantite : 0,
      voix: type === "voix" ? quantite : 0, cle: clePalier(obj, seuil), atteint: obtenues >= seuil, reclame: !!etat.objectifs[clePalier(obj, seuil)]}));
    return {obtenues, etapes, aReclamer: etapes.filter(e => e.atteint && !e.reclame), prochain: etapes.find(e => !e.atteint) || null};
  }
  // Clés des paliers atteints par une collection (reprise d'une collection à l'inscription, côté serveur). Avec le
  // catalogue du serveur, le compte se fait sur les plages des membres, sans décoder les listes : quelques ms.
  function clesAtteintes(cat, possedees) {
    const indices = cat.indexDe ? Object.keys(possedees).filter(id => possedees[id] > 0).map(id => cat.indexDe[id]).filter(i => i !== undefined).sort((a, b) => a - b) : null;
    const cles = [];
    for (const o of cat.objectifs) {
      let n = 0;
      if (indices && o.plages) {
        let k = 0;
        for (const i of indices) {
          while (k < o.plages.length && o.plages[k] + o.plages[k + 1] <= i) k += 2;
          if (k < o.plages.length && i >= o.plages[k]) n += 1;
        }
      } else n = o.ids.reduce((a, id) => a + (possedees[id] > 0 ? 1 : 0), 0);
      for (const [seuil] of o.paliers) if (n >= seuil) cles.push(clePalier(o, seuil));
    }
    return cles;
  }
  // Réclame tous les paliers atteints et non encore réclamés d'un objectif ; renvoie {paquets, voix} gagnés
  function reclamer(etat, cat, id) {
    const obj = cat.objectifParId[id];
    const gain = {paquets: 0, voix: 0};
    if (!obj) return gain;
    for (const e of avancement(etat, obj).aReclamer) {
      etat.objectifs[e.cle] = new Date().toISOString();
      gain.paquets += e.paquets; gain.voix += e.voix;
    }
    if (gain.paquets || gain.voix) { etat.offerts += gain.paquets; etat.points += gain.voix; noter(etat, "objectif", {id, ...gain}); }
    return gain;
  }
  // Récompenses en attente : {paquets, voix, objectifs} (objectifs : nombre d'objectifs à réclamer)
  function recompensesEnAttente(etat, cat) {
    const r = {paquets: 0, voix: 0, objectifs: 0};
    for (const o of cat.objectifs) {
      const a = avancement(etat, o).aReclamer;
      if (a.length) r.objectifs += 1;
      for (const e of a) { r.paquets += e.paquets; r.voix += e.voix; }
    }
    return r;
  }


  /* ---------- Favoris ---------- */
  function basculerFavori(etat, id, actif) {
    const f = (etat.favoris || []).filter(x => x !== String(id));
    if (actif && f.length < 300) f.push(String(id));
    etat.favoris = f;
    return f;
  }

  /* ---------- Questions au Gouvernement ---------- */
  // Cinq questions tirées des fiches officielles des cartes : département d'élection, fonction exercée,
  // « qui a été… », époque, année de première élection. Les mauvaises réponses ne sont jamais vraies elles
  // aussi (département où la personne n'a pas été élue, fonction qu'elle n'a pas exercée...). Le tirage dépend
  // d'une graine : les deux joueurs d'un duel reçoivent les mêmes questions.
  const QUIZ_QUESTIONS = 5, VOIX_PAR_BONNE = 2, BONUS_SANS_FAUTE = 5, SCORE_QUIZ = 25;
  function graineDe(texte) {  // FNV-1a 32 bits
    let h = 2166136261;
    for (const ch of String(texte)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function hasard(graine) {  // mulberry32
    let a = graine >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const cleFonction = t => normer(String(t).split(",")[0]);
  function preparerQuiz(cat) {
    if (cat.quiz) return cat.quiz;
    const vivier = cat.cartes.filter(c => c.score >= SCORE_QUIZ && c.mandats && (c.mandats.some(m => m[1]) || c.fonctions.length))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const departements = [...new Set(cat.cartes.flatMap(c => (c.mandats || []).map(m => m[1]).filter(Boolean)))].sort();
    const fonctions = [...new Set(vivier.flatMap(c => c.fonctions.map(f => f[0])))].sort();
    const epoques = [...new Set(cat.cartes.map(c => c.epoque).filter(Boolean))].sort();
    return cat.quiz = {vivier, departements, fonctions, epoques};
  }
  function question(cat, c, h) {
    const q = preparerQuiz(cat), elle = c.sexe === "F";
    const pris = (liste, exclus, n) => {  // n éléments distincts de la liste, hors exclus
      const r = [], vus = new Set();
      for (let essais = 0; r.length < n && essais < 200; essais++) {
        const x = liste[Math.floor(h() * liste.length)];
        if (x && !exclus(x) && !vus.has(x)) { vus.add(x); r.push(x); }
      }
      return r.length === n ? r : null;
    };
    const melanger = (bonne, autres, texte, explication) => {
      const choix = [bonne, ...autres];
      for (let i = choix.length - 1; i > 0; i--) { const j = Math.floor(h() * (i + 1)); [choix[i], choix[j]] = [choix[j], choix[i]]; }
      return {carte: c.id, texte, choix, bonne: choix.indexOf(bonne), explication};
    };
    const types = [];
    const deps = (c.mandats || []).map(m => m[1]).filter(Boolean);
    // Département, fonction et « qui a été » comptent double : ce sont les questions les plus parlantes
    if (deps.length) types.push("departement", "departement");
    if (c.fonctions.length) types.push("fonction", "fonction", "qui", "qui");
    if (c.epoque) types.push("epoque");
    if (c.debut) types.push("annee");
    const type = types[Math.floor(h() * types.length)];
    if (type === "departement") {
      const siens = new Set(deps.map(normer)), bonne = deps[0];
      const autres = pris(q.departements, d => siens.has(normer(d)), 3);
      if (autres) return melanger(bonne, autres, `Dans quel département ${c.nom} a-t-${elle ? "elle" : "il"} été ${elle ? "élue" : "élu"} ?`,
        `${c.nom} a été ${elle ? "élue" : "élu"} : ${[...new Set(deps)].join(", ")}.`);
    }
    if (type === "fonction") {
      const siennes = new Set(c.fonctions.map(f => cleFonction(f[0]))), bonne = c.fonctions[Math.floor(h() * c.fonctions.length)][0];
      const autres = pris(q.fonctions, f => siennes.has(cleFonction(f)), 3);
      if (autres) return melanger(bonne, autres, `Laquelle de ces fonctions ${c.nom} a-t-${elle ? "elle" : "il"} exercée ?`, `${c.nom} : ${bonne}.`);
    }
    if (type === "qui") {
      const f = c.fonctions[Math.floor(h() * c.fonctions.length)][0], cle = cleFonction(f);
      const autres = pris(q.vivier, x => x.id === c.id || x.fonctions.some(g => cleFonction(g[0]) === cle), 3);
      if (autres) return melanger(c.nom, autres.map(x => x.nom), `Qui a exercé cette fonction : ${f} ?`, `C'était ${c.nom}.`);
    }
    if (type === "epoque") {
      const autres = pris(q.epoques, e => e === c.epoque, 3);
      if (autres) return melanger(c.epoque, autres, `À quelle époque ${c.nom} a-t-${elle ? "elle" : "il"} commencé sa carrière ?`, `${c.nom} : ${c.epoque}, à partir de ${c.debut}.`);
    }
    if (type === "annee") {
      const ecarts = [-12, -8, -5, -3, 3, 5, 8, 12].map(d => c.debut + d).filter(a => a >= 1789 && a <= 2026);
      const autres = pris(ecarts, () => false, 3);
      if (autres) return melanger(c.debut, autres, `En quelle année commence la carrière de ${c.nom} ?`, `${c.nom} : premier mandat ou première fonction en ${c.debut}.`);
    }
    return null;
  }
  // Questions d'une graine ; collection : cartes du joueur, qui fournissent la moitié des questions s'il en a assez
  function questions(cat, graine, collection = null) {
    const q = preparerQuiz(cat), h = hasard(graine), liste = [], vues = new Set();
    const siennes = collection ? q.vivier.filter(c => collection[c.id]) : [];
    for (let essais = 0; liste.length < QUIZ_QUESTIONS && essais < 100; essais++) {
      const source = siennes.length >= 10 && liste.length % 2 === 0 ? siennes : q.vivier;
      const c = source[Math.floor(h() * source.length)];
      if (vues.has(c.id)) continue;
      const x = question(cat, c, h);
      if (x) { vues.add(c.id); liste.push(x); }
    }
    return liste;
  }
  // Données des questions pour le serveur (duels jugés par lui, réponses jamais envoyées d'avance au navigateur) :
  // le vivier et les listes de choix, rien d'autre ; questions() en tire exactement les mêmes questions que du
  // catalogue complet (vérifié par le test)
  function compacterQuiz(cat) {
    const q = preparerQuiz(cat);
    return {departements: q.departements, fonctions: q.fonctions, epoques: q.epoques,
      vivier: q.vivier.map(c => [c.id, c.nom, c.sexe === "F" ? 1 : 0, c.epoque || "", c.debut || 0,
        (c.mandats || []).map(m => m[1] || ""), c.fonctions.map(f => f[0])])};
  }
  function catalogueQuiz(data) {
    const vivier = data.vivier.map(([id, nom, f, epoque, debut, deps, fonctions]) => ({id, nom, sexe: f ? "F" : "M",
      epoque: epoque || null, debut: debut || null, mandats: deps.map(d => [null, d || null]), fonctions: fonctions.map(x => [x])}));
    return {quiz: {vivier, departements: data.departements, fonctions: data.fonctions, epoques: data.epoques}};
  }
  function recompenseQuiz(bonnes) { return bonnes * VOIX_PAR_BONNE + (bonnes === QUIZ_QUESTIONS ? BONUS_SANS_FAUTE : 0); }
  // Questions du jour : récompensées une fois par jour (jour de Paris). Le navigateur connaît les réponses ;
  // le gain est donc plafonné (15 voix par jour), qu'on triche ou non.
  function validerQuiz(etat, jour, bonnes) {
    const b = Math.max(0, Math.min(QUIZ_QUESTIONS, Math.floor(Number(bonnes)) || 0));
    if (etat.quiz === jour) return 0;
    const voix = recompenseQuiz(b);
    etat.quiz = jour; etat.points += voix;
    noter(etat, "quiz", {jour, bonnes: b, voix});
    return voix;
  }

  return {VERSION_ETAT, basculerFavori, RECHARGE_MS, QUIZ_QUESTIONS, graineDe, questions, compacterQuiz, catalogueQuiz, recompenseQuiz, validerQuiz, RESERVE_MAX, CARTES_PAR_PAQUET, reserveCourante, ORDRE, POIDS, VALEUR_RECYCLAGE, PRIX_PAQUET, PALIERS,
    etatVide, migrer, jourDuJeu, normer, cartesDeJeu, catalogue, compacter, catalogueCompact, paquetsDisponibles, ouvrirPaquet,
    disponibles, recyclables, doubles, recycler, dissoudre, echangerPoints, avancement, clesAtteintes, reclamer, recompensesEnAttente};
});
