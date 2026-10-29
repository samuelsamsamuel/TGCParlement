// Simulation de réglage du jeu du Gouvernement (sans installation : node scripts/simulation_gouvernement.js [parties]).
// Collections tirées par les vraies règles des paquets (site/regles.js), gouvernements composés et manches jouées par
// une stratégie simple, forces et liens calculés par site/gouvernement.js. Cibles fixées avec l'utilisateur (octobre
// 2026) : un spécialiste trois étoiles bat une vedette sans spécialité environ trois fois sur quatre sur son thème ; un
// gouvernement de mythiques gagne au plus 60 % de ses parties contre un gouvernement ordinaire mais cohérent ; moins
// de 5 % des manches finissent en égalité.
const R = require("../site/regles.js"), G = require("../site/gouvernement.js");
for (const k of ["ETOILE", "PLAFOND_STATURE", "LIENS_MAX"]) if (process.env[k]) G[k] = Number(process.env[k]);
const data = require("../site/jeu.json"), fichesBrutes = require("../site/gouvernement.json");
const cat = R.catalogue(R.cartesDeJeu(data), data.assemblees);
const {fiches, themes} = G.fichesDeJeu(fichesBrutes);
const PARTIES = Number(process.argv[2]) || 400;
const rarete = new Map(cat.cartes.map(c => [String(c.id), c.rarete]));

let graine = 12345;
const alea = () => { graine = (graine * 1664525 + 1013904223) >>> 0; return graine / 4294967296; };
const melanger = l => { l = l.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(alea() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; };

function collection(paquets) {
  const e = R.etatVide();
  for (let i = 0; i < paquets; i++) { e.reserve = 0; e.ancre = Date.now(); e.offerts = 1; R.ouvrirPaquet(e, cat, {aleatoire: alea}); }
  return Object.keys(e.possedees).map(String).filter(id => fiches.has(id)).map(id => fiches.get(id));
}

// Valeur d'un gouvernement pour des thèmes : affectation gloutonne des ministres aux thèmes (forces décroissantes)
function valeur(chef, ministres, annonces) {
  const bonus = G.liens(chef, ministres).map(l => l.total), paires = [];
  ministres.forEach((m, i) => annonces.forEach(t => paires.push([G.force(m, t, bonus[i]), i, t])));
  paires.sort((a, b) => b[0] - a[0]);
  const pris = new Set(), faits = new Set(); let total = 0;
  for (const [f, i, t] of paires) if (!pris.has(i) && !faits.has(t)) { pris.add(i); faits.add(t); total += f; }
  return total;
}

// Composition : quelques chefs parmi les plus hautes statures, ministres ajoutés un à un (meilleur gain), plafond respecté
function composer(cartes, annonces, {coherence = true} = {}) {
  const chefs = cartes.slice().sort((a, b) => b.stature - a.stature || b.annees - a.annees).slice(0, 4);
  let meilleur = null;
  for (const chef of chefs) {
    const ministres = [];
    let reste = G.PLAFOND_STATURE;
    const candidats = cartes.filter(c => c !== chef);
    while (ministres.length < G.MINISTRES) {
      const places = G.MINISTRES - ministres.length - 1;
      let choix = null, v = -1;
      const base = ministres.length ? valeur(chef, ministres, annonces) : 0;
      // pré-sélection par force brute sur les thèmes, pour borner le calcul des liens
      const tri = candidats.filter(c => !ministres.includes(c) && c.stature <= reste - places)
        .map(c => [Math.max(...annonces.map(t => G.force(c, t, 0))), c]).sort((a, b) => b[0] - a[0]).slice(0, 60);
      for (const [, c] of tri) {
        const nv = coherence ? valeur(chef, [...ministres, c], annonces) : base + Math.max(...annonces.map(t => G.force(c, t, 0)));
        const gain = nv - base - 0.3 * c.stature;  // la stature consomme le plafond
        if (gain > v) { v = gain; choix = c; }
      }
      if (!choix) break;
      ministres.push(choix); reste -= choix.stature;
    }
    if (ministres.length < G.MINISTRES) continue;
    const total = valeur(chef, ministres, annonces);
    if (!meilleur || total > meilleur.total) meilleur = {chef, ministres, total};
  }
  return meilleur;
}

// Gouvernement de vedettes : les plus hautes statures (chef compris), sans souci des thèmes ni des liens ; les places
// laissées par le plafond sont prises dans la collection d'appoint
function vedettes(cartes, appoint = []) {
  const tri = cartes.slice().sort((a, b) => b.stature - a.stature || b.annees - a.annees)
    .concat(appoint.slice().sort((a, b) => b.stature - a.stature));
  const chef = tri[0], ministres = []; let reste = G.PLAFOND_STATURE;
  for (const c of tri.slice(1)) {
    const places = G.MINISTRES - ministres.length - 1;
    if (ministres.length < G.MINISTRES && c.stature <= reste - places) { ministres.push(c); reste -= c.stature; }
  }
  return ministres.length === G.MINISTRES ? {chef, ministres} : null;
}

const stats = {manches: 0, egalitesForce: 0, egalitesCompletes: 0, departages: 0, avec493: 0};

// Choix d'un ministre pour une manche : gagner au moindre coût, sacrifier le moins utile si la manche est perdue
function choisir(camp, adverse, theme, restants) {
  const meilleurAdverse = Math.max(...adverse.dispo.map(i => G.force(adverse.ministres[i], theme, adverse.bonus[i])));
  const utilite = i => Math.max(0, ...restants.filter(t => t !== theme).map(t => G.force(camp.ministres[i], t, camp.bonus[i])));
  const options = camp.dispo.map(i => ({i, f: G.force(camp.ministres[i], theme, camp.bonus[i]), u: utilite(i)}));
  const gagnants = options.filter(o => o.f > meilleurAdverse).sort((a, b) => a.u - b.u);
  let choix, chef = null;
  if (gagnants.length) choix = gagnants[0];
  else {
    const proches = !camp.a493 && options.filter(o => o.f + camp.chef.stature > meilleurAdverse).sort((a, b) => a.u - b.u);
    if (proches && proches.length) { choix = proches[0]; chef = camp.chef; camp.a493 = true; }
    else choix = options.sort((a, b) => a.u - b.u)[0];
  }
  if (alea() < 0.15) choix = options[Math.floor(alea() * options.length)];  // part d'imprévu, comme un joueur
  return {i: choix.i, chef};
}

function partie(g1, g2, annonces) {
  const camps = [g1, g2].map(g => ({chef: g.chef, ministres: g.ministres, bonus: G.liens(g.chef, g.ministres).map(l => l.total),
                                     dispo: g.ministres.map((_, i) => i), a493: false}));
  const tirage = melanger(annonces).slice(0, G.MANCHES);
  let restants = annonces.slice(), score = [0, 0];
  for (const theme of tirage) {
    const c1 = choisir(camps[0], camps[1], theme, restants), c2 = choisir(camps[1], camps[0], theme, restants);
    const r = G.jugerManche(theme, {ministre: camps[0].ministres[c1.i], bonus: camps[0].bonus[c1.i], chef: c1.chef},
                                   {ministre: camps[1].ministres[c2.i], bonus: camps[1].bonus[c2.i], chef: c2.chef});
    stats.manches++;
    if (r.departage) stats.egalitesForce++;
    if (!r.gagnant) stats.egalitesCompletes++;
    if (c1.chef || c2.chef) stats.avec493++;
    if (r.gagnant) score[r.gagnant - 1]++;
    camps[0].dispo = camps[0].dispo.filter(i => i !== c1.i); camps[1].dispo = camps[1].dispo.filter(i => i !== c2.i);
    restants = restants.filter(t => t !== theme);
    if (score[0] >= G.VICTOIRE || score[1] >= G.VICTOIRE) break;
  }
  return score[0] > score[1] ? 1 : score[1] > score[0] ? 2 : 0;
}

const tirerAnnonces = () => melanger(themes.map((_, i) => i)).slice(0, G.ANNONCES);
function duel(nom, fabriqueA, fabriqueB) {
  let a = 0, b = 0, n = 0;
  for (let k = 0; k < PARTIES; k++) {
    const annonces = tirerAnnonces(), ga = fabriqueA(annonces), gb = fabriqueB(annonces);
    if (!ga || !gb) continue;
    const r = partie(ga, gb, annonces); n++;
    if (r === 1) a++; else if (r === 2) b++;
  }
  console.log(`${nom} : ${Math.round(100 * a / n)} % / ${Math.round(100 * b / n)} % (nuls ${Math.round(100 * (n - a - b) / n)} %, ${n} parties)`);
}

// 1. Spécialiste trois étoiles contre vedette sans spécialité, sur le thème du spécialiste, liens tirés de 0 à 3
{
  const toutes = [...fiches.values()];
  const vedettesSans = toutes.filter(f => f.stature === 5);
  let gagne = 0, n = 0;
  for (let k = 0; k < 20000; k++) {
    const t = Math.floor(alea() * themes.length);
    const specialistes = toutes.filter(f => f.etoiles.get(t) === 3);
    const v = vedettesSans.filter(f => !f.etoiles.get(t));
    if (!specialistes.length || !v.length) continue;
    const s = specialistes[Math.floor(alea() * specialistes.length)], w = v[Math.floor(alea() * v.length)];
    const r = G.jugerManche(t, {ministre: s, bonus: Math.floor(alea() * 4)}, {ministre: w, bonus: Math.floor(alea() * 4), chef: alea() < 1 / 7 ? {stature: 5} : null});
    n++; if (r.gagnant === 1) gagne++;
  }
  console.log(`Spécialiste 3★ contre vedette (stature 5, sans étoile) : ${Math.round(100 * gagne / n)} % (${n} manches)`);
}

// 2. Gouvernements de joueurs
const debutant = collection(60), regulier = collection(400), assidu = collection(1500);
const sansRares = assidu.filter(f => !["mythique", "legendaire", "unique", "hors-categorie"].includes(rarete.get(f.id)));
const rares = [...fiches.values()].filter(f => ["mythique", "legendaire", "unique"].includes(rarete.get(f.id)));
console.log(`Collections : débutant ${debutant.length}, régulier ${regulier.length}, assidu ${assidu.length}, assidu sans légendaires ni mythiques ${sansRares.length}`);
duel("Mythiques et légendaires (vedettes) contre assidu sans légendaires, cohérent", () => vedettes(rares, debutant), a => composer(sansRares, a));
duel("Mythiques et légendaires (composés, complétés) contre assidu sans légendaires, cohérent", a => composer(rares.concat(debutant), a), a => composer(sansRares, a));
duel("Assidu contre régulier", a => composer(assidu, a), a => composer(regulier, a));
duel("Régulier contre débutant", a => composer(regulier, a), a => composer(debutant, a));
duel("Assidu contre débutant", a => composer(assidu, a), a => composer(debutant, a));
duel("Régulier, cohérent contre régulier, sans liens", a => composer(regulier, a), a => composer(regulier, a, {coherence: false}));
console.log(`Manches : ${stats.manches} ; égalités de force ${(100 * stats.egalitesForce / stats.manches).toFixed(1)} % ; égalités après départage ${(100 * stats.egalitesCompletes / stats.manches).toFixed(1)} % ; 49.3 joué dans ${(100 * stats.avec493 / stats.manches).toFixed(1)} % des manches`);
