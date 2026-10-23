// Tests des règles du jeu, sans installation : node tests/regles.test.js
const assert = require("assert");
const R = require("../site/regles.js");
const d = require("../site/jeu.json");
const cartes = d.cartes.map(([id,nom,r,score,epoque,actuel,debut,fin,source,portrait,distinctions,chambres,sexe,fonctions,mandats,groupe,photo,assemblees]) =>
  ({id,nom,rarete:d.raretes[r],score,actuel:!!actuel,distinctions:distinctions||[],mandats:mandats||[],assemblees:assemblees||[]}));
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
console.log("tous les tests passent");
