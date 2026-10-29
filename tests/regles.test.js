// Tests des règles du jeu, sans installation : node tests/regles.test.js
const assert = require("assert");
const R = require("../site/regles.js");
const d = require("../site/jeu.json");
const cartes = R.cartesDeJeu(d);
const cat = R.catalogue(cartes, d.assemblees);

// Rareté unique : Charles de Gaulle seul, au-dessus de toutes, plus rare au tirage que n'importe quelle mythique
assert.deepStrictEqual(cat.parRarete.unique.map(c => c.nom), ["Charles de Gaulle"]);
assert.strictEqual(R.ORDRE[R.ORDRE.length - 1], "unique");
assert.ok(R.POIDS.unique < R.POIDS.mythique / cat.parRarete.mythique.length, "tirage d'une mythique donnée plus fréquent");
let graine = 42; const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647;

// Migration des versions précédentes : collection gardée, réserve pleine
const v1 = {possedees: {"2922": 3, "x": "abc"}, jour: "2026-10-23", ouverts: 2};
const e = R.migrer(v1);
assert.deepStrictEqual(e.possedees, {"2922": 3}); assert.strictEqual(e.version, 3);
assert.strictEqual(R.paquetsDisponibles(e).reserve, R.RESERVE_MAX);
assert.deepStrictEqual(R.migrer(null), R.etatVide());

// Réserve : pleine au départ, un paquet par intervalle (RECHARGE_MS), plafonnée à RESERVE_MAX ; l'intervalle entamé reste acquis
const H = R.RECHARGE_MS, t0 = Date.UTC(2026, 9, 24, 8, 0);
const s = R.etatVide();
for (let i = 0; i < R.RESERVE_MAX; i++) assert.strictEqual(R.ouvrirPaquet(s, cat, {maintenant: t0, aleatoire: alea}).origine, "reserve");
assert.strictEqual(R.ouvrirPaquet(s, cat, {maintenant: t0, aleatoire: alea}), null);
assert.strictEqual(R.paquetsDisponibles(s, t0).prochain, t0 + H);
assert.strictEqual(R.paquetsDisponibles(s, t0 + H - 1).reserve, 0);
assert.strictEqual(R.paquetsDisponibles(s, t0 + 2.5 * H).reserve, 2);
R.ouvrirPaquet(s, cat, {maintenant: t0 + 2.5 * H, aleatoire: alea});
assert.strictEqual(R.paquetsDisponibles(s, t0 + 2.5 * H).reserve, 1);
assert.strictEqual(R.paquetsDisponibles(s, t0 + 3 * H).reserve, 2, "la demi-heure entamée compte toujours");
assert.strictEqual(R.paquetsDisponibles(s, t0 + 100 * H).reserve, R.RESERVE_MAX, "plafond");
// Réserve vide : les paquets offerts prennent le relais
const s2 = R.etatVide(); s2.reserve = 0; s2.ancre = t0; s2.offerts = 1;
assert.strictEqual(R.ouvrirPaquet(s2, cat, {maintenant: t0, aleatoire: alea}).origine, "offert");
assert.strictEqual(s2.offerts, 0);
const p = R.ouvrirPaquet(s, cat, {maintenant: t0 + 100 * H, aleatoire: alea});
assert.strictEqual(p.tirage.length, 5); assert.ok(p.tirage.some(c => c.actuel));
assert.strictEqual(Object.values(s.possedees).reduce((a, b) => a + b, 0), (R.RESERVE_MAX + 2) * R.CARTES_PAR_PAQUET);

// Recyclage : garde un exemplaire, points selon la rareté, raretés non choisies intactes
const r = R.etatVide();
const com = cat.parRarete["commune"][0], myth = cat.parRarete["mythique"][0];
r.possedees[com.id] = 4; r.possedees[myth.id] = 2;
assert.deepStrictEqual(R.doubles(r, cat).commune, {cartes: 1, exemplaires: 3, points: 3});
assert.deepStrictEqual(R.recycler(r, cat, ["commune"]), {exemplaires: 3, points: 3});
assert.strictEqual(r.possedees[com.id], 1); assert.strictEqual(r.possedees[myth.id], 2);
assert.deepStrictEqual(R.recycler(r, cat, ["commune"]), {exemplaires: 0, points: 0});
R.recycler(r, cat, ["mythique"]); assert.strictEqual(r.points, 103);
assert.ok(R.echangerPoints(r)); assert.strictEqual(r.points, 78); assert.strictEqual(r.offerts, 1);
r.points = 24; assert.ok(!R.echangerPoints(r)); assert.strictEqual(r.offerts, 1);

// Un paquet de doubles ne rend en moyenne pas plus d'un paquet
const moyenne = Object.entries(R.POIDS).reduce((a, [k, w]) => a + w * R.VALEUR_RECYCLAGE[k], 0) / Object.values(R.POIDS).reduce((a, b) => a + b, 0);
console.log("points moyens par paquet de doubles :", (moyenne * R.CARTES_PAR_PAQUET).toFixed(1), "pour un prix de", R.PRIX_PAQUET);
assert.ok(moyenne * R.CARTES_PAR_PAQUET < R.PRIX_PAQUET);

// Objectifs
const qv = cat.objectifParId["quatre-vingts"];
assert.strictEqual(qv.total, 70); assert.deepStrictEqual(qv.paliers, [[1,1],[5,1],[15,2],[70,5]]);
const o = R.etatVide();
qv.ids.slice(0, 5).forEach(id => o.possedees[id] = 1);
assert.strictEqual(R.avancement(o, qv).aReclamer.length, 2);
assert.deepStrictEqual(R.reclamer(o, cat, "quatre-vingts"), {paquets: 2, voix: 0});
assert.deepStrictEqual(R.reclamer(o, cat, "quatre-vingts"), {paquets: 0, voix: 0});
assert.strictEqual(o.offerts, 2);
qv.ids.forEach(id => o.possedees[id] = 1);
assert.deepStrictEqual(R.reclamer(o, cat, "quatre-vingts"), {paquets: 7, voix: 0});
assert.ok(o.objectifs["quatre-vingts@complet"]);
const fams = {}; cat.objectifs.forEach(x => fams[x.famille] = (fams[x.famille] || 0) + 1);
console.log("objectifs par famille :", fams);
const xvii = cat.objectifs.find(x => x.titre.startsWith("XVIIe législature"));
console.log(xvii.id, xvii.total, JSON.stringify(xvii.paliers), "|", cat.objectifParId["departement:gironde"].total, JSON.stringify(cat.objectifParId["departement:gironde"].paliers));
// Catalogue du serveur : mêmes cartes, mêmes objectifs que le catalogue complet
const compact = R.catalogueCompact(JSON.parse(JSON.stringify(R.compacter(cat))));
assert.strictEqual(compact.cartes.length, cat.cartes.length);
assert.deepStrictEqual(compact.objectifs.map(o => [o.id, o.total, o.paliers]), cat.objectifs.map(o => [o.id, o.total, o.paliers]));
assert.deepStrictEqual(Object.keys(compact.parRarete).sort(), Object.keys(cat.parRarete).sort());

// Exemplaires verrouillés (repris ou en vente) : ni recyclés ni comptés comme doubles
const v = R.etatVide();
v.possedees[com.id] = 3; v.verrous = {[com.id]: 2};
assert.strictEqual(R.disponibles(v, com.id), 1); assert.strictEqual(R.recyclables(v, com.id), 1);
assert.deepStrictEqual(R.recycler(v, cat, ["commune"]), {exemplaires: 1, points: 1});
assert.strictEqual(v.possedees[com.id], 2);
v.verrous = {[com.id]: 2}; assert.strictEqual(R.recyclables(v, com.id), 0);

// Jour du jeu : date de Paris ; l'ancien format est complété
assert.strictEqual(R.jourDuJeu(new Date("2026-10-23T22:30:00Z")), "2026-10-24");
// Premiers pas : une carte suffit, un paquet, une seule fois ; taille de l'hémicycle par paliers
const pg = cat.objectifParId["premier:gouvernement"];
assert.deepStrictEqual(pg.paliers, [[1, 10, "voix"]]);
const pp = R.etatVide(); pp.possedees[pg.ids[0]] = 1;
assert.deepStrictEqual(R.reclamer(pp, cat, "premier:gouvernement"), {paquets: 0, voix: 10}, "tâche simple : des voix");
assert.deepStrictEqual(R.reclamer(pp, cat, "premier:gouvernement"), {paquets: 0, voix: 0});
const hem = cat.objectifParId["hemicycle"];
assert.strictEqual(hem.total, cat.cartes.length); assert.deepStrictEqual(hem.paliers.slice(0, 3), [[10, 10, "voix"], [25, 15, "voix"], [50, 20, "voix"]]);
cat.cartes.slice(0, 10).forEach(c => pp.possedees[c.id] = 1);
assert.deepStrictEqual(R.reclamer(pp, cat, "hemicycle"), {paquets: 0, voix: 10});
// Catalogue du serveur : membres en plages, décodés à la demande, identiques au catalogue complet
assert.deepStrictEqual(compact.objectifParId["premier:elue"].ids, cat.objectifParId["premier:elue"].ids);
// Questions au Gouvernement : même graine, mêmes questions ; une bonne réponse par question, jamais deux
const qa = R.questions(cat, 1234), qb = R.questions(cat, 1234);
assert.deepStrictEqual(qa, qb); assert.strictEqual(qa.length, R.QUIZ_QUESTIONS);
for (const q of qa) {
  assert.strictEqual(new Set(q.choix).size, 4); assert.ok(q.bonne >= 0 && q.bonne < 4);
  const c = cat.parId[q.carte];
  if (q.texte.startsWith("Dans quel département")) for (const [k, x] of q.choix.entries()) if (k !== q.bonne) assert.ok(!c.mandats.some(m => m[1] === x));
}
const quizEtat = R.etatVide();
assert.strictEqual(R.validerQuiz(quizEtat, "2026-10-24", 5), 15);
assert.strictEqual(R.validerQuiz(quizEtat, "2026-10-24", 5), 0, "une fois par jour");
assert.strictEqual(R.validerQuiz(quizEtat, "2026-10-25", 3), 6);
assert.strictEqual(R.validerQuiz(quizEtat, "2026-10-26", 99), 15, "plafonné");
assert.strictEqual(quizEtat.points, 36);
// Économie : un premier jour de 24 paquets, avec toutes les récompenses réclamées en cascade et tous les doubles
// dissous, ne doit pas emballer la collection (avant correction des paliers : la moitié des cartes en un jour)
{
  let g = 99; const al = () => (g = (g * 1664525 + 1013904223) >>> 0) / 4294967296;
  const j = R.etatVide(); let n = 24, ouverts = 0;
  while (n > 0 && ouverts < 2000) {
    for (let i = 0; i < n; i++) { j.offerts = 1; j.reserve = 0; j.ancre = Date.now(); R.ouvrirPaquet(j, cat, {aleatoire: al}); ouverts += 1; }
    n = 0; for (const o of cat.objectifs) n += R.reclamer(j, cat, o.id).paquets;
    j.offerts = 0; R.recycler(j, cat, R.ORDRE); while (j.points >= R.PRIX_PAQUET) { j.points -= R.PRIX_PAQUET; n += 1; }
  }
  console.log("premier jour en cascade :", ouverts, "paquets ouverts,", Object.keys(j.possedees).length, "cartes");
  assert.ok(ouverts < 60, "les récompenses ne doivent pas s'auto-entretenir");
}
// Reprise côté serveur : les paliers atteints comptés sur les plages, identiques au calcul complet
{
  const col = {}; cat.cartes.filter((c, i) => i % 37 === 0).forEach(c => col[c.id] = 1);
  const e2 = R.etatVide(); e2.possedees = col;
  const attendu = cat.objectifs.flatMap(o => R.avancement(e2, o).aReclamer.map(x => x.cle)).sort();
  assert.deepStrictEqual(R.clesAtteintes(compact, col).sort(), attendu);
}
// Dissolution d'une seule carte : un exemplaire reste, et jamais moins que les exemplaires verrouillés
{
  const e3 = R.etatVide(), c = cat.parRarete.rare[0];
  e3.possedees[c.id] = 4; e3.verrous = {[c.id]: 1};
  assert.deepStrictEqual(R.dissoudre(e3, cat, c.id), {exemplaires: 3, points: 3 * R.VALEUR_RECYCLAGE.rare});
  assert.strictEqual(e3.possedees[c.id], 1);
  assert.deepStrictEqual(R.dissoudre(e3, cat, c.id), {exemplaires: 0, points: 0});
}
// Sélection de l'hémicycle : doubles seuls en gardant un exemplaire ; sinon tout ce qui est libre, verrous respectés
{
  const e4 = R.etatVide(), [a, b] = cat.parRarete.commune, r = cat.parRarete.rare[1];
  e4.possedees = {[a.id]: 3, [b.id]: 1, [r.id]: 2}; e4.verrous = {[r.id]: 1};
  // La rare a un exemplaire au comptoir : son double libre se dissout, l'exemplaire réservé reste
  assert.deepStrictEqual(R.dissoudreSelection(e4, cat, [a.id, b.id, r.id, a.id, "inconnue"], true), {cartes: 2, exemplaires: 3, points: 2 + R.VALEUR_RECYCLAGE.rare});
  assert.deepStrictEqual(e4.possedees, {[a.id]: 1, [b.id]: 1, [r.id]: 1});
  assert.deepStrictEqual(R.dissoudreSelection(e4, cat, [a.id, b.id, r.id], false), {cartes: 2, exemplaires: 2, points: 2});
  assert.deepStrictEqual(e4.possedees, {[a.id]: 0, [b.id]: 0, [r.id]: 1}, "l'exemplaire au comptoir reste");
  assert.strictEqual(e4.points, 4 + R.VALEUR_RECYCLAGE.rare);
  assert.strictEqual(e4.journal.length, 2, "une ligne de journal par sélection");
}
// Cartes gardées : leurs doubles ne sont ni comptés ni dissous par rareté ; la dissolution carte par carte reste possible
{
  const e5 = R.etatVide(), [a, b] = cat.parRarete.commune;
  e5.possedees = {[a.id]: 3, [b.id]: 2};
  assert.deepStrictEqual(R.garderCartes(e5, [a.id], true), [String(a.id)]);
  assert.strictEqual(R.doubles(e5, cat).commune.exemplaires, 1);
  assert.deepStrictEqual(R.recycler(e5, cat, ["commune"]), {exemplaires: 1, points: 1});
  assert.strictEqual(e5.possedees[a.id], 3, "carte gardée intacte");
  assert.strictEqual(R.dissoudre(e5, cat, a.id).exemplaires, 2, "dissolution choisie carte par carte");
  assert.deepStrictEqual(R.garderCartes(e5, [a.id], false), []);
  assert.deepStrictEqual(R.migrer({possedees: {}, gardes: [a.id, a.id, 5]}).gardes, [String(a.id), "5"]);
}
// Commissions permanentes (scripts/commissions.py) : lues par cartesDeJeu, chambre, familles et années
{
  const avec = cartes.filter(c => c.commissions.length);
  assert.ok(avec.length > 3000, "cartes avec commissions : " + avec.length);
  for (const c of avec.slice(0, 200)) for (const x of c.commissions) {
    assert.ok(x.intitule && ["A", "S"].includes(x.chambre) && Array.isArray(x.familles) && x.debut >= 1959, JSON.stringify(x));
    assert.ok(x.fin === null || x.fin >= x.debut);
  }
  assert.ok(avec.some(c => c.commissions.some(x => x.familles.includes("lois"))));
}
// Duels jugés par le serveur : ses données réduites (compacterQuiz, relu par catalogueQuiz) donnent les mêmes questions
{
  const q = R.catalogueQuiz(JSON.parse(JSON.stringify(R.compacterQuiz(cat))));
  for (const g of [1, 42, 123456789, 4294967295]) assert.deepStrictEqual(R.questions(q, g), R.questions(cat, g), "questions du serveur, graine " + g);
}
console.log("tous les tests passent");

// Doubles réduits : jamais deux fois la même carte dans un paquet ; environ 10 % de doubles du 701e au 1 500e paquet
{
  const e = R.etatVide(); let doubles = 0, cartesTirees = 0;
  for (let k = 1; k <= 1500; k++) {
    e.reserve = 10; e.ancre = Date.now();
    const avant = {...e.possedees}, r = R.ouvrirPaquet(e, cat, {aleatoire: alea});
    assert.strictEqual(new Set(r.tirage.map(c => c.id)).size, r.tirage.length, "même carte deux fois dans un paquet");
    if (k > 700) { doubles += r.tirage.filter(c => avant[c.id]).length; cartesTirees += r.tirage.length; }
  }
  const part = doubles / cartesTirees;
  assert.ok(part > 0.07 && part < 0.13, "doubles du 701e au 1 500e paquet : " + (100 * part).toFixed(1) + " %");
}

// Série de connexion : un lot par jour, sept lots, un jour manqué fait redescendre d'un palier ; lots « choix »
{
  const e = R.etatVide(), j = k => new Date(Date.UTC(2026, 10, 1 + k, 12)).toISOString().slice(0, 10);
  assert.deepStrictEqual(R.reclamerSerie(e, cat, j(0), alea), {voix: 10, paquets: 0, choix: null});
  assert.strictEqual(R.reclamerSerie(e, cat, j(0), alea), null, "une fois par jour");
  const g = R.reclamerSerie(e, cat, j(1), alea);
  assert.strictEqual(g.choix.length, 3); assert.ok(g.choix.every(id => cat.parId[id].rarete === "commune" && !e.possedees[id]));
  assert.strictEqual(R.reclamerSerie(e, cat, j(2), alea), null, "lot à choisir d'abord");
  assert.strictEqual(R.choisirLot(e, cat, "inconnue"), null);
  assert.deepStrictEqual(R.choisirLot(e, cat, g.choix[1]), {carte: g.choix[1]}); assert.strictEqual(e.possedees[g.choix[1]], 1);
  assert.strictEqual(R.reclamerSerie(e, cat, j(2), alea).paquets, 1, "jour 3");
  assert.strictEqual(R.serieDuJour(e, j(4)).rang, 2, "un jour manqué : un palier de moins que le dernier reçu");
  // Sept jours d'affilée : 35 voix, 3 paquets et trois cartes choisies, dont une épique proposée le septième jour
  const f = R.etatVide();
  for (let k = 0; k < 7; k++) { const r = R.reclamerSerie(f, cat, j(k), alea); if (r.choix) {
    if (k === 6) assert.ok(r.choix.some(id => cat.parId[id].rarete === "epique") && r.choix.length === 5);
    R.choisirLot(f, cat, r.choix[0]); } }
  assert.strictEqual(f.points, 35); assert.strictEqual(f.offerts, 3); assert.strictEqual(Object.keys(f.possedees).length, 3);
  assert.strictEqual(R.serieDuJour(f, j(7)).rang, 1, "après le septième jour, le premier");
}
// Objectifs du jour : mêmes pour tous, tâches comptées par les opérations, carte recherchée par thème, une fois chacun
{
  const jour = R.jourDuJeu(), e = R.etatVide();
  R.preparerJour(e, cat, jour);
  let d = R.etatDuJour(e, cat, jour);
  assert.strictEqual(d.objectifs.length, 3); assert.ok(d.objectifs.every(o => !o.fait));
  for (let k = 0; k < 8; k++) { e.reserve = 10; e.ancre = Date.now(); R.ouvrirPaquet(e, cat, {aleatoire: alea}); }
  e.quiz = jour; e.quotidien.compteurs.dissous = 5; e.quotidien.compteurs.objectifs = 1;
  d = R.etatDuJour(e, cat, jour);
  assert.ok(d.objectifs.slice(0, 2).every(o => o.fait), "deux tâches faites");
  for (const o of d.objectifs.filter(x => x.fait)) assert.ok(R.reclamerJour(e, cat, jour, o.cle));
  assert.strictEqual(R.reclamerJour(e, cat, jour, d.objectifs[0].cle), null, "une fois");
  assert.deepStrictEqual(R.objectifsDuJour(cat, jour).taches.map(t => t.cle), R.objectifsDuJour(R.catalogueCompact(require("../site/serveur.json")), jour).taches.map(t => t.cle));
}
console.log("série et objectifs du jour : tests passés");
// Jeu du Gouvernement : fiches (scripts/fiches_gouvernement.py) et règles partagées (site/gouvernement.js)
{
  const G = require("../site/gouvernement.js"), {fiches, themes} = G.fichesDeJeu(require("../site/gouvernement.json"));
  assert.strictEqual(themes.length, 50, "34 politiques publiques et 16 territoires");
  assert.ok(fiches.size >= 19000);
  const t = code => themes.findIndex(x => x[0] === code);
  const drian = fiches.get("7570");
  assert.strictEqual(drian.etoiles.get(t("diplomatie")), 3, "ministre des affaires étrangères");
  assert.strictEqual(drian.etoiles.get(t("defense")), 3);
  assert.ok(drian.etoiles.get(t("bretagne")) >= 1, "élu du Morbihan");
  assert.strictEqual(fiches.get("S86034E").etoiles.get(t("parlement")), 3, "président du Sénat");
  assert.ok([...fiches.values()].every(f => f.stature >= 1 && f.stature <= 5));
  // Force, plafond, liens et départage
  const f = (id, stature, etoiles = {}, extra = {}) => ({id, stature, etoiles: new Map(Object.entries(etoiles).map(([k, v]) => [Number(k), v])),
                                                       annees: 0, groupe: -1, deps: [], gouv: [], chefs: [], ...extra});
  const chef = f("c", 5, {}, {groupe: 1, chefs: [["2000-01-01", "2002-01-01"]]});
  const ministres = [1, 2, 3, 4, 5, 6, 7, 8].map(i => f("m" + i, 3, {}, {deps: [i]}));
  assert.strictEqual(G.verifierGouvernement(chef, ministres), null, "24 de stature");
  assert.ok(G.verifierGouvernement(chef, [...ministres.slice(1), f("x", 4)]), "25 : refusé");
  assert.ok(G.verifierGouvernement(chef, [...ministres.slice(1), ministres[1]]), "deux fois la même carte");
  ministres[0].deps = [2]; ministres[0].groupe = 1; ministres[0].gouv = [["2001-01-01", "2001-06-01"]]; ministres[2].gouv = [["2001-05-01", null]];
  const l = G.liens(chef, ministres);
  assert.deepStrictEqual(l[0].detail, {departement: true, groupe: true, solidarite: true, sousLeChef: true});
  assert.strictEqual(l[0].total, G.LIENS_MAX, "liens plafonnés");
  assert.strictEqual(l[1].total, 1, "même département que le premier");
  assert.strictEqual(l[3].total, 0);
  const sp = f("s", 2, {0: 3}), vedette = f("v", 5);
  assert.strictEqual(G.jugerManche(0, {ministre: sp, bonus: 0}, {ministre: vedette, bonus: 0}).gagnant, 1, "le spécialiste");
  assert.strictEqual(G.jugerManche(1, {ministre: sp, bonus: 0}, {ministre: vedette, bonus: 0}).gagnant, 2, "hors de son domaine");
  assert.strictEqual(G.jugerManche(1, {ministre: sp, bonus: 3, chef}, {ministre: vedette, bonus: 0}).gagnant, 1, "49.3");
  const r = G.jugerManche(1, {ministre: f("a", 3, {}, {annees: 10}), bonus: 0}, {ministre: f("b", 3, {}, {annees: 4}), bonus: 0});
  assert.deepStrictEqual([r.gagnant, r.departage], [1, "annees"]);
}
console.log("jeu du Gouvernement : tests passés");
// Partie du Gouvernement : thèmes cachés, coups validés, ordinateur, série
{
  const G = require("../site/gouvernement.js"), {fiches, themes} = G.fichesDeJeu(require("../site/gouvernement.json"));
  let s = 7; const alea = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const annonces = G.annoncesDePartie(42, themes.length);
  assert.strictEqual(annonces.length, G.ANNONCES); assert.strictEqual(new Set(annonces).size, G.ANNONCES);
  assert.deepStrictEqual(annonces, G.annoncesDePartie(42, themes.length), "même graine, mêmes annonces");
  const reels = G.gouvernementsReels(fiches);
  const g1 = G.gouvernementOrdinateur(reels, annonces, alea, 5), g2 = G.gouvernementOrdinateur(reels, annonces, alea, 0);
  for (const g of [g1, g2]) assert.strictEqual(G.verifierGouvernement(fiches.get(g.chef), g.ministres.map(id => fiches.get(id))), null, "gouvernement de l'ordinateur valable");
  assert.ok(fiches.get(g1.chef).chefs.length, "un chef du Gouvernement réel");
  const p = {graine: 42, annonces, camps: [g1, g2], coups: [[], []]};
  assert.strictEqual(G.jouerCoup(p, 0, 9, false, fiches), "Ministre inconnu.");
  assert.strictEqual(G.jouerCoup(p, 0, 0, true, fiches), null);
  assert.strictEqual(G.jouerCoup(p, 0, 1, false, fiches), "Attendez le coup de votre adversaire.");
  let v = G.vuePartie(p, 1, fiches);
  assert.ok(annonces.includes(v.theme)); assert.strictEqual(v.attente, null); assert.strictEqual(v.manches.length, 0, "rien de révélé tant que l'adversaire n'a pas joué");
  assert.strictEqual(G.jouerCoup(p, 1, 3, false, fiches), null);
  assert.strictEqual(G.jouerCoup(p, 0, 0, false, fiches), "Ce ministre a déjà siégé.");
  assert.strictEqual(G.jouerCoup(p, 0, 1, true, fiches), "Le 49.3 a déjà servi.");
  let e = G.resoudre(p, fiches);
  while (!e.fini) {
    for (const k of [0, 1]) { const c = G.choixOrdinateur(p, k, fiches, alea, 3); assert.strictEqual(G.jouerCoup(p, k, c.ministre, c.avec493, fiches), null); }
    e = G.resoudre(p, fiches);
  }
  assert.ok(e.manches.length >= G.VICTOIRE && e.manches.length <= G.MANCHES);
  assert.strictEqual(new Set(e.manches.map(m => m.theme)).size, e.manches.length, "sept thèmes différents au plus");
  assert.ok(e.manches.every(m => annonces.includes(m.theme)));
  v = G.vuePartie(p, 0, fiches);
  assert.ok(v.fini && ["gagne", "perdu", "egalite"].includes(v.issue));
  assert.strictEqual(G.jouerCoup(p, 0, 7, false, fiches), "La partie est terminée.");
  // Expiration : la manche jouée d'un seul côté lui revient, et la partie s'arrête
  const q = {graine: 3, annonces, camps: [g1, g2], coups: [[[0, 0]], []]};
  const x = G.resoudre(q, fiches, {expire: true});
  assert.deepStrictEqual([x.fini, x.score, x.gagnant], [true, [1, 0], 1]);
  // Série : récompense encaissée à la fin, tout perdu à la défaite, complète au cinquième palier
  const es = R.etatVide(), jour = "2026-10-29", cg = R.catalogue(R.cartesDeJeu(require("../site/jeu.json")), []);
  assert.strictEqual(R.encaisserSerieGouv(es, cg, jour, alea), null, "rien à encaisser");
  R.issueSerieGouv(es, cg, "gagne", jour, alea); R.issueSerieGouv(es, cg, "gagne", jour, alea);
  assert.strictEqual(R.serieGouv(es, jour).serie, 2);
  assert.deepStrictEqual(R.issueSerieGouv(es, cg, "perdu", jour, alea), {serie: 0, perdue: 2, gain: null}, "la défaite fait tout perdre");
  for (let k = 0; k < 3; k++) R.issueSerieGouv(es, cg, "gagne", jour, alea);
  R.issueSerieGouv(es, cg, "egalite", jour, alea);
  assert.strictEqual(R.serieGouv(es, jour).serie, 3, "un nul ne change rien");
  const g3 = R.encaisserSerieGouv(es, cg, jour, alea);
  assert.strictEqual(g3.palier, 3); assert.strictEqual(g3.choix.length, 3);
  assert.ok(g3.choix.every(id => ["rare", "epique", "legendaire", "mythique"].includes(cg.parId[id].rarete)));
  assert.strictEqual(R.serieGouv(es, jour).serie, 0, "la série repart de zéro");
  assert.strictEqual(R.choisirLotGouv(es, cg, "inconnue"), null);
  assert.deepStrictEqual(R.choisirLotGouv(es, cg, g3.choix[1]), {carte: g3.choix[1]}); assert.strictEqual(es.possedees[g3.choix[1]], 1);
  let fin;
  for (let k = 0; k < 5; k++) fin = R.issueSerieGouv(es, cg, "gagne", jour, alea);
  assert.strictEqual(fin.gain.palier, 5, "complète : encaissée d'elle-même"); assert.strictEqual(fin.gain.paquets, 2);
  assert.ok(fin.gain.choix.every(id => ["legendaire", "mythique"].includes(cg.parId[id].rarete)));
  R.choisirLotGouv(es, cg, fin.gain.choix[0]);
  R.issueSerieGouv(es, cg, "gagne", jour, alea); assert.ok(R.encaisserSerieGouv(es, cg, jour, alea), "troisième encaissement");
  R.issueSerieGouv(es, cg, "gagne", jour, alea);
  assert.strictEqual(R.encaisserSerieGouv(es, cg, jour, alea), null, `${R.ENCAISSEMENTS_JOUR} encaissements par jour`);
  assert.ok(R.encaisserSerieGouv(es, cg, "2026-10-30", alea), "le lendemain");
}
console.log("partie du Gouvernement : tests passés");
