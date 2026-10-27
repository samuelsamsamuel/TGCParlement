/* Test de l'API sur un serveur local, à lancer depuis la racine du dépôt :
     npx wrangler dev --port 8787 --test-scheduled --var CODE_ESSAI:1 --persist-to /tmp/hemicycle-d1     (dans un premier terminal)
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
  assert.ok(!r.d.etat.verrous[com], "exemplaires repris libres");
  assert.ok(r.d.etat.objectifs["quatre-vingts@1"], "palier déjà atteint marqué réclamé");
  assert.strictEqual(R.recompensesEnAttente(r.d.etat, cat).objectifs, 0);
  // Grande collection reprise (au-delà de 100 paramètres D1 par requête) en une seule transaction
  const grande = {}; cat.cartes.slice(100, 400).forEach(c => grande[c.id] = 1);
  r = await client()("inscription", {pseudo: "grand" + suffixe, preuve: preuve("g"), collection: grande}, {"cf-connecting-ip": "10.0.0." + (++ip)});
  assert.strictEqual(r.statut, 201, JSON.stringify(r.d)); assert.strictEqual(Object.keys(r.d.etat.possedees).length, 300);
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
  // Duel : même graine pour les deux, score de l'adversaire caché tant qu'on n'a pas joué, une seule fois
  r = await A("duels", {vers: "carole" + suffixe}); assert.strictEqual(r.statut, 201);
  const duel = r.d.id, graine = r.d.graine;
  assert.strictEqual((await C("attente")).d.duels, 1);
  assert.strictEqual((await A("duels/" + duel + "/score", {bonnes: 4})).statut, 200);
  assert.strictEqual((await A("duels/" + duel + "/score", {bonnes: 5})).statut, 409);
  let vueC = (await C("duels")).d.duels.find(x => x.id === duel);
  assert.strictEqual(vueC.graine, graine); assert.strictEqual(vueC.sien, null);
  assert.strictEqual((await C("duels/" + duel + "/score", {bonnes: 2})).statut, 200);
  vueC = (await C("duels")).d.duels.find(x => x.id === duel);
  assert.ok(vueC.termine); assert.strictEqual(vueC.sien, 4);
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
  // Réserve pleine (tâche horaire, wrangler dev --test-scheduled) : seulement après un vrai remplissage, une fois
  const sql = c => require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "${c}"`, {stdio: "ignore"});
  const horaire = async () => assert.strictEqual((await fetch("http://localhost:8787/cdn-cgi/handler/scheduled")).status, 200);
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
  console.log("API : tous les tests passent");
})().catch(e => { console.error(e); process.exit(1); });
