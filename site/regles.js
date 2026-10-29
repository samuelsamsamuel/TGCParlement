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
  gardes     cartes dont les doubles ne sont pas proposés à la dissolution (1 000 au plus)
  deja       cartes obtenues puis cédées (compte seulement, fourni par le serveur) : plus dans la collection,
             mais pas grisées dans Toutes les cartes
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
  const ORDRE = ["commune", "peu-commune", "rare", "epique", "hors-categorie", "legendaire", "mythique", "unique"];
  // Probabilité de chaque rareté pour une carte tirée : les plus hautes restent rares, quel que soit leur nombre
  const POIDS = {"mythique": 0.4, "legendaire": 1.6, "epique": 6, "rare": 15, "peu-commune": 30, "commune": 46, "hors-categorie": 1, "unique": 0.004};
  // Recyclage : points rendus par exemplaire en trop, à peu près inverses de la fréquence de tirage.
  // Un paquet de doubles recyclé rapporte en moyenne 21 points, pour un paquet à 25 : recycler ne rend jamais
  // plus de paquets qu'il n'en consomme, sans quoi les doubles d'une collection avancée tourneraient sans fin.
  const VALEUR_RECYCLAGE = {"commune": 1, "peu-commune": 2, "rare": 5, "epique": 15, "hors-categorie": 40, "legendaire": 40, "mythique": 100, "unique": 250};
  const PRIX_PAQUET = 25;
  const JOURNAL_MAX = 200;

  /* ---------- État ---------- */
  function etatVide() {
    return {version: VERSION_ETAT, possedees: {}, reserve: RESERVE_MAX, ancre: 0, points: 0, offerts: 0, objectifs: {}, quiz: "", favoris: [], gardes: [], journal: [], deja: [], quotidien: {}};
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
    if (Array.isArray(brut.deja)) e.deja = [...new Set(brut.deja.map(String))].filter(id => !e.possedees[id]);
    if (Array.isArray(brut.favoris)) e.favoris = [...new Set(brut.favoris.map(String))].slice(0, 300);
    if (Array.isArray(brut.gardes)) e.gardes = [...new Set(brut.gardes.map(String))].slice(0, MAX_GARDES);
    e.offerts = entier(brut.offerts);
    if (brut.objectifs && typeof brut.objectifs === "object") Object.assign(e.objectifs, brut.objectifs);
    if (Array.isArray(brut.journal)) e.journal = brut.journal.slice(-JOURNAL_MAX);
    if (brut.quotidien && typeof brut.quotidien === "object" && !Array.isArray(brut.quotidien)) e.quotidien = brut.quotidien;
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
    // Commissions permanentes : [index dans d.commissions ([intitulé, chambre A ou S, familles]), début, fin]
    const coms = d.commissions || [];
    return d.cartes.map(([id, nom, r, score, epoque, actuel, debut, fin, source, portrait, distinctions, chambres, sexe, fonctions, mandats, groupe, photo, assemblees, commissions]) => ({
      id, nom, rarete: d.raretes[r], score, epoque, actuel: !!actuel, debut, fin, source, portrait, distinctions: distinctions || [],
      chambres: chambres || "", sexe, fonctions: fonctions || [], mandats: mandats || [], groupe, photo, assemblees: assemblees || [],
      commissions: (commissions || []).filter(([k]) => coms[k]).map(([k, debut, fin]) => ({intitule: coms[k][0], chambre: coms[k][1], familles: coms[k][2], debut, fin}))}));
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
    // Époque, chambres et sexe : thèmes de la carte recherchée du jour, comptés aussi par le serveur
    const epoques = [...new Set(cat.cartes.map(c => c.epoque).filter(Boolean))].sort();
    return {raretes, epoques, cartes: cat.cartes.map(c => [c.id, raretes.indexOf(c.rarete), c.actuel ? 1 : 0, c.score,
        c.epoque ? epoques.indexOf(c.epoque) : -1, c.chambres || "", c.sexe === "F" ? 1 : 0]),
      objectifs: cat.objectifs.map(o => [o.id, o.famille, o.titre, o.sousTitre, enPlages(o.ids.map(id => index.get(id)))])};
  }
  // Catalogue du serveur. Les membres d'un objectif ne sont décodés qu'à sa première évaluation (réclamation,
  // reprise d'une collection) : le serveur reste ainsi sous la limite de calcul d'une requête du plan gratuit.
  function catalogueCompact(data) {
    const cartes = data.cartes.map(([id, r, actuel, score, e, chambres, f]) => ({id, rarete: data.raretes[r], actuel: !!actuel, score,
      epoque: data.epoques && e >= 0 ? data.epoques[e] : null, chambres: chambres || "", sexe: f ? "F" : null}));
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
  // Doubles réduits (demande de l'utilisateur, octobre 2026 : 10 % de doubles entre le 700e et le 1 500e paquet).
  // Une carte déjà possédée, ou déjà sortie dans le paquet, est retirée dans la même rareté avec la probabilité
  // RELANCE_DOUBLE ; l'élu en exercice garanti, quand il est déjà possédé, est remplacé par une carte de la même rareté
  // prise parmi toutes (les élus en exercice, un millier, sont presque tous possédés vers le 700e paquet et faisaient
  // alors l'essentiel des doubles). Raretés inchangées. Simulation de 1 500 paquets, douze joueurs : doubles de 0,1 %
  // (1er au 100e paquet), 0,7 % (101e-300e), 2,8 % (301e-700e) et 9,9 % (701e-1 500e) ; avant : 3, 9, 19 et 33 %.
  const RELANCE_DOUBLE = 0.9;
  // Jamais deux fois la même carte dans un paquet : une carte déjà sortie est toujours retirée (vingt essais au plus,
  // pour la rareté unique qui n'a qu'une carte)
  function auHasard(l, aleatoire, sortie = () => false) {
    let c = l[Math.floor(aleatoire() * l.length)];
    for (let k = 0; k < 20 && sortie(c.id); k++) c = l[Math.floor(aleatoire() * l.length)];
    return c;
  }
  function tirerDans(l, aleatoire, possedee, sortie) {
    const c = auHasard(l, aleatoire, sortie);
    return possedee(c.id) && aleatoire() < RELANCE_DOUBLE ? auHasard(l, aleatoire, sortie) : c;
  }
  function tirerCarte(pool, aleatoire, possedee = () => false, sortie = () => false) {
    return tirerDans(pool[tirerRarete(pool, aleatoire)], aleatoire, possedee, sortie);
  }
  // Carte des élus et ministres en exercice ; déjà possédée, une carte de la même rareté parmi toutes
  function tirerActuel(cat, aleatoire, possedee, sortie) {
    const r = tirerRarete(cat.actuelsParRarete, aleatoire), c = auHasard(cat.actuelsParRarete[r], aleatoire, sortie);
    return possedee(c.id) ? tirerDans(cat.parRarete[r], aleatoire, possedee, sortie) : c;
  }
  // Consomme un paquet de la réserve s'il en reste, sinon un paquet offert. Renvoie null si aucun n'est disponible.
  function ouvrirPaquet(etat, cat, {maintenant = Date.now(), aleatoire = Math.random} = {}) {
    preparerJour(etat, cat, jourDuJeu(new Date(maintenant)));
    const r = reserveCourante(etat, maintenant);
    if (r.n + etat.offerts <= 0) return null;
    let origine;
    if (r.n > 0) {
      // Réserve pleine : la recharge repart de maintenant ; sinon l'heure entamée reste acquise
      etat.ancre = r.pleine ? maintenant : (etat.ancre || 0) + r.heures * RECHARGE_MS;
      etat.reserve = r.n - 1; origine = "reserve";
    } else { etat.offerts -= 1; origine = "offert"; }
    // Une carte parmi les élus et ministres en exercice (sauf s'il est déjà possédé), les autres au hasard
    const sortis = new Set(), possedee = id => !!etat.possedees[id], sortie = id => sortis.has(id);
    const garder = c => { sortis.add(c.id); return c; };
    const tirage = [garder(tirerActuel(cat, aleatoire, possedee, sortie))]
      .concat(Array.from({length: CARTES_PAR_PAQUET - 1}, () => garder(tirerCarte(cat.parRarete, aleatoire, possedee, sortie))))
      .sort((a, b) => ORDRE.indexOf(a.rarete) - ORDRE.indexOf(b.rarete) || a.score - b.score);
    const neuves = new Set(tirage.filter(c => !etat.possedees[c.id]).map(c => c.id));
    for (const c of tirage) etat.possedees[c.id] = (etat.possedees[c.id] || 0) + 1;
    noter(etat, "paquet", {origine, cartes: tirage.map(c => c.id)});
    compter(etat, "paquets", 1, jourDuJeu(new Date(maintenant)));
    return {tirage, neuves, origine};
  }

  /* ---------- Recyclage ---------- */
  // Exemplaires libres : ni repris du navigateur, ni en vente
  function disponibles(etat, id) { return Math.max(0, (etat.possedees[id] || 0) - ((etat.verrous && etat.verrous[id]) || 0)); }
  // Exemplaires recyclables : libres et en trop (le premier exemplaire de chaque carte est gardé)
  function recyclables(etat, id) { return Math.min(Math.max(0, (etat.possedees[id] || 0) - 1), disponibles(etat, id)); }
  // Cartes gardées (« Ne pas dissoudre », demande de l'utilisateur, octobre 2026) : leurs doubles ne sont ni comptés
  // ni dissous par rareté ; seule une dissolution choisie carte par carte les touche
  const MAX_GARDES = 1000;
  const gardees = etat => new Set(etat.gardes || []);
  function garderCartes(etat, ids, actif) {
    const g = gardees(etat);
    for (const id of ids.map(String)) actif ? g.add(id) : g.delete(id);
    etat.gardes = [...g].slice(0, MAX_GARDES);
    return etat.gardes;
  }
  // Exemplaires en trop recyclables, regroupés par rareté (cartes gardées exclues)
  function doubles(etat, cat) {
    const parRarete = {}, g = gardees(etat);
    for (const id of Object.keys(etat.possedees)) {
      const c = cat.parId[id], k = recyclables(etat, id);
      if (!c || !k || g.has(id)) continue;
      const r = parRarete[c.rarete] ||= {cartes: 0, exemplaires: 0, points: 0};
      r.cartes += 1; r.exemplaires += k; r.points += k * VALEUR_RECYCLAGE[c.rarete];
    }
    return parRarete;
  }
  // Recycle tous les exemplaires en trop des raretés choisies ; le premier exemplaire de chaque carte est gardé
  function recycler(etat, cat, raretes) {
    const choisies = new Set(raretes), g = gardees(etat);
    let exemplaires = 0, points = 0;
    for (const id of Object.keys(etat.possedees)) {
      const c = cat.parId[id], k = recyclables(etat, id);
      if (!c || !k || !choisies.has(c.rarete) || g.has(id)) continue;
      exemplaires += k; points += k * VALEUR_RECYCLAGE[c.rarete];
      etat.possedees[id] -= k;
    }
    if (exemplaires) { etat.points += points; noter(etat, "recyclage", {raretes: [...choisies], exemplaires, points}); compter(etat, "dissous", exemplaires); }
    return {exemplaires, points};
  }
  // Dissolution des exemplaires en trop d'une seule carte (le premier exemplaire est toujours gardé)
  // Doubles d'une carte ; avec « tout », aussi le dernier exemplaire libre (la carte quitte alors la collection)
  function dissoudre(etat, cat, id, tout = false) {
    const c = cat.parId[id], k = c ? (tout ? disponibles(etat, id) : recyclables(etat, id)) : 0;
    if (!k) return {exemplaires: 0, points: 0};
    const points = k * VALEUR_RECYCLAGE[c.rarete];
    etat.possedees[id] -= k; etat.points += points;
    noter(etat, "recyclage", {carte: id, exemplaires: k, points});
    compter(etat, "dissous", k);
    return {exemplaires: k, points};
  }
  // Plusieurs cartes à la fois (sélection de l'hémicycle) : leurs doubles seuls si garder, sinon tous leurs exemplaires libres
  const MAX_SELECTION = 200;
  function dissoudreSelection(etat, cat, ids, garder = true) {
    const r = {cartes: 0, exemplaires: 0, points: 0};
    for (const id of [...new Set(ids)].slice(0, MAX_SELECTION)) {
      const c = cat.parId[id], k = c ? (garder ? recyclables(etat, id) : disponibles(etat, id)) : 0;
      if (!k) continue;
      etat.possedees[id] -= k;
      r.cartes += 1; r.exemplaires += k; r.points += k * VALEUR_RECYCLAGE[c.rarete];
    }
    // Une seule ligne de journal pour toute la sélection
    if (r.exemplaires) { etat.points += r.points; noter(etat, "recyclage", {selection: r.cartes, exemplaires: r.exemplaires, points: r.points}); compter(etat, "dissous", r.exemplaires); }
    return r;
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
    if (gain.paquets || gain.voix) { etat.offerts += gain.paquets; etat.points += gain.voix; noter(etat, "objectif", {id, ...gain}); compter(etat, "objectifs", 1); }
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

  /* ---------- Journée : série de connexion et objectifs du jour ---------- */
  // État : etat.quotidien = {serie: {jour, rang}, lot: {cartes, rang} | null, compteurs: {jour, paquets, dissous,
  // objectifs}, recherche: {jour, base}, recus: {jour, cles}}. Jours de Paris (jourDuJeu).
  const veille = jour => new Date(Date.parse(jour + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  const quotidien = etat => (etat.quotidien && typeof etat.quotidien === "object" ? etat.quotidien : (etat.quotidien = {}));
  function compter(etat, cle, n, jour = jourDuJeu()) {
    const q = quotidien(etat);
    if (!q.compteurs || q.compteurs.jour !== jour) q.compteurs = {jour};
    q.compteurs[cle] = (q.compteurs[cle] || 0) + n;
  }

  // Série de connexion « Choix » (décision de l'utilisateur, octobre 2026) : un lot par jour de Paris, sept lots qui
  // montent ; le lendemain du septième, on recommence au premier. Un jour manqué fait redescendre d'un palier (le lot
  // suivant est celui d'avant le dernier reçu) : sauter des jours ne rapporte jamais plus que venir chaque jour.
  // « choix » : le joueur choisit une carte parmi n cartes qu'il n'a pas encore.
  const SERIE = [
    {voix: 10},
    {choix: 3, raretes: ["commune"], titre: "une carte parmi 3 communes"},
    {paquets: 1},
    {voix: 25},
    {choix: 5, raretes: ["peu-commune", "rare", "epique", "legendaire", "mythique"], titre: "une carte parmi 5 peu communes ou mieux"},
    {paquets: 2},
    {choix: 5, garantie: "epique", titre: "une carte parmi 5, dont une épique"},
  ];
  // Rang du prochain lot (1 à 7) et s'il est disponible aujourd'hui
  function serieDuJour(etat, jour) {
    const s = quotidien(etat).serie || {jour: null, rang: 0};
    if (s.jour === jour) return {rang: s.rang, disponible: false, lot: SERIE[s.rang - 1]};
    const rang = !s.rang ? 1 : s.jour === veille(jour) ? s.rang % SERIE.length + 1 : Math.max(1, s.rang - 1);
    return {rang, disponible: true, lot: SERIE[rang - 1]};
  }
  // Propositions d'un lot « choix » : cartes pas encore possédées, des raretés demandées, au hasard selon les poids
  // de tirage (la carte unique et les hors catégorie en sont exclues, sauf tirage ordinaire pour les cartes libres)
  function propositions(etat, cat, lot, aleatoire) {
    const pris = new Set(), libre = c => !etat.possedees[c.id] && !pris.has(c.id);
    const tirer = pool => { for (let k = 0; k < 30; k++) { const c = tirerCarte(pool, aleatoire); if (libre(c)) return c; } return null; };
    const filtre = r => Object.fromEntries(Object.entries(cat.parRarete).filter(([x]) => r.includes(x)));
    const choix = [];
    if (lot.garantie) { const c = tirer({[lot.garantie]: cat.parRarete[lot.garantie]}); if (c) { pris.add(c.id); choix.push(c.id); } }
    const pool = lot.raretes ? filtre(lot.raretes) : filtre(ORDRE.filter(r => r !== "unique" && r !== "hors-categorie"));
    for (let k = 0; choix.length < lot.choix && k < 50; k++) { const c = tirer(pool); if (c) { pris.add(c.id); choix.push(c.id); } }
    for (let i = choix.length - 1; i > 0; i--) { const j = Math.floor(aleatoire() * (i + 1)); [choix[i], choix[j]] = [choix[j], choix[i]]; }
    return choix;
  }
  // Recevoir le lot du jour : voix et paquets crédités, ou propositions à choisir (choisirLot). Un lot à choisir
  // encore en attente doit être choisi avant le suivant.
  function reclamerSerie(etat, cat, jour, aleatoire = Math.random) {
    const q = quotidien(etat), s = serieDuJour(etat, jour);
    if (!s.disponible || q.lot) return null;
    const lot = s.lot, gain = {voix: lot.voix || 0, paquets: lot.paquets || 0, choix: null};
    etat.points += gain.voix; etat.offerts += gain.paquets;
    if (lot.choix) gain.choix = (q.lot = {cartes: propositions(etat, cat, lot, aleatoire), rang: s.rang}).cartes;
    q.serie = {jour, rang: s.rang};
    noter(etat, "serie", {rang: s.rang, voix: gain.voix, paquets: gain.paquets, choix: gain.choix});
    return gain;
  }
  function choisirLot(etat, cat, id) {
    const q = quotidien(etat);
    if (!q.lot || !q.lot.cartes.map(String).includes(String(id)) || !cat.parId[id]) return null;
    etat.possedees[id] = (etat.possedees[id] || 0) + 1;
    noter(etat, "lot", {carte: id, rang: q.lot.rang});
    q.lot = null;
    return {carte: id};
  }

  // Série du jeu du Gouvernement (demande de l'utilisateur, octobre 2026 : la récompense se reçoit à la fin de la série,
  // et des cartes à choisir la rendent plus intéressante). Chaque victoire contre l'ordinateur ou un joueur tiré au hasard
  // fait monter d'un palier ; après une victoire, le joueur encaisse la récompense du palier atteint (la série repart de
  // zéro) ou continue pour viser plus haut, au risque de tout perdre à la défaite. Au cinquième palier, la série est
  // complète et s'encaisse d'elle-même. ENCAISSEMENTS_JOUR encaissements par jour de Paris au plus ; au-delà, la série
  // attend le lendemain (les victoires au palier 5 ne la font plus monter). État : quotidien.gouv = {serie, jour,
  // encaisses, lot}.
  const SERIE_GOUV = [
    {voix: 15},
    {paquets: 1},
    {choix: 3, raretes: ["rare", "epique", "legendaire", "mythique"], titre: "une carte parmi 3 rares ou mieux"},
    {paquets: 1, choix: 3, raretes: ["epique", "legendaire", "mythique"], titre: "une carte parmi 3 épiques ou mieux, et un paquet"},
    {paquets: 2, choix: 3, raretes: ["legendaire", "mythique"], titre: "une carte parmi 3 légendaires ou mieux, et deux paquets"},
  ];
  const ENCAISSEMENTS_JOUR = 3;
  function serieGouv(etat, jour = jourDuJeu()) {
    const q = quotidien(etat);
    const g = q.gouv && typeof q.gouv === "object" ? q.gouv : (q.gouv = {serie: 0, jour: "", encaisses: 0, lot: null});
    return {serie: g.serie || 0, lot: g.lot || null, encaissesDuJour: g.jour === jour ? g.encaisses || 0 : 0, max: ENCAISSEMENTS_JOUR,
            recompense: g.serie ? SERIE_GOUV[g.serie - 1] : null, suivante: SERIE_GOUV[g.serie || 0] || null};
  }
  // Issue d'une partie de série : victoire (un palier de plus), défaite (tout est perdu), nul (rien ne change)
  function issueSerieGouv(etat, cat, issue, jour = jourDuJeu(), aleatoire = Math.random) {
    serieGouv(etat, jour);
    const g = quotidien(etat).gouv, avant = g.serie || 0;
    if (issue === "perdu") g.serie = 0;
    else if (issue === "gagne") g.serie = Math.min(SERIE_GOUV.length, avant + 1);
    noter(etat, "serie-gouv", {issue, serie: g.serie, avant});
    const gain = g.serie === SERIE_GOUV.length && avant < SERIE_GOUV.length ? encaisserSerieGouv(etat, cat, jour, aleatoire) : null;
    return {serie: g.serie, perdue: issue === "perdu" ? avant : 0, gain};
  }
  // Encaisser : voix et paquets du palier crédités, cartes proposées à choisir (choisirLotGouv) ; la série repart de zéro
  function encaisserSerieGouv(etat, cat, jour = jourDuJeu(), aleatoire = Math.random) {
    const s = serieGouv(etat, jour), g = quotidien(etat).gouv;
    if (!s.serie || s.lot || s.encaissesDuJour >= ENCAISSEMENTS_JOUR) return null;
    const lot = SERIE_GOUV[s.serie - 1], gain = {palier: s.serie, voix: lot.voix || 0, paquets: lot.paquets || 0, choix: null};
    etat.points += gain.voix; etat.offerts += gain.paquets;
    if (lot.choix) gain.choix = (g.lot = {cartes: propositions(etat, cat, lot, aleatoire), palier: s.serie}).cartes;
    g.encaisses = s.encaissesDuJour + 1; g.jour = jour; g.serie = 0;
    noter(etat, "encaisser-gouv", gain);
    return gain;
  }
  function choisirLotGouv(etat, cat, id) {
    const g = quotidien(etat).gouv;
    if (!g || !g.lot || !g.lot.cartes.map(String).includes(String(id)) || !cat.parId[id]) return null;
    etat.possedees[id] = (etat.possedees[id] || 0) + 1;
    noter(etat, "lot-gouv", {carte: id, palier: g.lot.palier});
    g.lot = null;
    return {carte: id};
  }

  // Objectifs du jour (décision de l'utilisateur, octobre 2026 : dans l'ordre du jour, deux petites tâches et une carte
  // recherchée). Les mêmes pour tous les joueurs, tirés de la date. Tâches comptées par les opérations des règles ;
  // carte recherchée : une carte de plus, ce jour-là, dans un thème (époque, chambre, Gouvernement, femmes, rare ou
  // mieux), quel que soit le moyen (paquet, échange, comptoir) : le compte du thème est noté au premier passage du jour.
  const TACHES = [
    {cle: "paquets3", titre: "Ouvrir 3 paquets", compteur: "paquets", cible: 3},
    {cle: "paquets6", titre: "Ouvrir 6 paquets", compteur: "paquets", cible: 6},
    {cle: "dissous3", titre: "Dissoudre 3 cartes en trop", compteur: "dissous", cible: 3},
    {cle: "quiz", titre: "Répondre aux questions au Gouvernement", quiz: true, cible: 1},
    {cle: "objectif", titre: "Réclamer une récompense de l'ordre du jour", compteur: "objectifs", cible: 1},
  ];
  const VOIX_TACHE = 10, PAQUETS_RECHERCHE = 1;
  function themes(cat) {
    if (cat.themes) return cat.themes;
    const epoques = [...new Set(cat.cartes.map(c => c.epoque).filter(Boolean))].sort();
    return cat.themes = [
      ...epoques.map(e => ({titre: `une nouvelle carte de l'époque « ${e} »`, test: c => c.epoque === e})),
      {titre: "un nouveau sénateur ou une nouvelle sénatrice", test: c => (c.chambres || "").includes("S")},
      {titre: "un nouveau membre du Gouvernement", test: c => (c.chambres || "").includes("G")},
      {titre: "une nouvelle femme parlementaire ou ministre", test: c => c.sexe === "F"},
      {titre: "une nouvelle carte rare ou mieux", test: c => ["rare", "epique", "hors-categorie", "legendaire", "mythique", "unique"].includes(c.rarete)},
    ];
  }
  function objectifsDuJour(cat, jour) {
    const h = hasard(graineDe("jour|" + jour)), t = TACHES.slice();
    for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(h() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
    // Deux tâches qui ne comptent pas la même chose (pas « 3 paquets » et « 6 paquets » ensemble)
    const taches = [t[0], t.slice(1).find(x => (x.compteur || "quiz") !== (t[0].compteur || "quiz"))];
    const th = themes(cat);
    return {taches, theme: th[Math.floor(h() * th.length)]};
  }
  const compteTheme = (etat, cat, theme) => Object.keys(etat.possedees).filter(id => etat.possedees[id] > 0 && cat.parId[id] && theme.test(cat.parId[id])).length;
  // Premier passage du jour : compte du thème recherché (idempotent)
  function preparerJour(etat, cat, jour = jourDuJeu()) {
    const q = quotidien(etat);
    if (q.recherche && q.recherche.jour === jour) return false;
    q.recherche = {jour, base: compteTheme(etat, cat, objectifsDuJour(cat, jour).theme)};
    return true;
  }
  // Avancement des objectifs du jour, pour l'interface et la réclamation
  function etatDuJour(etat, cat, jour = jourDuJeu()) {
    const q = quotidien(etat), o = objectifsDuJour(cat, jour);
    const compteurs = q.compteurs && q.compteurs.jour === jour ? q.compteurs : {};
    const recus = new Set(q.recus && q.recus.jour === jour ? q.recus.cles : []);
    const taches = o.taches.map(t => {
      const avance = Math.min(t.cible, t.quiz ? (etat.quiz === jour ? 1 : 0) : compteurs[t.compteur] || 0);
      return {cle: t.cle, titre: t.titre, avance, cible: t.cible, fait: avance >= t.cible, recu: recus.has(t.cle), gain: {voix: VOIX_TACHE, paquets: 0}};
    });
    const base = q.recherche && q.recherche.jour === jour ? q.recherche.base : null;
    const fait = base !== null && compteTheme(etat, cat, o.theme) > base;
    const recherche = {cle: "recherche", titre: "Carte recherchée : " + o.theme.titre, avance: fait ? 1 : 0, cible: 1, fait, recu: recus.has("recherche"),
      gain: {voix: 0, paquets: PAQUETS_RECHERCHE}};
    return {jour, objectifs: [...taches, recherche], serie: serieDuJour(etat, jour), lot: q.lot || null};
  }
  function reclamerJour(etat, cat, jour, cle) {
    const o = etatDuJour(etat, cat, jour).objectifs.find(x => x.cle === cle);
    if (!o || !o.fait || o.recu) return null;
    const q = quotidien(etat);
    if (!q.recus || q.recus.jour !== jour) q.recus = {jour, cles: []};
    q.recus.cles.push(cle);
    etat.points += o.gain.voix; etat.offerts += o.gain.paquets;
    noter(etat, "jour", {cle, ...o.gain});
    return o.gain;
  }

  /* ---------- Questions au Gouvernement ---------- */
  // Cinq questions tirées des fiches officielles des cartes, depuis 1958 seulement (demande de l'utilisateur, octobre
  // 2026 : des questions plus simples et plus variées) : « Qui est-ce ? » sur un portrait, « Qui est actuellement… ? »,
  // « Qui a été… ? », département d'élection, fonction exercée. Les mauvaises réponses ne sont jamais vraies elles aussi
  // (personne qui n'a pas exercé la fonction, département où elle n'a pas été élue...). Le tirage dépend d'une graine :
  // les deux joueurs d'un duel reçoivent les mêmes questions.
  const QUIZ_QUESTIONS = 5, VOIX_PAR_BONNE = 2, BONUS_SANS_FAUTE = 5, SCORE_QUIZ = 25, ANNEE_QUIZ = 1958, LIBELLE_QUIZ = 90;
  // Notoriété demandée par type de question (score de la carte) : un visage se reconnaît moins qu'un nom ne se situe
  const SCORE_PHOTO = 40, SCORE_NOM = 35;
  // Une série : un « Qui est-ce ? », un poste actuel, un département, un « Qui a été… ? », une fonction, dans le désordre
  const TYPES_QUIZ = ["photo", "actuel", "departement", "qui", "fonction"];
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
  // Fonctions retenues pour les questions : exercées depuis 1958, au libellé assez court pour se lire d'un coup d'œil
  const fonctionsQuiz = c => c.fonctions.filter(f => (f[1] || 0) >= ANNEE_QUIZ && String(f[0]).length <= LIBELLE_QUIZ);
  // Portrait d'une carte pour « Qui est-ce ? » : adresse complète, ou fichier de Commons (« commons: » + nom)
  const photoQuiz = c => c.photo || (c.portrait ? "commons:" + c.portrait : null);
  function preparerQuiz(cat) {
    if (cat.quiz) return cat.quiz;
    // Parlementaires et ministres de la Ve République : carrière commencée en 1958 ou après, assez connus (score) ou en
    // exercice ; départements de leurs mandats depuis 1958
    const vivier = cat.cartes.filter(c => (c.debut || 0) >= ANNEE_QUIZ && (c.score >= SCORE_QUIZ || c.actuel) && c.mandats
      && (c.mandats.some(m => m[1]) || fonctionsQuiz(c).length || photoQuiz(c)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const departements = [...new Set(vivier.flatMap(c => c.mandats.map(m => m[1]).filter(Boolean)))].sort();
    const fonctions = [...new Set(vivier.flatMap(c => fonctionsQuiz(c).map(f => f[0])))].sort();
    // Postes occupés aujourd'hui par une seule personne (fonction sans date de fin) : « Qui est actuellement… ? »
    const titulaires = {};
    for (const c of vivier) for (const f of fonctionsQuiz(c)) if (f[2] === null || f[2] === undefined) (titulaires[f[0]] ||= new Set()).add(c.id);
    const postes = Object.keys(titulaires).filter(f => titulaires[f].size === 1).sort();
    const connus = vivier.filter(c => c.score >= SCORE_PHOTO);
    return cat.quiz = {vivier, connus, departements, fonctions, postes, parId: Object.fromEntries(vivier.map(c => [c.id, c])),
      titulaire: Object.fromEntries(postes.map(f => [f, [...titulaires[f]][0]]))};
  }
  function question(cat, c, h, type) {
    const q = preparerQuiz(cat), elle = c.sexe === "F";
    const pris = (liste, exclus, n) => {  // n éléments distincts de la liste, hors exclus
      const r = [], vus = new Set();
      for (let essais = 0; r.length < n && essais < 200; essais++) {
        const x = liste[Math.floor(h() * liste.length)];
        if (x && !exclus(x) && !vus.has(x)) { vus.add(x); r.push(x); }
      }
      return r.length === n ? r : null;
    };
    const melanger = (bonne, autres, texte, explication, photo = null) => {
      const choix = [bonne, ...autres];
      for (let i = choix.length - 1; i > 0; i--) { const j = Math.floor(h() * (i + 1)); [choix[i], choix[j]] = [choix[j], choix[i]]; }
      return {carte: c.id, texte, choix, bonne: choix.indexOf(bonne), explication, ...(photo ? {photo} : {})};
    };
    // Autres personnes du même sexe, pour que la réponse ne se devine pas au prénom
    const memes = x => x.id !== c.id && (x.sexe === "F") === elle;
    const deps = c.mandats.map(m => m[1]).filter(Boolean), fonctions = fonctionsQuiz(c);
    const poste = q.postes.find(f => q.titulaire[f] === c.id);
    if (type === "photo" && photoQuiz(c) && c.score >= SCORE_PHOTO) {
      const autres = pris(q.connus, x => !memes(x) || x.nom === c.nom, 3);
      if (autres) return melanger(c.nom, autres.map(x => x.nom), "Qui est-ce ?", `C'est ${c.nom}.`, photoQuiz(c));
    }
    if (type === "actuel" && poste) {
      const cle = cleFonction(poste), autres = pris(q.vivier, x => !memes(x) || !x.actuel || fonctionsQuiz(x).some(g => cleFonction(g[0]) === cle), 3);
      if (autres) return melanger(c.nom, autres.map(x => x.nom), `Qui est actuellement ${elle ? "la titulaire" : "le titulaire"} de ce poste : ${poste} ?`, `C'est ${c.nom}.`);
    }
    if (type === "departement" && deps.length && c.score >= SCORE_NOM) {
      const siens = new Set(deps.map(normer)), bonne = deps[0];
      const autres = pris(q.departements, d => siens.has(normer(d)), 3);
      if (autres) return melanger(bonne, autres, `Dans quel département ${c.nom} a-t-${elle ? "elle" : "il"} été ${elle ? "élue" : "élu"} ?`,
        `${c.nom} a été ${elle ? "élue" : "élu"} : ${[...new Set(deps)].join(", ")}.`);
    }
    if (type === "qui" && fonctions.length && c.score >= SCORE_NOM) {
      const f = fonctions[Math.floor(h() * fonctions.length)][0], cle = cleFonction(f);
      const autres = pris(q.connus, x => !memes(x) || x.nom === c.nom || x.fonctions.some(g => cleFonction(g[0]) === cle), 3);
      if (autres) return melanger(c.nom, autres.map(x => x.nom), `Qui a été : ${f} ?`, `C'était ${c.nom}.`);
    }
    if (type === "fonction" && fonctions.length && c.score >= SCORE_NOM) {
      const siennes = new Set(c.fonctions.map(f => cleFonction(f[0]))), bonne = fonctions[Math.floor(h() * fonctions.length)][0];
      const autres = pris(q.fonctions, f => siennes.has(cleFonction(f)), 3);
      if (autres) return melanger(bonne, autres, `Laquelle de ces fonctions ${c.nom} a-t-${elle ? "elle" : "il"} exercée ?`, `${c.nom} : ${bonne}.`);
    }
    return null;
  }
  // Questions d'une graine : les cinq types dans un ordre tiré au sort. collection : cartes du joueur, d'où vient une
  // question sur deux quand il en a assez (le poste actuel, lui, se tire parmi les postes)
  function questions(cat, graine, collection = null) {
    const q = preparerQuiz(cat), h = hasard(graine), liste = [], vues = new Set();
    const siennes = collection ? q.vivier.filter(c => collection[c.id]) : [];
    const types = TYPES_QUIZ.slice();
    for (let i = types.length - 1; i > 0; i--) { const j = Math.floor(h() * (i + 1)); [types[i], types[j]] = [types[j], types[i]]; }
    for (const type of types) {
      for (let essais = 0; essais < 60; essais++) {
        const source = type === "actuel" ? null : siennes.length >= 10 && liste.length % 2 === 0 && essais < 20 ? siennes : type === "photo" ? q.connus : q.vivier;
        const c = source ? source[Math.floor(h() * source.length)] : q.parId[q.titulaire[q.postes[Math.floor(h() * q.postes.length)]]];
        if (!c || vues.has(c.id)) continue;
        const x = question(cat, c, h, type);
        if (x) { vues.add(c.id); liste.push(x); break; }
      }
    }
    return liste;
  }
  // Données des questions pour le serveur (duels jugés par lui, réponses jamais envoyées d'avance au navigateur) :
  // le vivier et ce que les questions en lisent, rien d'autre ; questions() en tire exactement les mêmes questions que
  // du catalogue complet (vérifié par le test)
  function compacterQuiz(cat) {
    const q = preparerQuiz(cat);
    return {version: 2, vivier: q.vivier.map(c => [c.id, c.nom, c.sexe === "F" ? 1 : 0, c.debut || 0, c.score, c.actuel ? 1 : 0, photoQuiz(c) || "",
      c.mandats.map(m => m[1] || ""), c.fonctions.map(f => [f[0], f[1] || 0, f[2] === undefined ? null : f[2]])])};
  }
  function catalogueQuiz(data) {
    const cartes = data.vivier.map(([id, nom, f, debut, score, actuel, photo, deps, fonctions]) => ({id, nom, sexe: f ? "F" : "M",
      debut: debut || null, score, actuel: !!actuel, photo: photo && !photo.startsWith("commons:") ? photo : null,
      portrait: photo && photo.startsWith("commons:") ? photo.slice(8) : null,
      mandats: deps.map(d => [null, d || null]), fonctions}));
    return {cartes};
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

  return {VERSION_ETAT, SERIE_GOUV, ENCAISSEMENTS_JOUR, serieGouv, issueSerieGouv, encaisserSerieGouv, choisirLotGouv, basculerFavori, MAX_GARDES, garderCartes, RECHARGE_MS, QUIZ_QUESTIONS, graineDe, questions, compacterQuiz, catalogueQuiz, recompenseQuiz, validerQuiz, RESERVE_MAX, CARTES_PAR_PAQUET, reserveCourante, ORDRE, POIDS, VALEUR_RECYCLAGE, PRIX_PAQUET, PALIERS,
    etatVide, migrer, jourDuJeu, normer, cartesDeJeu, catalogue, compacter, catalogueCompact, paquetsDisponibles, ouvrirPaquet,
    disponibles, recyclables, doubles, recycler, dissoudre, MAX_SELECTION, dissoudreSelection, echangerPoints, avancement, clesAtteintes, reclamer, recompensesEnAttente,
    SERIE, serieDuJour, reclamerSerie, choisirLot, objectifsDuJour, preparerJour, etatDuJour, reclamerJour};
});
