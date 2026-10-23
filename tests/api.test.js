/* Test de l'API sur un serveur local, à lancer depuis la racine du dépôt :
     npx wrangler dev --port 8787 --persist-to /tmp/hemicycle-d1     (dans un premier terminal)
     WR="npx wrangler" ETAT=/tmp/hemicycle-d1 node tests/api.test.js   (dans un second)
   Il crée trois joueurs et vérifie inscription avec reprise, paquets, recyclage, marché et échanges,
   y compris des demandes simultanées (une seule doit aboutir). */
const assert = require("assert");
const R = require("../site/regles.js");
const cat = R.catalogueCompact(require("../site/serveur.json"));
const B = "http://localhost:8787/api/";
let ip = 0;
function client(){
  let cookie = "";
  const a = async (chemin, corps, entetes = {}) => {
    const o = corps === undefined ? {headers: {cookie, ...entetes}} : {method: "POST", headers: {cookie, "content-type": "application/json", "x-hemicycle": "1", ...entetes}, body: JSON.stringify(corps)};
    const r = await fetch(B + chemin, o);
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return {statut: r.status, d: await r.json()};
  };
  return a;
}
const preuve = c => require("crypto").createHash("sha256").update(c).digest("hex");
(async () => {
  const suffixe = Date.now().toString(36).slice(-5);
  const A = client(), Bc = client(), C = client();
  // Inscription avec reprise : deux exemplaires d'une commune, un Quatre-vingts
  const com = cat.parRarete.commune[0].id, qv = cat.objectifParId["quatre-vingts"].ids[0];
  let r = await A("inscription", {pseudo: "alice" + suffixe, preuve: preuve("a"), collection: {[com]: 2, [qv]: 1, "inconnue": 5}}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
  assert.deepStrictEqual(r.d.etat.possedees, {[com]: 2, [qv]: 1});
  assert.strictEqual(r.d.etat.verrous[com], 2);
  assert.ok(r.d.etat.objectifs["quatre-vingts@1"], "palier déjà atteint marqué réclamé");
  assert.strictEqual(R.recompensesEnAttente(r.d.etat, cat), 0);
  // Pseudo pris (casse comprise), mauvais mot de passe
  r = await C("inscription", {pseudo: "ALICE" + suffixe, preuve: preuve("x")}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 409);
  r = await C("connexion", {pseudo: "alice" + suffixe, preuve: preuve("faux")});
  assert.strictEqual(r.statut, 401);
  // Recyclage : les exemplaires repris ne se recyclent pas
  r = await A("recycler", {raretes: ["commune"]});
  assert.deepStrictEqual(r.d.resultat, {exemplaires: 0, points: 0});
  // Paquets : trois du jour, le quatrième refusé ; deux ouvertures simultanées n'en donnent pas plus
  const ouvertures = await Promise.all([A("paquet", {}), A("paquet", {}), A("paquet", {}), A("paquet", {})]);
  const reussies = ouvertures.filter(x => x.statut === 200).length;
  console.log("ouvertures simultanées réussies :", reussies, "sur 4 ;", ouvertures.map(x => x.statut).join(","));
  assert.ok(reussies <= 3);
  for (let i = reussies; i < 3; i++) assert.strictEqual((await A("paquet", {})).statut, 200);
  r = await A("paquet", {});
  assert.strictEqual(r.statut, 409);
  r = await A("moi");
  assert.strictEqual(r.d.etat.ouverts, 3);
  const total = Object.values(r.d.etat.possedees).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 3 + 15);
  // Bob : compte sans reprise
  r = await Bc("inscription", {pseudo: "bob" + suffixe, preuve: preuve("b")}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201);
  r = await Bc("paquet", {}); assert.strictEqual(r.statut, 200);
  const carteBob = r.d.resultat.tirage[0];
  // Alice vend une carte libre tirée d'un paquet ; la carte reprise ne peut pas être vendue
  const etatA = (await A("moi")).d.etat;
  const libreA = Object.keys(etatA.possedees).find(id => R.disponibles(etatA, id) > 0);
  assert.strictEqual((await A("annonces", {carte: com, prix: 5})).statut, 409);
  r = await A("annonces", {carte: libreA, prix: 7}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
  const e2 = (await A("moi")).d.etat;
  assert.strictEqual(R.disponibles(e2, libreA), R.disponibles(etatA, libreA) - 1, "exemplaire réservé");
  const annonce = (await A("annonces")).d.annonces.find(a => a.statut === "ouverte").id;
  // Bob n'a pas de points : achat refusé, rien ne bouge
  r = await Bc("annonces/" + annonce + "/acheter", {}); assert.strictEqual(r.statut, 409);
  assert.strictEqual((await A("annonces")).d.annonces.find(a => a.id === annonce).statut, "ouverte");
  // On crédite Bob et Carole de points directement en base, puis achat simultané : un seul réussit
  r = await C("inscription", {pseudo: "carole" + suffixe, preuve: preuve("c")}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  require("child_process").execSync(`${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "UPDATE joueurs SET points = 50 WHERE pseudo IN ('bob${suffixe}', 'carole${suffixe}')"`, {stdio: "ignore"});
  const achats = await Promise.all([Bc("annonces/" + annonce + "/acheter", {}), C("annonces/" + annonce + "/acheter", {})]);
  console.log("achats simultanés :", achats.map(x => x.statut).join(","));
  assert.strictEqual(achats.filter(x => x.statut === 200).length, 1);
  const pointsBob = (await Bc("moi")).d.etat.points, pointsCarole = (await C("moi")).d.etat.points;
  assert.strictEqual(pointsBob + pointsCarole, 93);
  assert.strictEqual((await A("moi")).d.etat.points, 7);
  // Échange : Alice demande la carte de Bob contre une de ses cartes libres
  const e3 = (await A("moi")).d.etat;
  const donneA = Object.keys(e3.possedees).find(id => R.disponibles(e3, id) > 0);
  const vue = (await A("joueurs/bob" + suffixe)).d;
  assert.ok(vue.libres[carteBob] >= 1);
  r = await A("echanges", {vers: "bob" + suffixe, donne: {[donneA]: 1}, recoit: {[carteBob]: 1}});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
  const ech = (await Bc("echanges")).d.echanges[0];
  assert.ok(ech.recu);
  assert.strictEqual((await A("echanges/" + ech.id + "/accepter", {})).statut, 403, "seul le destinataire accepte");
  const avantA = (await A("moi")).d.etat.possedees, avantB = (await Bc("moi")).d.etat.possedees;
  const acc = await Promise.all([Bc("echanges/" + ech.id + "/accepter", {}), Bc("echanges/" + ech.id + "/accepter", {})]);
  assert.strictEqual(acc.filter(x => x.statut === 200).length, 1, "acceptation une seule fois");
  const apresA = (await A("moi")).d.etat.possedees, apresB = (await Bc("moi")).d.etat.possedees;
  assert.strictEqual((apresA[carteBob] || 0), (avantA[carteBob] || 0) + 1);
  assert.strictEqual((apresB[donneA] || 0), (avantB[donneA] || 0) + 1);
  assert.strictEqual((apresB[carteBob] || 0), (avantB[carteBob] || 0) - 1);
  // Un échange dont les cartes ne sont plus libres échoue sans rien céder
  r = await A("echanges", {vers: "bob" + suffixe, donne: {}, recoit: {[donneA]: 1}});
  assert.strictEqual(r.statut, 201);
  const ech2 = (await Bc("echanges")).d.echanges.find(x => x.statut === "proposee").id;
  assert.strictEqual((await Bc("annonces", {carte: donneA, prix: 3})).statut, 201);
  if (R.disponibles((await Bc("moi")).d.etat, donneA) === 0) {
    r = await Bc("echanges/" + ech2 + "/accepter", {});
    assert.strictEqual(r.statut, 409, JSON.stringify(r.d));
    assert.strictEqual((await Bc("echanges")).d.echanges.find(x => x.id === ech2).statut, "proposee");
  }
  // Retrait de l'annonce : l'exemplaire redevient libre
  const annB = (await Bc("annonces")).d.annonces.find(a => a.statut === "ouverte").id;
  assert.strictEqual((await Bc("annonces/" + annB + "/retirer", {})).statut, 200);
  assert.strictEqual((await Bc("annonces/" + annB + "/retirer", {})).statut, 409);
  // Recyclage côté serveur de vrais doubles, lancé deux fois en même temps : payé une seule fois
  const dbl = cat.parRarete.rare[3].id;
  require("child_process").execSync(`${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "INSERT INTO possessions (joueur, carte, n) SELECT id, '${dbl}', 4 FROM joueurs WHERE pseudo = 'carole${suffixe}'"`, {stdio: "ignore"});
  const avantC = (await C("moi")).d.etat.points;
  const rec = await Promise.all([C("recycler", {raretes: ["rare"]}), C("recycler", {raretes: ["rare"]})]);
  console.log("recyclages simultanés :", rec.map(x => x.statut + " " + JSON.stringify(x.d.resultat || x.d.erreur)).join(" | "));
  const eC = (await C("moi")).d.etat;
  assert.strictEqual(eC.possedees[dbl], 1); assert.strictEqual(eC.points, avantC + 15);
  // Échange de points, réclamation, déconnexion
  r = await Bc("echanger-points", {}); assert.strictEqual(r.statut, pointsBob >= 25 ? 200 : 409);
  r = await A("deconnexion", {}); assert.strictEqual((await A("moi")).d.connecte, false);
  r = await A("connexion", {pseudo: "Alice" + suffixe, preuve: preuve("a")});
  assert.strictEqual(r.statut, 200); assert.strictEqual((await A("moi")).d.connecte, true);
  assert.strictEqual((await A("paquet", {})).statut, 409, "quota du jour conservé");
  console.log("API : tous les tests passent");
})().catch(e => { console.error(e); process.exit(1); });
