/* Parcours avec comptes (deux joueurs : amis, échange, comptoir, duel, vitrine) contre le Worker local :
     npx wrangler dev --port 8787 --persist-to /tmp/hemicycle-d1
     WR="npx wrangler" ETAT=/tmp/hemicycle-d1 node tests/ui-compte.test.js [dossier des captures] */
const { chromium } = (() => {
  try { return require("playwright"); }
  catch (_) { return require(require.resolve("playwright", {paths: [require("child_process").execSync("npm root -g").toString().trim()]})); }
})();
const assert = require("assert");
const T = process.argv[2] || require("os").tmpdir(), U = "http://localhost:8787/";
const sx = Date.now().toString(36).slice(-4);
(async () => {
  // Les inscriptions sont limitées par adresse : on efface les compteurs de la base locale avant le parcours
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "DELETE FROM tentatives"`, {stdio: "ignore"});
  const b = await chromium.launch();
  const erreurs = [];
  const nouvelle = async (largeur = 1200) => {
    const ctx = await b.newContext({viewport: {width: largeur, height: 900}});
    await ctx.addInitScript(() => localStorage.setItem("hemicycle-accueil", "fait"));
    const p = await ctx.newPage();
    p.on("pageerror", e => erreurs.push(e.message)); p.on("console", m => m.type() === "error" && !/40[139]|429|Failed to load resource/.test(m.text()) && erreurs.push(m.text()));
    p.on("dialog", d => d.accept());
    return p;
  };
  const A = await nouvelle();
  await A.goto(U); await A.waitForSelector("#paquet");
  // Collection locale : on ouvre un paquet sans compte
  await A.click("#paquet"); await A.waitForSelector("#suite");
  const locales = await A.evaluate(() => Object.keys(etat.possedees).length);
  // Création du compte avec reprise
  await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="compte"]');
  await A.fill('#form-compte [name=pseudo]', "Anne" + sx);
  await A.fill('#form-compte [name=mdp]', "motdepasse-long");
  await A.fill('#form-compte [name=mdp2]', "motdepasse-long");
  assert.ok(await A.isChecked('#form-compte [name=reprise]'));
  await A.click('#form-compte button[type=submit]');
  await A.waitForSelector("#compte-principal .chiffres", {timeout: 20000});
  assert.strictEqual(await A.textContent("#nav-compte"), "Anne" + sx);
  assert.strictEqual(await A.evaluate(() => Object.keys(etat.possedees).length), locales);
  await A.screenshot({path: T + "/compte.png"});
  // Paquet tiré par le serveur
  await A.click('nav [data-vue="paquet"]'); await A.waitForSelector("#paquet");
  await A.click("#paquet"); await A.waitForSelector("#suite");
  for (let i = 0; i < 5; i++) await A.click("#suite");
  const serveurA = await A.evaluate(() => fetch("/api/moi").then(r => r.json()));
  assert.strictEqual(Object.values(serveurA.etat.possedees).reduce((a, n) => a + n, 0), 10);
  assert.strictEqual(await A.evaluate(() => Object.values(etat.verrous || {}).reduce((a, n) => a + n, 0)), 0, "exemplaires repris libres");
  // Bob : un autre navigateur, inscription sans collection, un paquet
  const Bp = await nouvelle(390);
  await Bp.goto(U); await Bp.waitForSelector("#paquet");
  await Bp.click('nav [data-vue="plus"]'); await Bp.click('[data-menu="compte"]');
  await Bp.fill('#form-compte [name=pseudo]', "Bob" + sx);
  await Bp.fill('#form-compte [name=mdp]', "autre-mot-de-passe");
  await Bp.fill('#form-compte [name=mdp2]', "autre-mot-de-passe");
  await Bp.click('#form-compte button[type=submit]'); await Bp.waitForSelector("#compte-principal .chiffres", {timeout: 20000});
  await Bp.click('nav [data-vue="paquet"]'); await Bp.waitForSelector("#paquet");
  await Bp.click("#paquet"); await Bp.waitForSelector("#suite");
  // Amis : Anne envoie une demande, Bob voit la pastille et accepte
  await A.click('nav [data-vue="amis"]'); await A.waitForSelector("#form-ami");
  await A.fill('#form-ami [name=pseudo]', "bob" + sx); await A.click('#form-ami button');
  await A.waitForFunction(() => /Demandes envoyées/.test(document.getElementById("vue-amis").textContent));
  await Bp.reload(); await Bp.waitForSelector("#pastille-amis:not([hidden])");
  await Bp.click('nav [data-vue="amis"]'); await Bp.waitForSelector('[data-ami^="accepter:"]');
  await Bp.click('[data-ami^="accepter:"]');
  await Bp.waitForSelector('[data-echange-ami="Anne' + sx + '"]');
  await Bp.screenshot({path: T + "/amis-tel.png", fullPage: true});
  // « Qui a cette carte ? » : Anne cherche une carte de Bob, puis « Lui demander » prépare l'échange
  const carteBob = await Bp.evaluate(() => { const id = Object.keys(etat.possedees)[0]; return {id, nom: cat.parId[id].nom}; });
  await A.reload(); await A.click('nav [data-vue="amis"]'); await A.waitForSelector("#carte-amis");
  await A.fill("#carte-amis", carteBob.nom); await A.click(`[data-carte-amis="${carteBob.id}"]`);
  await A.waitForSelector(`[data-demander-ami="Bob${sx}"]`);
  await A.screenshot({path: T + "/amis-carte.png", fullPage: true});
  await A.click(`[data-demander-ami="Bob${sx}"]`);
  await A.waitForSelector(`#sel-recoit [data-retrait="${carteBob.id}"]`);
  // Anne propose un échange à Bob depuis l'onglet Amis : une carte libre contre une carte de Bob
  await A.reload(); await A.click('nav [data-vue="amis"]');
  await A.waitForSelector('[data-echange-ami="Bob' + sx + '"]'); await A.click('[data-echange-ami="Bob' + sx + '"]');
  assert.ok(await A.isVisible('#vue-buvette [data-partenaire="Bob' + sx + '"]'));
  await A.waitForSelector('#etapes-echange:not([hidden]) #sel-recoit [data-ajout]');
  for (const zone of ["#sel-recoit", "#sel-donne"]) {
    await A.click(zone + ' [data-ajout]'); await A.waitForSelector("#choix-carte[open] [data-choisir]");
    await A.click("#choix-carte [data-choisir]"); await A.waitForSelector(zone + " .puce");
  }
  await A.click("#proposer");
  await A.waitForFunction(() => /en attente/.test(document.getElementById("liste-echanges").textContent));
  await A.screenshot({path: T + "/bourse.png", fullPage: true});
  // Bob accepte
  await Bp.click('nav [data-vue="buvette"]');
  await Bp.waitForSelector('[data-action$=":accepter"]');
  await Bp.screenshot({path: T + "/bourse-tel.png", fullPage: true});
  await Bp.click('[data-action$=":accepter"]');
  await Bp.waitForFunction(() => /accepté/.test(document.getElementById("historique").textContent) && !document.querySelector("#liste-echanges [data-action]"));
  // Anne met une carte en vente ; Bob, crédité de points, l'achète
  await A.reload(); await A.click('nav [data-vue="buvette"]'); await A.click('.onglets [data-sous="comptoir"]');
  await A.click('[data-choisir-vente]'); await A.waitForSelector("#choix-carte[open] [data-choisir]");
  await A.click("#choix-carte [data-choisir]");
  await A.waitForSelector("#zone-vente .vente .carte");
  await A.screenshot({path: T + "/vente.png", fullPage: true});
  await A.fill('#zone-vente [name=prix]', "12");
  await A.click('#zone-vente button[type=submit]');
  await A.waitForFunction(() => /en vente/.test(document.getElementById("mes-annonces").textContent));
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "UPDATE joueurs SET points = 30 WHERE pseudo = 'Bob${sx}'"`, {stdio: "ignore"});
  await Bp.reload(); await Bp.click('nav [data-vue="buvette"]'); await Bp.click('.onglets [data-sous="comptoir"]');
  await Bp.waitForSelector('[data-action$=":acheter"]:not([disabled])');
  await Bp.screenshot({path: T + "/comptoir-tel.png", fullPage: true});
  await Bp.click('[data-action$=":acheter"]');
  await Bp.waitForFunction(() => etat.points === 18);
  // Historique (sous-onglet) : l'échange accepté et la vente, filtrables ; l'achat chez Bob
  await A.reload(); await A.click('nav [data-vue="buvette"]'); await A.click('.onglets [data-sous="historique"]');
  await A.waitForFunction(() => /Vendue à Bob/i.test(document.getElementById("historique").textContent) && /Échange avec Bob/i.test(document.getElementById("historique").textContent));
  assert.strictEqual(await A.evaluate(() => etat.points), 12);
  await A.screenshot({path: T + "/historique.png", fullPage: true});
  await A.click('[data-hist="comptoir"]'); assert.ok(!/Échange avec/.test(await A.textContent("#historique")));
  await A.click('[data-hist="tout"]');
  await Bp.click('nav [data-vue="buvette"]'); await Bp.click('.onglets [data-sous="historique"]');
  await Bp.waitForFunction(() => /Achetée à Anne/i.test(document.getElementById("historique").textContent));
  await Bp.screenshot({path: T + "/historique-tel.png", fullPage: true});
  // Aperçu d'une carte depuis l'historique
  await A.click('#historique .mini-ami'); await A.waitForSelector("#apercu[open] .carte");
  await A.click("#fermer-apercu");
  // Duel avec mise : Anne défie Bob pour 10 voix, Bob relève le défi depuis la pastille ; le serveur juge chaque réponse
  await A.click('nav [data-vue="paquet"]');
  await A.fill('#form-duel [name=pseudo]', "bob" + sx);
  await A.selectOption('#form-duel [name=mise]', "v10");
  await A.click('#form-duel button[type=submit]');
  await A.waitForFunction(() => etat.points === 2);
  const repondre = async (P, choix) => { for (let i = 0; i < 5; i++) {
    await P.waitForSelector(".choix-q button:not([disabled])"); await P.click(`.choix-q button[data-choix="${choix}"]`);
    await P.waitForSelector("#qag-suite"); await P.click("#qag-suite"); } };
  await repondre(A, 0);
  await A.waitForSelector("#qag-fermer"); await A.click("#qag-fermer");
  await Bp.reload(); await Bp.waitForSelector("#pastille-seance:not([hidden])");
  await Bp.waitForLoadState("networkidle"); await Bp.locator("#titre-duels").scrollIntoViewIfNeeded(); await Bp.screenshot({path: T + "/duels-tel.png"});
  await Bp.click("[data-relever]"); await Bp.waitForFunction(() => etat.points === 8);
  await Bp.screenshot({path: T + "/duel-tel.png", fullPage: true});
  await repondre(Bp, 1);
  await Bp.waitForFunction(() => /Duel terminé/.test(document.getElementById("qag").textContent));
  await Bp.click("#qag-fermer");
  await Bp.waitForFunction(() => /Contre .* : \d à \d/.test(document.getElementById("qag").textContent));
  await A.reload(); await A.waitForFunction(() => compte && [2, 12, 22].includes(etat.points));
  // Vitrine d'Anne, faite de ses favoris, visible par Bob depuis ses amis
  await A.click('nav [data-vue="collection"]'); await A.click('#grille [data-favori]');
  await A.waitForFunction(() => etat.favoris.length === 1);
  await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="compte"]');
  for (let k = 0; k < 2; k++) {
    await A.click('#ma-vitrine [data-ajout-vitrine]'); await A.waitForSelector("#choix-carte[open] [data-choisir]");
    await A.click("#choix-carte [data-choisir]");
    await A.waitForFunction(n => document.querySelectorAll("#ma-vitrine .carte").length === n, k + 1);
  }
  await A.click('#ma-vitrine [data-retirer-vitrine]');
  await A.waitForFunction(() => document.querySelectorAll("#ma-vitrine .carte").length === 1 && compte.vitrine.length === 1);
  await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="parametres"]');
  await A.waitForSelector("#zone-suppression summary");
  await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="compte"]');
  assert.strictEqual(await A.locator("text=Classement").count(), 0);
  assert.strictEqual(await A.locator("text=Ce que votre compte permet").count(), 0);
  // Code saisi dans Mon siège : voix créditées, puis refus à la seconde saisie
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "INSERT INTO codes (code, voix) VALUES ('ESSAI${sx}', 7)"`, {stdio: "ignore"});
  const voixAvant = await A.evaluate(() => etat.points);
  await A.fill('#form-code [name=code]', "essai" + sx); await A.click('#form-code button');
  await A.waitForFunction(() => /Code accepté : 7 voix/.test(document.getElementById("code-annonce").textContent));
  assert.strictEqual(await A.evaluate(() => etat.points), voixAvant + 7);
  await A.fill('#form-code [name=code]', "essai" + sx); await A.click('#form-code button');
  await A.waitForFunction(() => /déjà utilisé/.test(document.getElementById("code-annonce").textContent));
  await A.screenshot({path: T + "/compte-connecte.png", fullPage: true});
  // Fiche d'ami : aperçu de la vitrine d'Anne ; la toucher ouvre son profil, sans bouton de signalement
  await Bp.reload(); await Bp.click('nav [data-vue="amis"]');
  await Bp.waitForSelector('#vue-amis .tete-ami[data-profil="Anne' + sx + '"] .mini-ami');
  await Bp.screenshot({path: T + "/amis-vitrine-tel.png", fullPage: true});
  await Bp.click('#vue-amis .tete-ami[data-profil="Anne' + sx + '"]');
  await Bp.waitForSelector("#apercu[open] .vitrine .carte");
  await Bp.screenshot({path: T + "/profil-tel.png"});
  assert.strictEqual(await Bp.locator("#apercu [data-signaler]").count(), 0);
  await Bp.evaluate(() => document.getElementById("apercu").close());
  // Changement de mot de passe depuis les Paramètres : un mauvais mot de passe actuel est refusé, puis le bon
  await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="parametres"]'); await A.waitForSelector("#zone-mdp");
  await A.click("#zone-mdp summary");
  await A.fill('#form-mdp [name=ancien]', "pas-le-bon-mdp"); await A.fill('#form-mdp [name=nouveau]', "nouveau-motdepasse"); await A.fill('#form-mdp [name=nouveau2]', "nouveau-motdepasse");
  await A.click('#form-mdp button[type=submit]');
  await A.waitForFunction(() => /incorrect/.test(document.getElementById("erreur-mdp").textContent), null, {timeout: 20000});
  await A.fill('#form-mdp [name=ancien]', "motdepasse-long"); await A.click('#form-mdp button[type=submit]');
  await A.waitForFunction(() => !document.getElementById("zone-mdp").open, null, {timeout: 20000});
  // Déconnexion : retour à la collection locale du navigateur
  await A.waitForSelector("#deconnexion"); await A.click("#deconnexion");
  await A.waitForFunction(() => !compte); await A.click('nav [data-vue="plus"]'); await A.click('[data-menu="compte"]'); await A.waitForSelector("#form-compte");
  assert.strictEqual(await A.evaluate(() => Object.keys(etat.possedees).length), locales);
  // Reconnexion avec la casse différente du pseudo
  await A.click('[data-onglet="connexion"]');
  await A.fill('#form-compte [name=pseudo]', "anne" + sx);
  await A.fill('#form-compte [name=mdp]', "nouveau-motdepasse");
  await A.click('#form-compte button[type=submit]'); await A.waitForSelector("#compte-principal .chiffres", {timeout: 20000});
  const deborde = await Bp.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.ok(!deborde, "défilement horizontal sur téléphone");
  assert.deepStrictEqual(erreurs, []);
  console.log("interface avec comptes : parcours complet sans erreur");
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
