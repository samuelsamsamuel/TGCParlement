/* Première ouverture : accueil, visite guidée sans compte (site en local sur le port 8765) ; avec une adresse de
   Worker local en second argument, inscription, tutoriel d'installation et visite :
     WR="npx wrangler" ETAT=/tmp/hemicycle-d1 node tests/accueil.test.js [captures] http://localhost:8787/ */
const { chromium } = (() => {
  try { return require("playwright"); }
  catch (_) { return require(require.resolve("playwright", {paths: [require("child_process").execSync("npm root -g").toString().trim()]})); }
})();
const assert = require("assert");
const T = process.argv[2] || require("os").tmpdir(), U = process.argv[3] || "http://localhost:8765/";
(async () => {
  const b = await chromium.launch(), erreurs = [];
  const tel = async () => { const p = await (await b.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true})).newPage(); p.on("pageerror", e => erreurs.push(e.message)); return p; };
  // Sans compte : l'accueil, puis la visite qui fait ouvrir le premier paquet
  const p = await tel();
  await p.goto(U); await p.waitForSelector("#accueil[open]");
  await p.screenshot({path: T + "/accueil-tel.png"});
  await p.click('[data-accueil="navigateur"]');
  await p.waitForSelector("#guide:not([hidden])");
  assert.match(await p.textContent("#guide-texte"), /premier paquet/);
  await p.screenshot({path: T + "/visite1-tel.png"});
  assert.ok(!(await p.isVisible("#guide-suivant")), "il faut ouvrir le paquet");
  await p.click("#paquet");
  await p.waitForFunction(() => /retourner/.test(document.getElementById("guide-texte").textContent));
  await p.waitForSelector("#courante.retournee"); await p.waitForTimeout(700);
  await p.click("#courante .portrait");
  await p.waitForFunction(() => /étoile/.test(document.getElementById("guide-texte").textContent));
  await p.screenshot({path: T + "/visite3-tel.png"});
  await p.click("#guide-suivant");
  await p.waitForFunction(() => /d'une carte à l'autre/.test(document.getElementById("guide-texte").textContent));
  for (let i = 0; i < 5; i++) await p.click("#suite");
  await p.waitForFunction(() => /toutes les 30 minutes/.test(document.getElementById("guide-texte").textContent));
  let n = 0;
  while (await p.isVisible("#guide:not([hidden])") && n++ < 12) {
    if (n === 3) await p.screenshot({path: T + "/visite-nav-tel.png"});
    await p.click("#guide-suivant");
  }
  assert.ok(await p.isHidden("#guide"), "visite terminée");
  assert.strictEqual(await p.evaluate(() => localStorage.getItem("hemicycle-accueil")), "fait");
  await p.reload(); await p.waitForSelector("#paquet, #restants");
  await p.waitForTimeout(500); assert.ok(!(await p.isVisible("#accueil")), "plus d'accueil ensuite");
  // Avec compte (serveur local) : accueil, inscription, tutoriel d'installation, puis visite
  if (process.argv[3]) {
    require("child_process").execSync(`cd ${require("path").join(__dirname, "..")} && ${process.env.WR} d1 execute hemicycle --local --persist-to ${process.env.ETAT} --command "DELETE FROM tentatives"`, {stdio: "ignore"});
    const q = await tel(); q.on("dialog", d => d.accept());
    await q.goto(U); await q.waitForSelector("#accueil[open]");
    await q.click('[data-accueil="compte"]');
    const pseudo = "Accueil" + Date.now().toString(36).slice(-4);
    await q.fill('#form-compte [name=pseudo]', pseudo); await q.fill('#form-compte [name=mdp]', "motdepasse-long"); await q.fill('#form-compte [name=mdp2]', "motdepasse-long");
    await q.click('#form-compte button[type=submit]');
    await q.waitForSelector("#installation[open]", {timeout: 20000});
    await q.screenshot({path: T + "/installation-tel.png"});
    while (await q.isVisible("#installation[open]")) await q.click("#installation-suite");
    await q.waitForSelector("#guide:not([hidden])");
    assert.match(await q.textContent("#guide-texte"), /premier paquet/);
    await q.click("#guide-passer"); assert.ok(await q.isHidden("#guide"));
    // iPhone : étapes du bouton Partager
    const ios = await (await b.newContext({viewport: {width: 390, height: 844}, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"})).newPage();
    await ios.goto(U); await ios.waitForSelector("#accueil[open]");
    await ios.evaluate(() => { document.getElementById("accueil").close(); ouvrirInstallation(); });
    assert.match(await ios.textContent("#installation"), /Partager.*Sur l'écran d'accueil/s);
    await ios.click("#installation-suite"); await ios.screenshot({path: T + "/installation-ios-tel.png"});
  }
  assert.deepStrictEqual(erreurs, []);
  console.log("accueil et visite : parcours complet sans erreur");
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
