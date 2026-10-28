/* Parcours sans compte dans un vrai navigateur (Playwright), contre le site servi en local :
     (cd site && python3 -m http.server 8765)        dans un premier terminal
     node tests/ui.test.js [dossier des captures]    dans un second
   Playwright est cherché dans le projet, sinon parmi les modules installés globalement. */
const { chromium } = (() => {
  try { return require("playwright"); }
  catch (_) { return require(require.resolve("playwright", {paths: [require("child_process").execSync("npm root -g").toString().trim()]})); }
})();
const assert = require("assert");
const T = process.argv[2] || require("os").tmpdir();
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({viewport: {width: 1200, height: 900}});
  const erreurs = []; page.on("pageerror", e => erreurs.push(e.message)); page.on("console", m => m.type()==="error" && !/404|Failed to load resource/.test(m.text()) && erreurs.push(m.text()));
  await page.addInitScript(() => localStorage.setItem("hemicycle-accueil", "fait"));
  await page.goto("http://localhost:8765/");
  // État de la version 1, comme chez un joueur actuel : deux paquets ouverts aujourd'hui, des doubles
  await page.evaluate(() => {
    const d = new Date(), jour = d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
    localStorage.setItem("hemicycle-collection", JSON.stringify({possedees: {"2922": 3}, jour, ouverts: 2}));
  });
  await page.reload(); await page.waitForSelector("#paquet");
  assert.match(await page.textContent("#restants"), /10 paquets à ouvrir.*Réserve : 10 sur 10.*Réserve pleine/s);
  await page.click("#voix-tete"); assert.ok(await page.isVisible("#encart-voix"));
  await page.click("h1"); assert.ok(!(await page.isVisible("#encart-voix")));
  // Ouvrir le dernier paquet du jour et aller au récapitulatif
  await page.click("#paquet"); await page.waitForSelector("#suite");
  assert.strictEqual(await page.locator("#envers").count(), 0, "plus de bouton Verso");
  // Toucher la carte la retourne ; l'étoile la met en favori sans la retourner
  await page.waitForSelector("#courante.retournee");
  await page.click("#courante"); assert.ok(await page.evaluate(() => document.getElementById("courante").classList.contains("envers")));
  const premiere = await page.getAttribute("#courante", "data-id");
  const avantEnvers = await page.evaluate(() => document.getElementById("courante").classList.contains("envers"));
  await page.click("#courante"); // revenir au recto, où se trouve l'étoile
  await page.click("#courante [data-favori]");
  await page.waitForFunction(id => JSON.parse(localStorage.getItem("hemicycle-collection")).favoris.includes(id), premiere);
  assert.strictEqual(await page.getAttribute("#courante [data-favori]", "aria-pressed"), "true");
  assert.ok(!(await page.evaluate(() => document.getElementById("courante").classList.contains("envers"))), "l'étoile ne retourne pas la carte");
  assert.ok(avantEnvers && !(await page.isVisible("#qag")), "questions masquées pendant la découverte");
  for (let i = 0; i < 5; i++) await page.click("#suite");
  await page.waitForSelector(".recap");
  assert.strictEqual(await page.locator("#revoir").count(), 0);
  const etat = await page.evaluate(() => JSON.parse(localStorage.getItem("hemicycle-collection")));
  assert.strictEqual(etat.version, 3); assert.strictEqual(etat.reserve, 9); assert.strictEqual(etat.possedees["2922"] >= 3, true);
  assert.ok(await page.isVisible("#suivant"), "il reste des paquets en réserve");
  // Doubles et objectif atteint : Edgar Faure n'est pas un Quatre-vingts ; on donne au joueur cinq Quatre-vingts
  await page.evaluate(() => {
    const e = JSON.parse(localStorage.getItem("hemicycle-collection"));
    const qv = cat.objectifParId["quatre-vingts"].ids.slice(0, 5);
    qv.forEach(id => e.possedees[id] = 2);
    const com = cat.parRarete["commune"].slice(0, 30); com.forEach(c => e.possedees[c.id] = 2);
    localStorage.setItem("hemicycle-collection", JSON.stringify(e));
  });
  await page.reload(); await page.waitForSelector("#pastille:not([hidden])");
  const attente = Number(await page.textContent("#pastille")); const attendu = await page.evaluate(() => Regles.recompensesEnAttente(etat, cat).objectifs); assert.strictEqual(attente, attendu); assert.ok(attente >= 3); console.log("paquets à réclamer :", attente);
  await page.screenshot({path: T + "/paquets-desktop.png"});
  // Collection : recyclage des communes seulement (cochées par défaut avec peu communes et rares)
  await page.click('nav [data-vue="collection"]');
  await page.waitForSelector("#recycler");
  await page.click('[data-pastille="favoris"]');
  assert.strictEqual(await page.getAttribute('[data-pastille="favoris"]', "aria-pressed"), "true");
  assert.strictEqual(await page.locator("#grille .carte").count(), 1, "filtre des favoris");
  // Toucher une carte l'ouvre en grand
  await page.click("#grille .carte .portrait"); await page.waitForSelector("#apercu[open] #actions-apercu");
  await page.click("#fermer-apercu");
  await page.click(`#grille [data-favori]`);
  await page.waitForSelector("#grille .vide");
  await page.click('[data-pastille="favoris"]'); assert.strictEqual(await page.inputValue("#filtre"), "");
  await page.click('[data-pastille="commune"]'); assert.strictEqual(await page.inputValue("#filtre"), "commune");
  await page.click('[data-pastille="commune"]'); assert.strictEqual(await page.inputValue("#filtre"), "");
  // Dissolution des doubles d'une seule carte depuis la grande carte
  const dbl = await page.evaluate(() => Object.keys(etat.possedees).find(id => Regles.recyclables(etat, id) > 0 && cat.parId[id].rarete === "commune"));
  await page.evaluate(id => apercu(id), dbl); page.once("dialog", d => d.accept());
  await page.click("[data-dissoudre]");
  await page.waitForFunction(id => etat.possedees[id] === 1, dbl);
  await page.click("#fermer-apercu");
  // Vue des doubles : seules les cartes en plusieurs exemplaires, puis retour à toute la collection
  await page.click("#voir-doubles"); assert.strictEqual(await page.inputValue("#filtre"), "doubles");
  const vues = await page.evaluate(() => [...document.querySelectorAll("#grille .carte")].map(c => etat.possedees[c.dataset.id]));
  assert.ok(vues.length > 0 && vues.every(n => n > 1), "seulement des doubles : " + vues.join(","));
  await page.click("#voir-doubles"); assert.strictEqual(await page.inputValue("#filtre"), "");
  const libelle = await page.textContent("#recycler");
  page.once("dialog", d => d.accept());
  await page.screenshot({path: T + "/collection-desktop.png", fullPage: false});
  await page.click("#recycler");
  await page.waitForFunction(() => /dissous/.test(document.querySelector(".annonce").textContent));
  const e2 = await page.evaluate(() => JSON.parse(localStorage.getItem("hemicycle-collection")));
  console.log("bouton :", libelle.trim(), "| points :", e2.points);
  // L'échange de voix contre un paquet n'est pas proposé dans l'Hémicycle, mais dans l'encart des voix
  assert.ok(e2.points >= 30); assert.match(await page.textContent("#atelier"), /^(?![\s\S]*contre un paquet)/);
  await page.click("#voix-tete"); await page.click("#voix-paquet");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("hemicycle-collection")).offerts === 1);
  const e3 = await page.evaluate(() => JSON.parse(localStorage.getItem("hemicycle-collection")));
  assert.strictEqual(e3.offerts, 1); assert.strictEqual(e3.points, e2.points - 25);
  // Objectifs : réclamer les paliers des Quatre-vingts
  await page.click('nav [data-vue="objectifs"]');
  await page.click("details.rubrique:has(#obj-historiques) summary");
  await page.waitForSelector('[data-reclamer="quatre-vingts"]');
  await page.screenshot({path: T + "/objectifs-desktop.png"});
  await page.click('[data-reclamer="quatre-vingts"]');
  const e4 = await page.evaluate(() => JSON.parse(localStorage.getItem("hemicycle-collection")));
  assert.strictEqual(e4.offerts, 3); assert.ok(e4.objectifs["quatre-vingts@1"] && e4.objectifs["quatre-vingts@5"]);
  assert.strictEqual(await page.evaluate(() => Regles.recompensesEnAttente(etat, cat).objectifs), attente - 1);
  assert.ok(await page.isVisible("#synthese-objectifs"));
  await page.click("details.rubrique:has(#recherche-dep) summary");
  await page.fill("#recherche-dep", "gironde");
  assert.strictEqual(await page.locator("#obj-departements .objectif").count(), 1);
  // Par numéro (Code officiel géographique de l'Insee) : « 33 », « 1 » pour l'Ain, « 2a » pour la Corse-du-Sud
  for (const [q, nom] of [["33", "Gironde"], ["1", "Ain"], ["2A", "Corse-du-Sud"]]) {
    await page.fill("#recherche-dep", q);
    await page.waitForFunction(n => [...document.querySelectorAll("#obj-departements .objectif h3")].map(h => h.firstChild.textContent.trim()).join("|") === n, nom);
  }
  // Rubriques longues : huit objectifs, puis un bouton pour le reste
  await page.click("details.rubrique:has(#obj-legislatures) summary");
  assert.strictEqual(await page.locator("#obj-legislatures .objectif").count(), 8);
  await page.click('[data-tout-voir="legislatures"]');
  assert.ok(await page.locator("#obj-legislatures .objectif").count() > 8);
  // Paquets : les offerts s'ouvrent une fois la réserve vide
  await page.evaluate(() => { etat.reserve = 0; etat.ancre = Date.now(); sauver(); });
  await page.click('nav [data-vue="paquet"]');
  await page.waitForSelector("#paquet .mention");
  assert.match(await page.textContent("#restants"), /paquets offerts en plus.*Prochain paquet dans/s);
  await page.click("#paquet"); await page.waitForSelector("#suite");
  const e5 = await page.evaluate(() => JSON.parse(localStorage.getItem("hemicycle-collection")));
  assert.strictEqual(e5.offerts, 2); assert.strictEqual(e5.reserve, 0);
  // Questions au Gouvernement : cinq questions, récompense une fois par jour (masquées pendant la découverte)
  for (let i = 0; i < 5; i++) await page.click("#suite");
  await page.waitForSelector(".recap"); assert.ok(!(await page.isVisible("#qag")));
  // Deuxième paquet ouvert : thème et notifications proposés, une seule fois
  await page.waitForSelector("#preferences[open]");
  assert.match(await page.textContent("#preferences"), /Avec un compte/);
  await page.click('[data-pref-theme="clair"]'); assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), "clair");
  await page.click('[data-pref-theme="sombre"]'); assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), "sombre");
  await page.screenshot({path: T + "/preferences.png"});
  await page.click("#pref-fermer"); assert.ok(!(await page.isVisible("#preferences")));
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("hemicycle-preferences")), "proposees");
  await page.click('nav [data-vue="collection"]'); await page.click('nav [data-vue="paquet"]');
  await page.click("#qag-jour");
  for (let i = 0; i < 5; i++) {
    await page.waitForSelector(".choix-q button:not([disabled])");
    const bonne = await page.evaluate(() => quiz.liste[quiz.i].bonne);
    await page.click(`.choix-q button[data-choix="${bonne}"]`);
    await page.click("#qag-suite");
  }
  await page.waitForSelector("#qag-fermer");
  assert.match(await page.textContent("#qag"), /15 voix gagnées/);
  await page.click("#qag-fermer");
  assert.ok(!(await page.isVisible("#qag-jour")), "questions du jour faites");
  // Téléphone
  const tel = await b.newPage({viewport: {width: 390, height: 844}, isMobile: true});
  await tel.addInitScript(() => localStorage.setItem("hemicycle-accueil", "fait"));
  await tel.goto("http://localhost:8765/");
  // Récapitulatif d'un paquet : tout en bas de la page, le bouton reste entier au-dessus de la barre d'onglets
  await tel.click("#paquet"); await tel.waitForSelector("#suite");
  for (let i = 0; i < 5; i++) await tel.click("#suite");
  await tel.waitForSelector(".recap"); await tel.waitForSelector("#suivant");
  await tel.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await tel.waitForTimeout(300);
  const [basBouton, hautBarre] = await tel.evaluate(() => [document.getElementById("suivant").getBoundingClientRect().bottom,
    document.querySelector("nav").getBoundingClientRect().top]);
  assert.ok(basBouton + 8 <= hautBarre, `bouton du récapitulatif sous la barre d'onglets (${basBouton} / ${hautBarre})`);
  await tel.screenshot({path: T + "/recap-bas-tel.png"});
  await tel.evaluate(s => localStorage.setItem("hemicycle-collection", s), JSON.stringify(e5));
  await tel.reload(); await tel.waitForSelector("#paquet");
  await tel.click('nav [data-vue="objectifs"]'); await tel.waitForSelector(".objectif");
  await tel.screenshot({path: T + "/objectifs-tel.png"});
  await tel.click('nav [data-vue="plus"]'); await tel.click('[data-menu="catalogue"]'); await tel.waitForSelector("#cat-grille .carte");
  assert.ok(await tel.locator("#cat-grille .carte.manquante").count() > 0, "cartes manquantes grisées");
  await tel.selectOption("#cat-possession", "obtenues");
  assert.strictEqual(await tel.locator("#cat-grille .carte.manquante").count(), 0);
  await tel.screenshot({path: T + "/plus-tel.png"});
  await tel.click('nav [data-vue="plus"]'); await tel.click('[data-menu="parametres"]'); await tel.waitForSelector("#vue-parametres a[href='mentions.html']");
  await tel.click('[data-theme-choix="clair"]'); assert.strictEqual(await tel.evaluate(() => document.documentElement.dataset.theme), "clair");
  await tel.screenshot({path: T + "/parametres-clair-tel.png", fullPage: true});
  await tel.click('nav [data-vue="collection"]'); await tel.waitForTimeout(300); await tel.screenshot({path: T + "/hemi-clair-tel.png"});
  await tel.click('nav [data-vue="plus"]'); await tel.click('[data-menu="parametres"]'); await tel.click('[data-theme-choix="sombre"]');
  await tel.click('nav [data-vue="plus"]'); await tel.click('[data-menu="apropos"]'); assert.ok(await tel.isVisible("#vue-apropos h2"));
  assert.strictEqual(await tel.locator("footer").count(), 0);
  await tel.click('nav [data-vue="amis"]'); await tel.waitForSelector("#vue-amis h2");
  await tel.click('nav [data-vue="collection"]'); await tel.waitForSelector("#atelier");
  await tel.screenshot({path: T + "/collection-tel.png"});
  const deborde = await tel.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.ok(!deborde, "défilement horizontal sur téléphone");
  assert.deepStrictEqual(erreurs, []);
  console.log("parcours complet sans erreur");
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
