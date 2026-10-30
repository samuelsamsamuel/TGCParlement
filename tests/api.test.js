/* Test de l'API sur un serveur local, à lancer depuis la racine du dépôt :
     npx wrangler dev --port 8787 --test-scheduled --var CODE_ESSAI:1 --var ANNONCE_TOUTE_HEURE:1 --persist-to /tmp/hemicycle-d1     (dans un premier terminal)
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
  // Version du déploiement dans chaque réponse (rechargement des pages ouvertes avant un déploiement)
  const v = await fetch("http://localhost:8787/api/version");
  assert.ok(v.headers.get("x-version")); assert.strictEqual((await v.json()).version, v.headers.get("x-version"));
  assert.strictEqual((await fetch("http://localhost:8787/api/moi")).headers.get("x-version"), v.headers.get("x-version"));
  let r = await A("inscription", {pseudo: "alice" + suffixe, preuve: preuve("a"), collection: {[com]: 2, [qv]: 1, "inconnue": 5}}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
  assert.deepStrictEqual(r.d.etat.possedees, {[com]: 2, [qv]: 1});
  assert.ok(!r.d.etat.verrous[com], "exemplaires repris libres");
  assert.ok(r.d.etat.objectifs["quatre-vingts@1"], "palier déjà atteint marqué réclamé");
  assert.strictEqual(R.recompensesEnAttente(r.d.etat, cat).objectifs, 0);
  // Grande collection reprise (au-delà de 100 paramètres D1 par requête) en une seule transaction
  const grande = {}; cat.cartes.slice(100, 400).forEach(c => grande[c.id] = 1);
  r = await client()("inscription", {pseudo: "grand" + suffixe, preuve: preuve("g"), collection: grande}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d)); assert.strictEqual(Object.keys(r.d.etat.possedees).length, 300);
  // Voix du navigateur reprises, plafonnées à 1 000 ; un compte ainsi repris n'est plus « vide » et ne se reprend pas deux fois
  r = await client()("inscription", {pseudo: "voix" + suffixe, preuve: preuve("vx"), collection: {}, voix: 40}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d)); assert.strictEqual(r.d.etat.points, 40);
  assert.strictEqual((await client()("inscription", {pseudo: "voix" + suffixe, preuve: preuve("vx"), voix: 40}, {"cf-connecting-ip": "10.0.0." + (++ip)})).statut, 409);
  r = await client()("inscription", {pseudo: "riche" + suffixe, preuve: preuve("ri"), collection: {[com]: 1}, voix: 99999}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.d.etat.points, 1000);
  // Compte resté vide (inscription interrompue) : la même inscription le reprend ; un autre mot de passe est refusé
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "INSERT INTO joueurs (pseudo, sel, empreinte, cree) VALUES ('vide${suffixe}', 'ab', '${require("crypto").createHash("sha256").update("ab" + preuve("v")).digest("hex")}', '2026-10-24')"`, {stdio: "ignore"});
  assert.strictEqual((await client()("inscription", {pseudo: "vide" + suffixe, preuve: preuve("autre")}, {"cf-connecting-ip": "10.0.2.1"})).statut, 409);
  r = await client()("inscription", {pseudo: "vide" + suffixe, preuve: preuve("v"), collection: {[com]: 1}}, {"cf-connecting-ip": "10.0.2.2"});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d)); assert.strictEqual(r.d.etat.possedees[com], 1);
  // Pseudo pris (casse comprise), mauvais mot de passe
  r = await C("inscription", {pseudo: "ALICE" + suffixe, preuve: preuve("x")}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 409);
  r = await C("connexion", {pseudo: "alice" + suffixe, preuve: preuve("faux")});
  assert.strictEqual(r.statut, 401);
  // Recyclage : les exemplaires repris se recyclent comme les autres (un double de commune)
  r = await A("recycler", {raretes: ["commune"]});
  assert.deepStrictEqual(r.d.resultat, {exemplaires: 1, points: 1});
  // Réserve pleine (RESERVE_MAX paquets) ; une ouverture simultanée de plus : jamais plus que la réserve, chaque paquet compté une fois
  const ouvertures = await Promise.all(Array.from({length: R.RESERVE_MAX + 1}, () => A("paquet", {})));
  const reussies = ouvertures.filter(x => x.statut === 200).length;
  console.log("ouvertures simultanées réussies :", reussies, "sur", R.RESERVE_MAX + 1, ";", ouvertures.map(x => x.statut).join(","));
  assert.ok(reussies <= R.RESERVE_MAX);
  for (let i = reussies; i < R.RESERVE_MAX; i++) assert.strictEqual((await A("paquet", {})).statut, 200);
  r = await A("paquet", {});
  assert.strictEqual(r.statut, 409);
  r = await A("moi");
  assert.strictEqual(R.paquetsDisponibles(r.d.etat).reserve, 0);
  assert.ok(R.paquetsDisponibles(r.d.etat).prochain > Date.now());
  const total = Object.values(r.d.etat.possedees).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 2 + R.CARTES_PAR_PAQUET * R.RESERVE_MAX);
  // Bob : compte sans reprise
  r = await Bc("inscription", {pseudo: "bob" + suffixe, preuve: preuve("b")}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201);
  r = await Bc("paquet", {}); assert.strictEqual(r.statut, 200);
  const carteBob = r.d.resultat.tirage[0];
  // Alice vend une carte libre tirée d'un paquet ; la carte reprise est libre aussi
  const etatA = (await A("moi")).d.etat;
  const libreA = Object.keys(etatA.possedees).find(id => R.disponibles(etatA, id) > 0);
  assert.strictEqual(R.disponibles(etatA, com), etatA.possedees[com]);
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
  assert.strictEqual((await A("moi")).d.etat.points, 1 + 7, "voix du recyclage et de la vente");
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
  assert.strictEqual((await A("paquet", {})).statut, 409, "réserve conservée");
  // Questions du jour : récompensées une fois par jour, au plus 15 voix
  const avantQ = (await C("moi")).d.etat.points;
  r = await C("quiz", {bonnes: 5}); assert.strictEqual(r.d.resultat, 15);
  r = await C("quiz", {bonnes: 5}); assert.strictEqual(r.d.resultat, 0);
  assert.strictEqual((await C("moi")).d.etat.points, avantQ + 15);
  assert.strictEqual((await C("quiz", {bonnes: 9})).statut, 400);
  // Détenteurs d'une carte : nombre de comptes qui en ont au moins un exemplaire, sans connexion
  {
    const id = Object.keys((await A("moi")).d.etat.possedees)[0];
    const d = await (await fetch("http://localhost:8787/api/detenteurs?carte=" + id)).json();
    assert.ok(d.joueurs >= 1, JSON.stringify(d));
    assert.strictEqual((await fetch("http://localhost:8787/api/detenteurs?carte=x;y")).status, 400);
  }
  // Carte cédée (ligne de possession à zéro) : hors de la collection, mais notée dans deja
  {
    const sh = c => require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "${c}"`, {stdio: "ignore"});
    const j = (await A("moi")).d.etat;
    sh(`INSERT INTO possessions (joueur, carte, n) SELECT id, 'ZZ-cedee', 0 FROM joueurs WHERE pseudo = 'alice${suffixe}'`);
    const e = (await A("moi")).d.etat;
    assert.ok(e.deja.includes("ZZ-cedee") && !e.possedees["ZZ-cedee"]);
    assert.strictEqual(Object.keys(e.possedees).length, Object.keys(j.possedees).length);
  }
  // Série de connexion et objectifs du jour, tenus par le serveur (colonne quotidien)
  {
    const sh = c => require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "${c.replace(/"/g, '\\"')}"`, {stdio: "ignore"});
    const jour = R.jourDuJeu(), hier = new Date(Date.parse(jour + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);
    sh(`UPDATE joueurs SET quotidien = '{}' WHERE pseudo = 'alice${suffixe}'`);
    assert.strictEqual((await A("jour", {})).statut, 200);
    const v0 = (await A("moi")).d.etat.points;
    r = await A("serie", {}); assert.strictEqual(r.statut, 200, JSON.stringify(r.d)); assert.strictEqual(r.d.resultat.voix, 10);
    assert.strictEqual(r.d.etat.points, v0 + 10);
    assert.strictEqual((await A("serie", {})).statut, 409, "une fois par jour");
    sh(`UPDATE joueurs SET quotidien = json_set(quotidien, '$.serie', json('{"jour":"${hier}","rang":1}')) WHERE pseudo = 'alice${suffixe}'`);
    r = await A("serie", {}); const choix = r.d.resultat.choix;
    assert.strictEqual(choix.length, 3); assert.ok(choix.every(id => !r.d.etat.possedees[id]), "cartes pas encore possédées");
    r = await A("lot", {carte: choix[2]}); assert.strictEqual(r.statut, 200); assert.strictEqual(r.d.etat.possedees[choix[2]], 1);
    assert.strictEqual((await A("lot", {carte: choix[0]})).statut, 409, "une carte par lot");
    // Objectifs du jour : compteurs posés en base, deux tâches réclamées une fois
    sh(`UPDATE joueurs SET quiz = '${jour}', quotidien = json_set(quotidien, '$.compteurs', json('{"jour":"${jour}","paquets":9,"dissous":9,"objectifs":9}')) WHERE pseudo = 'alice${suffixe}'`);
    const taches = R.objectifsDuJour(cat, jour).taches.map(t => t.cle), v1 = (await A("moi")).d.etat.points;
    for (const cle of taches) assert.strictEqual((await A("objectif-du-jour", {cle})).statut, 200, cle);
    assert.strictEqual((await A("moi")).d.etat.points, v1 + 20);
    assert.strictEqual((await A("objectif-du-jour", {cle: taches[0]})).statut, 409);
  }
  // Duels jugés par le serveur, avec mise : la graine ne quitte pas le serveur ; le test la lit en base pour répondre
  const base = c => require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --json --command "${c}"`).toString();
  const lire = c => JSON.parse(base(c))[0].results;
  const qcat = R.catalogueQuiz(require("../site/quiz-serveur.json"));
  const voixDe = async cl => (await cl("moi")).d.etat.points;
  base(`UPDATE joueurs SET points = 50 WHERE pseudo IN ('alice${suffixe}', 'carole${suffixe}')`);
  assert.strictEqual((await A("duels", {vers: "carole" + suffixe, voix: 1000})).statut, 400, "mise plafonnée");
  r = await A("duels", {vers: "carole" + suffixe, voix: 10}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
  const duel = r.d.id, graine = lire(`SELECT graine FROM duels WHERE id = ${duel}`)[0].graine, bonnes = R.questions(qcat, graine).map(q => q.bonne);
  assert.strictEqual(await voixDe(A), 40, "mise retenue au lanceur");
  assert.strictEqual((await C("attente")).d.duels, 1);
  assert.strictEqual((await C("duels/" + duel + "/questions")).statut, 409, "relever d'abord");
  const qA = (await A("duels/" + duel + "/questions")).d.questions;
  assert.strictEqual(qA.length, 5); assert.ok(qA.every(q => q.bonne === undefined), "pas de réponse envoyée d'avance");
  const jouer = async (cl, nbJustes) => { let x; for (let k = 0; k < 5; k++) x = await cl("duels/" + duel + "/reponse", {question: k, choix: k < nbJustes ? bonnes[k] : (bonnes[k] + 1) % 4}); return x; };
  r = await jouer(A, 4); assert.strictEqual(r.d.fin, true); assert.strictEqual(r.d.score, 4); assert.strictEqual(r.d.resultat, null);
  assert.strictEqual((await A("duels/" + duel + "/reponse", {question: 4, choix: 0})).statut, 409, "une réponse par question");
  let vueC = (await C("duels")).d.duels.find(x => x.id === duel);
  assert.strictEqual(vueC.graine, undefined); assert.strictEqual(vueC.sien, null); assert.strictEqual(vueC.voix, 10);
  assert.strictEqual((await C("duels/" + duel + "/relever", {})).statut, 200);
  assert.strictEqual(await voixDe(C), 40, "mise retenue à l'adversaire");
  assert.strictEqual((await C("duels/" + duel + "/relever", {})).statut, 409);
  r = await jouer(C, 2); assert.strictEqual(r.d.resultat.score.join(), "4,2");
  assert.strictEqual(await voixDe(A), 60, "le gagnant emporte les deux mises"); assert.strictEqual(await voixDe(C), 40);
  vueC = (await C("duels")).d.duels.find(x => x.id === duel);
  assert.ok(vueC.termine); assert.strictEqual(vueC.sien, 4); assert.strictEqual(vueC.issue, "perdu");
  // Défi refusé : mise rendue ; défi ignoré trois jours : remboursé par la tâche horaire
  r = await A("duels", {vers: "carole" + suffixe, voix: 5}); assert.strictEqual(await voixDe(A), 55);
  assert.strictEqual((await C("duels/" + r.d.id + "/refuser", {})).statut, 200); assert.strictEqual(await voixDe(A), 60);
  r = await A("duels", {vers: "carole" + suffixe, paquets: 0, voix: 20}); assert.strictEqual(await voixDe(A), 40);
  base(`UPDATE duels SET cree = '2020-01-01T00:00:00.000Z' WHERE id = ${r.d.id}`);
  assert.strictEqual((await fetch("http://localhost:8787/cdn-cgi/handler/scheduled")).status, 200);
  assert.strictEqual(await voixDe(A), 60, "défi expiré remboursé");
  assert.strictEqual((await A("duels")).d.duels.find(x => x.id === r.d.id).statut, "expire");
  // Jeu du Gouvernement : gouvernements enregistrés (10 voix la création), parties contre l'ordinateur, entre amis avec
  // mise, contre un joueur tiré au hasard, abandon et délai
  {
    const G = require("../site/gouvernement.js"), {fiches} = G.fichesDeJeu(require("../site/gouvernement.json"));
    let s = 11; const alea = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const reels = G.gouvernementsReels(fiches), annonces = G.annoncesDePartie(5, 50);
    const gA = G.gouvernementOrdinateur(reels, annonces, alea, 0);
    let gC; do gC = G.gouvernementOrdinateur(reels, annonces, alea, 0); while (gC.chef === gA.chef);
    const donner = (pseudo, g) => base(`INSERT INTO possessions (joueur, carte, n) SELECT j.id, CAST(c.value AS TEXT), 1 FROM joueurs j, json_each('${JSON.stringify([g.chef, ...g.ministres]).replace(/"/g, '\\"')}') c WHERE j.pseudo = '${pseudo}' ON CONFLICT (joueur, carte) DO UPDATE SET n = n + 1`);
    let g = (await A("gouvernements")).d;
    assert.deepStrictEqual([g.gouvernements.length, g.serie.serie, g.prix, g.max], [0, 0, 0, 5], "le premier gouvernement est offert");
    assert.strictEqual((await A("gouvernements", {nom: "Essai", ...gA})).statut, 409, "cartes hors de la collection");
    const vedettes = [...fiches.values()].filter(f => f.stature === 5).slice(0, 9).map(f => f.id);
    assert.strictEqual((await A("gouvernements", {chef: vedettes[0], ministres: vedettes.slice(1)})).statut, 400, "plafond de stature");
    donner("alice" + suffixe, gA); donner("carole" + suffixe, gC);
    base(`UPDATE joueurs SET points = 100 WHERE pseudo IN ('alice${suffixe}', 'carole${suffixe}')`);
    r = await A("gouvernements", {nom: "Cabinet d'Alice", ...gA}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
    const idGA = r.d.id;
    assert.strictEqual(await voixDe(A), 100, "le premier est offert");
    assert.strictEqual((await A("gouvernements", {id: idGA, nom: "Cabinet recomposé", ...gA})).statut, 200);
    assert.strictEqual(await voixDe(A), 100, "recomposition gratuite");
    assert.strictEqual((await A("gouvernements")).d.prix, 10, "les suivants coûtent 10 voix");
    // Un deuxième gouvernement coûte 10 voix ; même après avoir tout supprimé, le suivant n'est plus offert
    r = await A("gouvernements", {nom: "Second", ...gA}); assert.strictEqual(r.statut, 201); assert.strictEqual(await voixDe(A), 90);
    assert.strictEqual((await A(`gouvernements/${r.d.id}/supprimer`, {})).statut, 200);
    assert.strictEqual((await A(`gouvernements/${idGA}/supprimer`, {})).statut, 200);
    assert.strictEqual((await A("gouvernements")).d.prix, 10);
    r = await A("gouvernements", {nom: "Cabinet recomposé", ...gA}); assert.strictEqual(await voixDe(A), 80);
    const idGA2 = r.d.id;
    base(`UPDATE joueurs SET points = 90 WHERE pseudo = 'alice${suffixe}'`);
    const idGC = (await C("gouvernements", {nom: "Cabinet de Carole", ...gC})).d.id;
    g = (await A("gouvernements")).d;
    assert.deepStrictEqual([g.gouvernements.length, g.gouvernements[0].nom, g.gouvernements[0].vacants], [1, "Cabinet recomposé", []]);
    // Contre l'ordinateur : une partie à la fois, adversaire vu avant le choix du gouvernement
    r = await A("parties", {mode: "ordi"}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
    const solo = r.d.id;
    assert.deepStrictEqual((await A("parties", {mode: "ordi"})).d, {id: solo, reprise: true}, "pas de nouveau tirage");
    let v = (await A("parties/" + solo)).d;
    assert.deepStrictEqual([v.statut, v.annonces.length, v.moi, v.lui.ministres.length], ["preparation", 10, null, 8]);
    assert.strictEqual((await A("attente")).d.gouvernement, 1);
    assert.strictEqual((await A("parties/" + solo + "/coup", {ministre: 0})).statut, 409, "gouvernement d'abord");
    v = (await A("parties/" + solo + "/gouvernement", {gouvernement: idGA2})).d;
    assert.strictEqual(v.statut, "en-cours"); assert.ok(v.annonces.includes(v.theme)); assert.strictEqual(v.manches.length, 0);
    for (let i = 0; !v.fini; i++) {
      r = await A("parties/" + solo + "/coup", {ministre: i, avec493: i === 0});
      assert.strictEqual(r.statut, 200, JSON.stringify(r.d)); v = r.d;
      assert.strictEqual(v.manches.length, i + 1, "l'ordinateur répond aussitôt");
    }
    assert.strictEqual((await A("parties/" + solo + "/coup", {ministre: 7})).statut, 409, "partie finie");
    // Série : la victoire fait monter d'un palier, la récompense s'encaisse à la fin (la défaite fait tout perdre)
    const serie = (await A("gouvernements")).d.serie;
    assert.strictEqual(serie.serie, v.issue === "gagne" ? 1 : 0);
    assert.strictEqual(await voixDe(A), 90, "rien avant d'encaisser");
    if (v.issue === "gagne") {
      r = await A("gouvernements/encaisser", {}); assert.strictEqual(r.statut, 200, JSON.stringify(r.d));
      assert.deepStrictEqual([r.d.resultat.palier, r.d.resultat.voix, r.d.etat.points], [1, 15, 105]);
      assert.strictEqual((await A("gouvernements")).d.serie.serie, 0, "la série repart de zéro");
    }
    assert.strictEqual((await A("gouvernements/encaisser", {})).statut, 409, "rien à encaisser");
    // Entre amis, avec mise : coups à son rythme, révélés quand les deux ont joué
    const voixA = await voixDe(A);
    r = await A("parties", {mode: "ami", vers: "carole" + suffixe, voix: 10}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
    const amie = r.d.id;
    assert.strictEqual(await voixDe(A), voixA - 10, "mise retenue");
    assert.strictEqual((await C("parties/" + amie + "/gouvernement", {gouvernement: idGC})).statut, 409, "le lanceur choisit d'abord");
    assert.strictEqual((await A("parties/" + amie + "/gouvernement", {gouvernement: idGA2})).d.statut, "propose");
    assert.ok((await C("parties")).d.parties.find(x => x.id === amie).aRelever);
    v = (await C("parties/" + amie + "/gouvernement", {gouvernement: idGC})).d;
    assert.strictEqual(v.statut, "en-cours"); assert.strictEqual(await voixDe(C), 90, "mise retenue à l'ami (son premier gouvernement était offert)");
    assert.deepStrictEqual(v.lui.ministres, gA.ministres, "gouvernement adverse visible");
    for (let i = 0; !v.fini; i++) {
      assert.strictEqual((await A("parties/" + amie + "/coup", {ministre: i})).statut, 200);
      if (i === 0) {
        assert.strictEqual((await A("parties/" + amie + "/coup", {ministre: 1})).statut, 409, "attendre l'autre");
        const vc = (await C("parties/" + amie)).d;
        assert.strictEqual(vc.manches.length, 0, "coup adverse caché"); assert.strictEqual(vc.attente, null);
        // Présence : chacun vient de consulter la partie, l'autre le voit « en direct »
        assert.strictEqual(vc.enDirect, true, "Alice vient de jouer : en direct pour Carole");
        assert.strictEqual((await A("parties/" + amie)).d.enDirect, true, "Carole regarde : en direct pour Alice");
      }
      v = (await C("parties/" + amie + "/coup", {ministre: 7 - i})).d;
    }
    const va = (await A("parties/" + amie)).d;
    assert.strictEqual(va.fini, true);
    const attendues = va.issue === "gagne" ? [voixA + 10, 90] : va.issue === "perdu" ? [voixA - 10, 110] : [voixA, 100];
    assert.deepStrictEqual([await voixDe(A), await voixDe(C)], attendues, "le gagnant emporte les deux mises");
    // Contre un joueur tiré au hasard : un gouvernement enregistré par un autre ; abandon : défaite
    r = await C("parties", {mode: "hasard"}); assert.strictEqual(r.statut, 201, JSON.stringify(r.d));
    v = (await C("parties/" + r.d.id)).d;
    assert.strictEqual(v.mode, "hasard"); assert.ok(v.adversaire && v.lui.nom, "gouvernement d'un joueur, nommé");
    assert.strictEqual((await A("parties/" + r.d.id)).statut === 404 || v.adversaire !== "alice" + suffixe, true, "le propriétaire ne voit pas la partie");
    assert.strictEqual((await C("parties/" + r.d.id + "/abandonner", {})).statut, 200);
    assert.strictEqual((await C("parties/" + r.d.id)).d.issue, "perdu");
    // Défi entre amis oublié : mise rendue par la tâche horaire
    const avantExp = await voixDe(A);
    r = await A("parties", {mode: "ami", vers: "carole" + suffixe, voix: 5});
    assert.strictEqual(await voixDe(A), avantExp - 5);
    base(`UPDATE parties SET maj = '2020-01-01T00:00:00.000Z' WHERE id = ${r.d.id}`);
    assert.strictEqual((await fetch("http://localhost:8787/cdn-cgi/handler/scheduled")).status, 200);
    assert.strictEqual(await voixDe(A), avantExp, "défi oublié remboursé");
    // Partie en cours au délai : close, la manche jouée d'un seul côté lui revient
    r = await A("parties", {mode: "ami", vers: "carole" + suffixe});
    await A("parties/" + r.d.id + "/gouvernement", {gouvernement: idGA2}); await C("parties/" + r.d.id + "/gouvernement", {gouvernement: idGC});
    await A("parties/" + r.d.id + "/coup", {ministre: 0});
    base(`UPDATE parties SET maj = '2020-01-01T00:00:00.000Z' WHERE id = ${r.d.id}`);
    await fetch("http://localhost:8787/cdn-cgi/handler/scheduled");
    v = (await A("parties/" + r.d.id)).d;
    assert.deepStrictEqual([v.statut, v.issue, v.score], ["fini", "gagne", [1, 0]]);
    // Carte cédée : poste vacant signalé
    base(`UPDATE possessions SET n = 0 WHERE carte = '${gA.ministres[0]}' AND joueur = (SELECT id FROM joueurs WHERE pseudo = 'alice${suffixe}')`);
    assert.deepStrictEqual((await A("gouvernements")).d.gouvernements[0].vacants, [gA.ministres[0]]);
    assert.strictEqual((await A("parties", {mode: "ordi"})).statut, 201);
    assert.strictEqual((await A("parties/" + (await A("parties")).d.parties[0].id + "/gouvernement", {gouvernement: idGA2})).statut, 409, "gouvernement incomplet");
  }
  // Vitrine et profil : seulement des cartes de la collection
  const mienne = Object.keys((await A("moi")).d.etat.possedees)[0];
  assert.strictEqual((await A("vitrine", {cartes: [mienne]})).statut, 200);
  assert.strictEqual((await A("vitrine", {cartes: [cat.parRarete.mythique[90].id, mienne]})).statut === 409
    || !(await A("moi")).d.etat.possedees[cat.parRarete.mythique[90].id], true);
  const prof = (await C("profil/alice" + suffixe)).d;
  assert.deepStrictEqual(prof.vitrine, [mienne]); assert.strictEqual(prof.duels.gagnes, 1);
  assert.strictEqual((await C("classement")).statut, 404, "classement retiré");
  // Dissolution des doubles d'une seule carte
  const eDbl = (await A("moi")).d.etat, dblA = Object.keys(eDbl.possedees).find(id => R.recyclables(eDbl, id) > 0);
  if (dblA) {
    r = await A("dissoudre", {carte: dblA});
    assert.strictEqual(r.d.resultat.exemplaires, R.recyclables(eDbl, dblA)); assert.strictEqual(r.d.etat.possedees[dblA], eDbl.possedees[dblA] - r.d.resultat.exemplaires);
  }
  assert.ok((await A("moi")).d.cree, "date de création du compte");
  // Favoris : gardés par le serveur, une carte inconnue refusée
  assert.deepStrictEqual((await A("favori", {carte: mienne, actif: true})).d.favoris, [mienne]);
  assert.deepStrictEqual((await A("moi")).d.etat.favoris, [mienne]);
  assert.strictEqual((await A("favori", {carte: "inconnue", actif: true})).statut, 400);
  assert.deepStrictEqual((await A("favori", {carte: mienne, actif: false})).d.favoris, []);
  // Notifications : service inconnu refusé ; abonnement de Bob, message gardé à sa demande d'ami, lu une fois
  assert.strictEqual((await Bc("notifications/abonner", {abonnement: {endpoint: "https://exemple.org/x"}})).statut, 400);
  assert.ok((await Bc("notifications/cle")).d.cle.length > 80);
  assert.strictEqual((await Bc("notifications/abonner", {abonnement: {endpoint: "https://fcm.googleapis.com/fcm/send/essai" + suffixe}, reserve: false})).statut, 200);
  // Amis : demande, pastille d'attente, demande croisée qui vaut acceptation, retrait réciproque
  const alice = "alice" + suffixe, bob = "bob" + suffixe, carole = "carole" + suffixe;
  assert.strictEqual((await A("amis/demander", {pseudo: alice})).statut, 400);
  assert.strictEqual((await A("amis/demander", {pseudo: bob})).d.statut, "demande");
  assert.strictEqual((await Bc("attente")).d.amis, 1);
  assert.match((await Bc("notifications")).d.notifications.map(n => n.texte).join(), /alice.* vous demande en ami/);
  assert.deepStrictEqual((await Bc("notifications")).d.notifications, []);
  assert.deepStrictEqual((await Bc("amis")).d.recues, [alice]);
  assert.strictEqual((await Bc("amis/demander", {pseudo: alice})).d.statut, "accepte");
  assert.deepStrictEqual((await A("amis")).d.amis, [bob]); assert.deepStrictEqual((await Bc("amis")).d.amis, [alice]);
  assert.strictEqual((await Bc("attente")).d.amis, 0);
  assert.strictEqual((await A("amis/demander", {pseudo: carole})).statut, 200);
  assert.strictEqual((await C("amis/accepter", {pseudo: alice})).d.statut, "accepte");
  // Amis qui ont une carte (identifiant à tirets compris) : Carole, amie d'Alice, en a deux, dont une en vente
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "INSERT INTO possessions (joueur, carte, n, reserve) SELECT id, 'G-de-gaulle-charles', 2, 1 FROM joueurs WHERE pseudo = '${carole}'"`, {stdio: "ignore"});
  assert.deepStrictEqual((await A("amis/carte?carte=G-de-gaulle-charles")).d.amis, [{pseudo: carole, n: 2, libres: 1}]);
  assert.deepStrictEqual((await Bc("amis/carte?carte=G-de-gaulle-charles")).d.amis, [], "pas encore ami de Carole");
  assert.strictEqual((await A("amis/carte?carte=x;y")).statut, 400);
  assert.ok((await (await fetch("http://localhost:8787/api/detenteurs?carte=G-de-gaulle-charles")).json()).joueurs >= 1);
  assert.strictEqual((await A("amis/retirer", {pseudo: bob})).statut, 200);
  assert.deepStrictEqual((await Bc("amis")).d, {amis: [], recues: [], envoyees: [], vitrines: {}, suggestions: []});
  assert.strictEqual((await C("amis/accepter", {pseudo: bob})).statut, 409);
  // Suggestions : Bob devient ami de Carole, amie d'Alice ; chacun voit l'autre en ami d'ami, plus après une demande
  assert.strictEqual((await Bc("amis/demander", {pseudo: carole})).d.statut, "demande");
  assert.strictEqual((await C("amis/accepter", {pseudo: bob})).d.statut, "accepte");
  assert.deepStrictEqual((await A("amis")).d.suggestions, [{pseudo: bob, communs: 1}]);
  assert.deepStrictEqual((await Bc("amis")).d.suggestions, [{pseudo: alice, communs: 1}]);
  assert.deepStrictEqual((await C("amis")).d.suggestions, [], "ses amis sont déjà amis avec elle");
  assert.strictEqual((await A("amis/demander", {pseudo: bob})).d.statut, "demande");
  assert.deepStrictEqual((await A("amis")).d.suggestions, [], "demande envoyée : plus suggéré");
  assert.strictEqual((await A("amis/retirer", {pseudo: bob})).statut, 200);
  // Échange avec des voix : d'un seul côté, une carte au moins ; voix payées à l'acceptation ; voix manquantes : rien ne bouge
  base(`UPDATE joueurs SET points = 30 WHERE pseudo IN ('${alice}', '${bob}', '${carole}')`);
  const libresDe = async cl => { const e = (await cl("moi")).d.etat; return Object.keys(e.possedees).filter(id => R.disponibles(e, id) > 0); };
  const [carteV] = await libresDe(A);
  assert.strictEqual((await Bc("echanges", {vers: alice, donne: {}, recoit: {[carteV]: 1}, voix_donne: 5, voix_recoit: 5})).statut, 400);
  assert.strictEqual((await Bc("echanges", {vers: alice, donne: {}, recoit: {}, voix_donne: 5})).statut, 400, "une carte au moins");
  assert.strictEqual((await Bc("echanges", {vers: alice, donne: {}, recoit: {[carteV]: 1}, voix_donne: 31})).statut, 409, "voix insuffisantes");
  assert.strictEqual((await Bc("echanges", {vers: alice, donne: {}, recoit: {[carteV]: 1}, voix_donne: 5})).statut, 201);
  const ev = (await A("echanges")).d.echanges.find(x => x.statut === "proposee" && x.recu);
  assert.strictEqual(ev.voixDonne, 5); assert.strictEqual(ev.voixRecoit, 0);
  const nV = (await Bc("moi")).d.etat.possedees[carteV] || 0;
  assert.strictEqual((await A("echanges/" + ev.id + "/accepter", {})).statut, 200);
  assert.strictEqual(await voixDe(A), 35); assert.strictEqual(await voixDe(Bc), 25);
  assert.strictEqual((await Bc("moi")).d.etat.possedees[carteV], nV + 1);
  const [carteW] = await libresDe(A);
  assert.strictEqual((await A("echanges", {vers: bob, donne: {[carteW]: 1}, recoit: {}, voix_recoit: 26})).statut, 201);
  const ew = (await Bc("echanges")).d.echanges.find(x => x.statut === "proposee" && x.recu);
  assert.strictEqual((await Bc("echanges/" + ew.id + "/accepter", {})).statut, 409, "Bob n'a que 25 voix");
  assert.strictEqual(await voixDe(Bc), 25); assert.strictEqual((await Bc("echanges")).d.echanges.find(x => x.id === ew.id).statut, "proposee");
  assert.strictEqual((await A("echanges/" + ew.id + "/annuler", {})).statut, 200);
  // Alerte de vente : Bob guette une carte, Alice la pose au comptoir, Bob est averti (il est abonné aux notifications)
  const [carteO] = await libresDe(A);
  assert.strictEqual((await Bc("alertes", {carte: "inconnue", actif: true})).statut, 400);
  assert.deepStrictEqual((await Bc("alertes", {carte: carteO, actif: true, nom: "Carte guettée"})).d.alertes, [carteO]);
  assert.deepStrictEqual((await Bc("alertes")).d.alertes, [carteO]);
  // Le faux abonnement est effacé à la première poussée (FCM répond 410) : réabonné avant chaque message attendu ;
  // les avis partent après la réponse, d'où quelques essais
  // Adresse neuve à chaque fois : la réponse tardive d'une poussée précédente n'efface que l'ancienne
  let abonnements = 0;
  const abonnerBob = () => Bc("notifications/abonner", {abonnement: {endpoint: "https://fcm.googleapis.com/fcm/send/essai" + suffixe + "-" + (++abonnements)}, reserve: false});
  const avisBob = async motif => {
    let textes = "";
    for (let k = 0; k < 20 && !motif.test(textes); k++) { textes += (await Bc("notifications")).d.notifications.map(n => n.texte).join(); if (!motif.test(textes)) await new Promise(f => setTimeout(f, 250)); }
    assert.match(textes, motif);
  };
  await abonnerBob(); await Bc("notifications");
  assert.strictEqual((await A("annonces", {carte: carteO, prix: 20})).statut, 201);
  await avisBob(/Carte guettée est en vente au comptoir : 20 voix/);
  assert.deepStrictEqual((await Bc("alertes", {carte: carteO, actif: false})).d.alertes, []);
  // Contre-offres : sous le prix seulement ; la nouvelle remplace l'ancienne ; refus notifié ; acceptée, elle vaut achat au
  // prix offert et clôt les autres offres
  const annO = (await A("annonces")).d.annonces.find(a => a.statut === "ouverte" && a.carte === carteO).id;
  assert.strictEqual((await A("annonces/" + annO + "/offre", {prix: 10})).statut, 400, "pas sur sa propre carte");
  assert.strictEqual((await Bc("annonces/" + annO + "/offre", {prix: 20})).statut, 400, "au prix demandé, on achète");
  assert.strictEqual((await Bc("annonces/" + annO + "/offre", {prix: 26})).statut, 400);
  assert.strictEqual((await Bc("annonces/" + annO + "/offre", {prix: 10})).statut, 201);
  assert.strictEqual((await Bc("annonces/" + annO + "/offre", {prix: 12})).statut, 201);
  let offres = (await A("annonces")).d.offres;
  assert.deepStrictEqual(offres.map(o => [o.prix, o.acheteur]), [[12, bob]], "l'offre de 12 remplace celle de 10");
  assert.strictEqual((await A("attente")).d.offres, 1);
  assert.strictEqual((await Bc("annonces")).d.mesOffres.length, 1);
  assert.strictEqual((await Bc("offres/" + offres[0].id + "/accepter", {})).statut, 403, "seul le vendeur accepte");
  await abonnerBob();
  assert.strictEqual((await A("offres/" + offres[0].id + "/refuser", {})).statut, 200);
  assert.strictEqual((await A("offres/" + offres[0].id + "/accepter", {})).statut, 409);
  await avisBob(/refusé votre offre de 12 voix/);
  assert.strictEqual((await Bc("annonces/" + annO + "/offre", {prix: 15})).statut, 201);
  assert.strictEqual((await C("annonces/" + annO + "/offre", {prix: 14})).statut, 201);
  offres = (await A("annonces")).d.offres;
  assert.strictEqual(offres.length, 2);
  const deBob = offres.find(o => o.acheteur === bob), deCarole = offres.find(o => o.acheteur === carole);
  const nO = (await Bc("moi")).d.etat.possedees[carteO] || 0;
  await abonnerBob();
  assert.strictEqual((await A("offres/" + deBob.id + "/accepter", {})).statut, 200);
  assert.strictEqual(await voixDe(Bc), 10); assert.strictEqual(await voixDe(A), 50);
  assert.strictEqual((await Bc("moi")).d.etat.possedees[carteO], nO + 1);
  const vendue = (await A("annonces")).d.annonces.find(a => a.id === annO);
  assert.strictEqual(vendue.statut, "vendue"); assert.strictEqual(vendue.prix, 15); assert.strictEqual(vendue.acheteur, bob);
  assert.strictEqual((await A("offres/" + deCarole.id + "/accepter", {})).statut, 409, "offre close avec l'annonce");
  assert.deepStrictEqual((await C("annonces")).d.mesOffres, []);
  assert.strictEqual((await A("attente")).d.offres, 0);
  await avisBob(/accepte votre offre de 15 voix/);
  // Offre que l'acheteur ne peut plus payer : acceptation refusée, rien ne bouge
  const [carteP] = await libresDe(A);
  assert.strictEqual((await A("annonces", {carte: carteP, prix: 9})).statut, 201);
  const annP = (await A("annonces")).d.annonces.find(a => a.statut === "ouverte" && a.carte === carteP).id;
  assert.strictEqual((await Bc("annonces/" + annP + "/offre", {prix: 8})).statut, 201);
  base(`UPDATE joueurs SET points = 3 WHERE pseudo = '${bob}'`);
  const offreP = (await A("annonces")).d.offres[0].id;
  assert.strictEqual((await A("offres/" + offreP + "/accepter", {})).statut, 409);
  assert.strictEqual((await A("annonces")).d.annonces.find(a => a.id === annP).statut, "ouverte");
  // Retrait de l'annonce : l'offre en attente est close avec elle
  assert.strictEqual((await A("annonces/" + annP + "/retirer", {})).statut, 200);
  assert.deepStrictEqual((await Bc("annonces")).d.mesOffres, []);
  // Réserve pleine (tâche horaire, wrangler dev --test-scheduled) : seulement après un vrai remplissage, une fois
  const sql = c => require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "${c}"`, {stdio: "ignore"});
  const horaire = async () => assert.strictEqual((await fetch("http://localhost:8787/cdn-cgi/handler/scheduled")).status, 200);
  assert.strictEqual((await C("notifications/abonner", {abonnement: {endpoint: "https://fcm.googleapis.com/fcm/send/reserve" + suffixe}})).statut, 200);
  // Annonce du jeu du Gouvernement (tâche horaire, --var ANNONCE_TOUTE_HEURE:1) : une fois par joueur abonné, par lots
  sql("DELETE FROM reglages WHERE cle = 'annonce-gouv'");
  let annonces = "";
  for (let k = 0; k < 50 && !/Nouveau mode de jeu/.test(annonces); k++) { await horaire(); annonces += (await C("notifications")).d.notifications.map(n => n.texte).join(); }
  assert.strictEqual(annonces.match(/Nouveau mode de jeu : le Gouvernement/g)?.length, 1, annonces);
  for (let k = 0; k < 3; k++) await horaire();
  assert.deepStrictEqual((await C("notifications")).d.notifications, [], "annonce envoyée une seule fois");
  // un abonnement que le service de poussée ne connaît pas (ici fictif) est effacé à l'envoi : Carole se réabonne
  assert.strictEqual((await C("notifications/abonner", {abonnement: {endpoint: "https://fcm.googleapis.com/fcm/send/reserve" + suffixe}})).statut, 200);
  sql(`UPDATE joueurs SET stock = 7, ancre = ${Date.now() - 2 * 3600e3} WHERE pseudo = '${carole}'`);
  await horaire();
  assert.deepStrictEqual((await C("notifications")).d.notifications, [], "un seul paquet ouvert : pas de notification");
  sql(`UPDATE joueurs SET stock = 0, ancre = ${Date.now() - 9 * 3600e3} WHERE pseudo = '${carole}'`);
  await horaire();
  assert.match((await C("notifications")).d.notifications.map(n => n.texte).join(), /réserve est pleine/);
  await horaire();
  assert.deepStrictEqual((await C("notifications")).d.notifications, [], "une fois par remplissage");
  // Codes : voix, paquet et carte pour qui saisit le code, une fois par compte, deux comptes au plus ; casse indifférente
  const code = "BIENVENUE" + suffixe.toUpperCase(), carteCode = String(cat.parRarete.commune[3].id);
  sql(`INSERT INTO codes (code, voix, paquets, cartes, limite) VALUES ('${code}', 30, 1, '[\\"${carteCode}\\"]', 2)`);
  sql(`INSERT INTO codes (code, voix, fin) VALUES ('VIEUX${suffixe}', 5, '2020-01-01')`);
  const avantCode = (await C("moi")).d.etat;
  r = await C("code", {code: code.toLowerCase()});
  assert.strictEqual(r.statut, 200, JSON.stringify(r.d));
  assert.deepStrictEqual(r.d.gain, {voix: 30, paquets: 1, cartes: [carteCode]});
  assert.strictEqual(r.d.etat.points, avantCode.points + 30); assert.strictEqual(r.d.etat.offerts, avantCode.offerts + 1);
  assert.strictEqual(r.d.etat.possedees[carteCode], (avantCode.possedees[carteCode] || 0) + 1);
  assert.strictEqual((await C("code", {code})).statut, 409, "une fois par compte");
  assert.strictEqual((await A("code", {code})).statut, 200);
  assert.strictEqual((await Bc("code", {code})).statut, 409, "limite de deux utilisations");
  assert.strictEqual((await A("code", {code: "inconnu"})).statut, 404);
  assert.strictEqual((await A("code", {code: "VIEUX" + suffixe})).statut, 404, "code expiré");
  // Code du dépôt (worker/codes.js, ici le code d'essai du Worker local) : recopié dans D1 à la première saisie
  r = await A("code", {code: " Essai-Depot "});
  assert.strictEqual(r.statut, 200, JSON.stringify(r.d)); assert.strictEqual(r.d.gain.voix, 4);
  assert.strictEqual((await A("code", {code: "essai-depot"})).statut, 409);
  // Code avec choix de cartes (essai-choix) : lot de la série, une carte rare ou mieux à garder parmi trois
  r = await C("code", {code: "Essai-Choix"});
  assert.strictEqual(r.statut, 200, JSON.stringify(r.d)); assert.strictEqual(r.d.gain.choix.length, 3);
  assert.ok(r.d.gain.choix.every(id => ["rare", "epique", "legendaire", "mythique"].includes(cat.parId[id].rarete)));
  assert.strictEqual((await C("code", {code: "essai-choix"})).statut, 409, "une fois par compte");
  const avantLot = (await C("moi")).d.etat.possedees[r.d.gain.choix[1]] || 0;
  assert.strictEqual((await C("gouvernements/lot", {carte: r.d.gain.choix[1]})).statut, 200);
  assert.strictEqual((await C("moi")).d.etat.possedees[r.d.gain.choix[1]], avantLot + 1);
  // Prix du comptoir et attente des échanges
  r = await A("prix?carte=" + encodeURIComponent(libreA));
  assert.strictEqual(r.statut, 200); assert.ok(r.d.ventes.some(v => v.prix === 7));
  // Modération des pseudos et contact
  assert.strictEqual((await client()("inscription", {pseudo: "c0nnard" + suffixe, preuve: preuve("z")}, {"cf-connecting-ip": "10.0.1.1"})).statut, 400);
  assert.strictEqual((await client()("inscription", {pseudo: "Monique" + suffixe, preuve: preuve("m")}, {"cf-connecting-ip": "10.0.1.2"})).statut, 201);
  assert.strictEqual((await client()("contact", {message: "Bonjour, une question."}, {"cf-connecting-ip": "10.0.1.3"})).statut, 201);
  // Suppression du compte : mauvais mot de passe refusé, puis tout est effacé
  // Changement de mot de passe : l'ancien est vérifié ; les autres appareils sont déconnectés, celui-ci reste connecté
  const C2 = client();
  assert.strictEqual((await C2("connexion", {pseudo: "carole" + suffixe, preuve: preuve("c")})).statut, 200);
  assert.strictEqual((await C("mot-de-passe", {ancienne: preuve("faux"), nouvelle: preuve("c2")})).statut, 401);
  assert.strictEqual((await C("mot-de-passe", {ancienne: preuve("c"), nouvelle: "court"})).statut, 400);
  assert.strictEqual((await C("mot-de-passe", {ancienne: preuve("c"), nouvelle: preuve("c2")})).statut, 200);
  assert.strictEqual((await C("moi")).d.connecte, true, "l'appareil du changement reste connecté");
  assert.strictEqual((await C2("moi")).d.connecte, false, "les autres appareils sont déconnectés");
  assert.strictEqual((await client()("connexion", {pseudo: "carole" + suffixe, preuve: preuve("c")})).statut, 401);
  assert.strictEqual((await client()("connexion", {pseudo: "carole" + suffixe, preuve: preuve("c2")})).statut, 200);
  assert.strictEqual((await C("supprimer-compte", {preuve: preuve("faux")})).statut, 401);
  assert.strictEqual((await C("supprimer-compte", {preuve: preuve("c2")})).statut, 200);
  assert.strictEqual((await C("moi")).d.connecte, false);
  assert.strictEqual((await C("connexion", {pseudo: "carole" + suffixe, preuve: preuve("c")})).statut, 401);
  assert.deepStrictEqual((await A("amis")).d.amis, [], "amitiés effacées avec le compte");
  // Cartes gardées : enregistrées sur le compte, carte inconnue refusée
  const [aGarder] = Object.keys((await A("moi")).d.etat.possedees);
  assert.deepStrictEqual((await A("gardes", {cartes: [aGarder], actif: true})).d.gardes, [aGarder]);
  assert.deepStrictEqual((await A("moi")).d.etat.gardes, [aGarder]);
  assert.strictEqual((await A("gardes", {cartes: ["inconnue"], actif: true})).statut, 400);
  assert.deepStrictEqual((await A("gardes", {cartes: [aGarder], actif: false})).d.gardes, []);
  // Dissolution d'une sélection : plusieurs cartes en une opération, tous les exemplaires libres
  const avantS = (await A("moi")).d.etat, choisies = Object.keys(avantS.possedees).filter(id => R.disponibles(avantS, id) > 0).slice(0, 3);
  const voixS = choisies.reduce((t, id) => t + R.disponibles(avantS, id) * R.VALEUR_RECYCLAGE[cat.parId[id].rarete], 0);
  r = await A("dissoudre", {cartes: choisies, garder: false});
  assert.strictEqual(r.statut, 200, JSON.stringify(r.d)); assert.strictEqual(r.d.resultat.points, voixS);
  for (const id of choisies) assert.strictEqual((r.d.etat.possedees[id] || 0), avantS.possedees[id] - R.disponibles(avantS, id));
  assert.strictEqual(r.d.etat.points, avantS.points + voixS);
  console.log("API : tous les tests passent");
})().catch(e => { console.error(e); process.exit(1); });
