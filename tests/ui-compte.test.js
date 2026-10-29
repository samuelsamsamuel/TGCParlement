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
  // Vues du menu Plus : onglet direct sur grand écran, menu Plus ailleurs
  const vers = async (P, vue) => {
    if (await P.isVisible(`nav [data-vue="${vue}"]`)) await P.click(`nav [data-vue="${vue}"]`);
    else { await P.click('nav [data-vue="plus"]'); await P.click(`[data-menu="${vue}"]`); }
  };
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
  await vers(A, "compte");
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
  await vers(Bp, "compte");
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
  // Ses cartes en vente : en tête du comptoir, avec Retirer sur l'étal
  await A.waitForFunction(() => document.querySelectorAll('#liste-marche [data-action$=":retirer"]').length === 1);
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
  // Contre-offre : Anne pose une carte à 10 voix ; Bob offre 6, Anne l'accepte sous sa carte (pastille de la buvette)
  await A.click('.onglets [data-sous="comptoir"]');
  await A.click('[data-choisir-vente]'); await A.waitForSelector("#choix-carte[open] [data-choisir]");
  await A.click("#choix-carte [data-choisir]"); await A.waitForSelector("#zone-vente .vente .carte");
  await A.fill('#zone-vente [name=prix]', "10"); await A.click('#zone-vente button[type=submit]');
  await A.waitForFunction(() => document.querySelectorAll('#liste-marche [data-action$=":retirer"]').length === 1);
  await Bp.reload(); await Bp.click('nav [data-vue="buvette"]'); await Bp.click('.onglets [data-sous="comptoir"]');
  await Bp.waitForSelector("[data-offre]"); await Bp.click("[data-offre]");
  await Bp.fill("[data-form-offre] [name=prix]", "6"); await Bp.click("[data-form-offre] button[type=submit]");
  await Bp.waitForSelector(".offre-faite");
  await Bp.screenshot({path: T + "/offre-tel.png", fullPage: true});
  await A.reload(); await A.waitForFunction(() => document.getElementById("pastille-buvette").textContent === "1");
  await A.click('nav [data-vue="buvette"]'); await A.click('.onglets [data-sous="comptoir"]');
  await A.waitForSelector('.offre-recue [data-action$=":accepter"]');
  await A.screenshot({path: T + "/offre-recue.png", fullPage: true});
  await A.click('.offre-recue [data-action$=":accepter"]');
  await A.waitForFunction(() => etat.points === 18 && !document.querySelector(".offre-recue"));
  // Voix d'un échange affichées avec les cartes ; alerte de vente posée depuis la grande carte
  assert.match(await A.evaluate(() => lotVoix({}, 5) + "|" + lotVoix({[cartes[0].id]: 1}, 3)), /^<span class="voix-lot">5 voix<\/span>\|.*\+ 3 voix/);
  // Alerte de vente : seulement depuis « Toutes les cartes », pas depuis l'hémicycle
  await Bp.evaluate(() => apercu(cartes[0].id)); assert.ok(!(await Bp.isVisible("[data-alerte]"))); await Bp.click("#fermer-apercu");
  await Bp.evaluate(() => apercu(cartes[0].id, true)); await Bp.click("[data-alerte]");
  await Bp.waitForSelector('[data-alerte][aria-pressed="true"]'); await Bp.click("#fermer-apercu");
  assert.strictEqual(await Bp.evaluate(() => alertes.size), 1);
  // Voix remises comme avant la contre-offre pour la suite du parcours (Anne 12, Bob 18)
  require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "UPDATE joueurs SET points = CASE pseudo WHEN 'Anne${sx}' THEN 12 ELSE 18 END WHERE pseudo IN ('Anne${sx}', 'Bob${sx}')"`, {stdio: "ignore"});
  await A.reload(); await A.waitForFunction(() => compte && etat.points === 12);
  await Bp.reload(); await Bp.waitForFunction(() => compte && etat.points === 18);
  await A.click('nav [data-vue="buvette"]'); await A.click('.onglets [data-sous="historique"]');
  // Aperçu d'une carte depuis l'historique
  await A.click('#historique .mini-ami'); await A.waitForSelector("#apercu[open] .carte");
  await A.click("#fermer-apercu");
  // Duel avec mise : Anne défie Bob pour 10 voix, Bob relève le défi depuis la pastille ; le serveur juge chaque réponse
  await A.click('nav [data-vue="duels"]');
  // Pastille d'un ami : son pseudo passe dans le champ, la pastille est marquée
  await A.click(`#form-duel [data-defier="Bob${sx}"] .avatar-ami`);
  assert.strictEqual(await A.inputValue('#form-duel [name=pseudo]'), "Bob" + sx);
  assert.strictEqual(await A.getAttribute(`#form-duel [data-defier="Bob${sx}"]`, "aria-pressed"), "true");
  await A.screenshot({path: T + "/duel-amis.png"});
  await A.fill('#form-duel [name=pseudo]', "bob" + sx);
  await A.selectOption('#form-duel [name=mise]', "v10");
  await A.click('#form-duel button[type=submit]');
  await A.waitForFunction(() => etat.points === 2);
  const repondre = async (P, choix) => { for (let i = 0; i < 5; i++) {
    await P.waitForSelector(".choix-q button:not([disabled])"); await P.click(`.choix-q button[data-choix="${choix}"]`);
    await P.waitForSelector("#qag-suite"); await P.click("#qag-suite"); } };
  await repondre(A, 0);
  await A.waitForSelector("#qag-fermer"); await A.click("#qag-fermer");
  await Bp.reload(); await Bp.waitForSelector("#pastille-duels:not([hidden])");
  // Séance : un renvoi vers l'onglet Duels, qui porte défis, parties et historique
  await Bp.waitForSelector("#qag [data-aller-duels]"); await Bp.click("#qag [data-aller-duels]");
  await Bp.waitForSelector("#vue-duels [data-relever]"); await Bp.waitForLoadState("networkidle"); await Bp.screenshot({path: T + "/duels-tel.png"});
  await Bp.click("[data-relever]"); await Bp.waitForFunction(() => etat.points === 8);
  await Bp.screenshot({path: T + "/duel-tel.png", fullPage: true});
  await repondre(Bp, 1);
  await Bp.waitForFunction(() => /Duel terminé/.test(document.getElementById("vue-duels").textContent));
  await Bp.click("#qag-fermer");
  await Bp.waitForFunction(() => /Historique[\s\S]*Contre .* : \d à \d/.test(document.getElementById("vue-duels").textContent));
  await Bp.screenshot({path: T + "/duels-historique-tel.png", fullPage: true});
  assert.ok(!/Contre/.test(await Bp.textContent("#qag")), "plus d'historique des duels en séance");
  await A.reload(); await A.waitForFunction(() => compte && [2, 12, 22].includes(etat.points));
  // Vitrine d'Anne, faite de ses favoris, visible par Bob depuis ses amis
  await A.click('nav [data-vue="collection"]'); await A.click('#grille [data-favori]');
  await A.waitForFunction(() => etat.favoris.length === 1);
  await vers(A, "compte");
  for (let k = 0; k < 2; k++) {
    await A.click('#ma-vitrine [data-ajout-vitrine]'); await A.waitForSelector("#choix-carte[open] [data-choisir]");
    await A.click("#choix-carte [data-choisir]");
    await A.waitForFunction(n => document.querySelectorAll("#ma-vitrine .carte").length === n, k + 1);
  }
  await A.click('#ma-vitrine [data-retirer-vitrine]');
  await A.waitForFunction(() => document.querySelectorAll("#ma-vitrine .carte").length === 1 && compte.vitrine.length === 1);
  // Grande carte : « Mettre en vitrine », puis glisser-déposer pour changer l'ordre dans Mon siège
  const autre = await A.evaluate(() => Object.keys(etat.possedees).find(id => !compte.vitrine.includes(id)));
  await A.click('nav [data-vue="collection"]'); await A.evaluate(id => apercu(id), autre);
  await A.click(`[data-vitrine-ajouter="${autre}"]`);
  await A.waitForFunction(id => compte.vitrine.length === 2 && compte.vitrine[1] === id, autre);
  await A.waitForSelector(`[data-vitrine-retirer="${autre}"]`); await A.click("#fermer-apercu");
  await vers(A, "compte"); await A.waitForFunction(() => document.querySelectorAll("#ma-vitrine .case-vitrine.pleine").length === 2);
  const [c0, c1] = [await A.locator("#ma-vitrine .case-vitrine.pleine").nth(0).boundingBox(), await A.locator("#ma-vitrine .case-vitrine.pleine").nth(1).boundingBox()];
  await A.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2); await A.mouse.down();
  await A.mouse.move(c1.x + c1.width / 2 - 20, c1.y + c1.height / 2, {steps: 3});
  await A.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2, {steps: 8}); await A.mouse.up();
  await A.waitForFunction(id => compte.vitrine[0] === id, autre);
  assert.strictEqual((await A.evaluate(() => fetch("/api/moi").then(r => r.json()))).vitrine[0], autre, "ordre enregistré");
  // Dissoudre une carte sans double : elle quitte la collection contre ses voix
  const seule = await A.evaluate(() => Object.keys(etat.possedees).find(id => etat.possedees[id] === 1 && Regles.disponibles(etat, id) === 1 && !compte.vitrine.includes(id)));
  const voixAvantDissolution = await A.evaluate(() => etat.points);
  await A.click('nav [data-vue="collection"]'); await A.evaluate(id => apercu(id), seule);
  await A.click(`[data-dissoudre="${seule}"][data-tout]`);
  await A.waitForFunction(([id, v]) => !etat.possedees[id] && etat.points > v && etat.deja.includes(id), [seule, voixAvantDissolution]);
  await A.click("#fermer-apercu");
  // Vitrine pleine : « Mettre en vitrine » fait choisir la carte à remplacer, qui cède sa case
  const six = await A.evaluate(async () => { const ids = Object.keys(etat.possedees).filter(id => etat.possedees[id] > 0).slice(0, 7); await exposerVitrine(ids.slice(0, 6)); return ids; });
  await A.evaluate(id => apercu(id), six[6]); await A.click(`[data-vitrine-ajouter="${six[6]}"]`);
  await A.waitForSelector(`#choix-carte[open] [data-choisir="${six[2]}"]`); await A.click(`#choix-carte [data-choisir="${six[2]}"]`);
  await A.waitForFunction(([nouvelle, ancienne]) => compte.vitrine[2] === nouvelle && !compte.vitrine.includes(ancienne) && compte.vitrine.length === 6, [six[6], six[2]]);
  await A.click("#fermer-apercu");
  await vers(A, "parametres");
  await A.waitForSelector("#zone-suppression summary");
  await vers(A, "compte");
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
  await vers(A, "parametres"); await A.waitForSelector("#zone-mdp");
  await A.click("#zone-mdp summary");
  await A.fill('#form-mdp [name=ancien]', "pas-le-bon-mdp"); await A.fill('#form-mdp [name=nouveau]', "nouveau-motdepasse"); await A.fill('#form-mdp [name=nouveau2]', "nouveau-motdepasse");
  await A.click('#form-mdp button[type=submit]');
  await A.waitForFunction(() => /incorrect/.test(document.getElementById("erreur-mdp").textContent), null, {timeout: 20000});
  await A.fill('#form-mdp [name=ancien]', "motdepasse-long"); await A.click('#form-mdp button[type=submit]');
  await A.waitForFunction(() => !document.getElementById("zone-mdp").open, null, {timeout: 20000});
  // Déconnexion : retour à la collection locale du navigateur
  await A.waitForSelector("#deconnexion"); await A.click("#deconnexion");
  await A.waitForFunction(() => !compte); await vers(A, "compte"); await A.waitForSelector("#form-compte");
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
