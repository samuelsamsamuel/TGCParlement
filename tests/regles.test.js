// Tests des règles du jeu, sans installation : node tests/regles.test.js
const assert = require("assert");
const R = require("../site/regles.js");
const d = require("../site/jeu.json");
const cartes = R.cartesDeJeu(d);
const cat = R.catalogue(cartes, d.assemblees);
let graine = 42; const alea = () => (graine = (graine * 16807) % 2147483647) / 2147483647;

// Migration de l'état v1
const v1 = {possedees: {"2922": 3, "x": "abc"}, jour: "2026-10-23", ouverts: 2};
const e = R.migrer(v1);
assert.deepStrictEqual(e.possedees, {"2922": 3}); assert.strictEqual(e.version, 2); assert.strictEqual(e.ouverts, 2);
assert.deepStrictEqual(R.migrer(null), R.etatVide());

// Paquets : trois du jour, puis les offerts, puis plus rien
const s = R.etatVide();
for (let i = 0; i < 3; i++) assert.strictEqual(R.ouvrirPaquet(s, cat, {jour: "J1", aleatoire: alea}).origine, "jour");
assert.strictEqual(R.ouvrirPaquet(s, cat, {jour: "J1", aleatoire: alea}), null);
s.offerts = 1;
assert.strictEqual(R.ouvrirPaquet(s, cat, {jour: "J1", aleatoire: alea}).origine, "offert");
assert.strictEqual(s.offerts, 0);
assert.strictEqual(R.paquetsDisponibles(s, "J2").duJour, 3);
const p = R.ouvrirPaquet(s, cat, {jour: "J2", aleatoire: alea});
assert.strictEqual(p.tirage.length, 5); assert.ok(p.tirage.some(c => c.actuel));
assert.strictEqual(Object.values(s.possedees).reduce((a, b) => a + b, 0), 25);

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
assert.strictEqual(qv.total, 70); assert.deepStrictEqual(qv.paliers, [[1,1],[5,2],[15,3],[70,5]]);
const o = R.etatVide();
qv.ids.slice(0, 5).forEach(id => o.possedees[id] = 1);
assert.strictEqual(R.avancement(o, qv).aReclamer.length, 2);
assert.strictEqual(R.reclamer(o, cat, "quatre-vingts"), 3);
assert.strictEqual(R.reclamer(o, cat, "quatre-vingts"), 0);
assert.strictEqual(o.offerts, 3);
qv.ids.forEach(id => o.possedees[id] = 1);
assert.strictEqual(R.reclamer(o, cat, "quatre-vingts"), 8);
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
assert.strictEqual(R.migrer({possedees: {}, jour: "2026-1-5"}).jour, "2026-01-05");
// Premiers pas : une carte suffit, un paquet, une seule fois ; taille de l'hémicycle par paliers
const pg = cat.objectifParId["premier:gouvernement"];
assert.deepStrictEqual(pg.paliers, [[1, 1]]);
const pp = R.etatVide(); pp.possedees[pg.ids[0]] = 1;
assert.strictEqual(R.reclamer(pp, cat, "premier:gouvernement"), 1);
assert.strictEqual(R.reclamer(pp, cat, "premier:gouvernement"), 0);
const hem = cat.objectifParId["hemicycle"];
assert.strictEqual(hem.total, cat.cartes.length); assert.deepStrictEqual(hem.paliers.slice(0, 2), [[10, 1], [25, 1]]);
cat.cartes.slice(0, 10).forEach(c => pp.possedees[c.id] = 1);
assert.strictEqual(R.reclamer(pp, cat, "hemicycle"), 1);
// Catalogue du serveur : membres en plages, décodés à la demande, identiques au catalogue complet
assert.deepStrictEqual(compact.objectifParId["premier:elue"].ids, cat.objectifParId["premier:elue"].ids);
console.log("tous les tests passent");
