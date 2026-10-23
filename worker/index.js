/* Hémicycle : serveur (Cloudflare Worker et base D1).

Le Worker sert le site (dossier site/, en ressources statiques) et répond sous /api/ : comptes, collection,
paquets, recyclage, objectifs, échanges entre joueurs et marché. Les règles sont celles de site/regles.js,
exécutées ici : le serveur est seul juge des tirages et des récompenses, le navigateur n'envoie que des demandes.

Intégrité : chaque écriture est une variation (« n = n + d ») protégée par des contraintes de la base
(possessions jamais négatives, exemplaires verrouillés jamais cédés, trois paquets du jour au plus, points
jamais négatifs, palier réclamé une seule fois, annonce ou échange clos une seule fois). Toutes les écritures
d'une opération partent dans un même lot D1, exécuté comme une transaction : si deux demandes se croisent,
la seconde viole une contrainte, rien n'est écrit et le joueur est invité à recommencer.

Comptes : pseudo et mot de passe. Le mot de passe est étiré dans le navigateur (PBKDF2, 600 000 tours, sel
tiré du pseudo) ; le serveur reçoit cette « preuve » et n'en garde qu'une empreinte SHA-256 salée. Le calcul
lent reste ainsi dans le navigateur, ce qui tient dans les limites gratuites des Workers, et une fuite de la base
ne livre que des empreintes coûteuses à attaquer. Sessions : jeton aléatoire dans un cookie HttpOnly, dont la
base ne garde que l'empreinte.
*/
import Regles from "../site/regles.js";

const DUREE_SESSION = 90 * 24 * 3600;           // secondes
const COOKIE = "hemicycle_session";
const MAX_PAR_CARTE = 999;                       // exemplaires repris au plus par carte
const MAX_ECHANGE = 40;                          // cartes au plus dans un échange (deux côtés)
const MAX_ECHANGES_EN_COURS = 20, MAX_ANNONCES = 50;
const PRIX_MAX = 100000;
const LIMITES = {                                // tentatives par fenêtre de 15 minutes (1 heure pour les inscriptions)
  connexion: [10, 15 * 60], connexionIp: [40, 15 * 60], inscriptionIp: [5, 3600],
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS joueurs (
     id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE, sel TEXT NOT NULL, empreinte TEXT NOT NULL,
     cree TEXT NOT NULL,
     points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
     offerts INTEGER NOT NULL DEFAULT 0 CHECK (offerts >= 0),
     jour TEXT NOT NULL DEFAULT '',
     ouverts INTEGER NOT NULL DEFAULT 0 CHECK (ouverts BETWEEN 0 AND ${Regles.PAQUETS_PAR_JOUR}))`,
  `CREATE TABLE IF NOT EXISTS possessions (
     joueur INTEGER NOT NULL, carte TEXT NOT NULL,
     n INTEGER NOT NULL CHECK (n >= 0),
     importes INTEGER NOT NULL DEFAULT 0 CHECK (importes >= 0),
     reserve INTEGER NOT NULL DEFAULT 0 CHECK (reserve >= 0),
     CHECK (n >= importes + reserve),
     PRIMARY KEY (joueur, carte)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS reclames (joueur INTEGER NOT NULL, cle TEXT NOT NULL, date TEXT NOT NULL,
     PRIMARY KEY (joueur, cle)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY, joueur INTEGER NOT NULL, date TEXT NOT NULL,
     operation TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS journal_joueur ON journal (joueur, id)`,
  `CREATE TABLE IF NOT EXISTS sessions (jeton TEXT PRIMARY KEY, joueur INTEGER NOT NULL, expire INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_joueur ON sessions (joueur)`,
  `CREATE TABLE IF NOT EXISTS tentatives (cle TEXT PRIMARY KEY, n INTEGER NOT NULL, debut INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS echanges (id INTEGER PRIMARY KEY, de INTEGER NOT NULL, vers INTEGER NOT NULL,
     donne TEXT NOT NULL, recoit TEXT NOT NULL, statut TEXT NOT NULL, cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS echanges_vers ON echanges (vers, statut)`,
  `CREATE INDEX IF NOT EXISTS echanges_de ON echanges (de, statut)`,
  `CREATE TABLE IF NOT EXISTS annonces (id INTEGER PRIMARY KEY, vendeur INTEGER NOT NULL, carte TEXT NOT NULL,
     prix INTEGER NOT NULL CHECK (prix BETWEEN 1 AND ${PRIX_MAX}), statut TEXT NOT NULL, acheteur INTEGER,
     cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS annonces_statut ON annonces (statut, carte)`,
  `CREATE INDEX IF NOT EXISTS annonces_vendeur ON annonces (vendeur, statut)`,
  // Une annonce ou un échange ne se clôt qu'une fois : achat, retrait, acceptation, refus, annulation
  `CREATE TABLE IF NOT EXISTS clotures (nature TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (nature, id)) WITHOUT ROWID`,
];

/* ---------- Outils ---------- */
class Refus extends Error { constructor(statut, message) { super(message); this.statut = statut; } }
const maintenant = () => new Date().toISOString();
const secondes = () => Math.floor(Date.now() / 1000);
function json(corps, statut = 200, entetes = {}) {
  return new Response(JSON.stringify(corps), {status: statut, headers: {"content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", ...entetes}});
}
function hex(octets) { return [...new Uint8Array(octets)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(texte) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte))); }
function aleatoireHex(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
function aleatoire() { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; }
function egaux(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function entier(v, min, max) { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; }
function contrainte(e) { return /constraint|SQLITE_CONSTRAINT/i.test(String(e && (e.message || e.cause || e))); }
const PSEUDO = /^[\p{L}\p{N}_.-]{3,20}$/u;

/* ---------- Catalogue et base ---------- */
let catalogue = null, schemaPret = null;
async function lireCatalogue(env, url) {
  catalogue ||= env.ASSETS.fetch(new Request(new URL("/serveur.json", url))).then(r => {
    if (!r.ok) throw new Error("serveur.json introuvable : " + r.status);
    return r.json();
  }).then(Regles.catalogueCompact).catch(e => { catalogue = null; throw e; });
  return catalogue;
}
async function preparerBase(env) {
  schemaPret ||= env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql))).catch(e => { schemaPret = null; throw e; });
  return schemaPret;
}
// Lot D1 (transaction) ; une contrainte violée devient un refus « à recommencer »
async function lot(env, requetes, message = "Une autre opération est passée entre-temps. Rechargez et recommencez.") {
  try { return await env.DB.batch(requetes); }
  catch (e) { if (contrainte(e)) throw new Refus(409, message); throw e; }
}

/* ---------- Limites de tentatives ---------- */
async function limiter(env, cle, [max, fenetre]) {
  const t = secondes();
  const l = await env.DB.prepare("SELECT n, debut FROM tentatives WHERE cle = ?").bind(cle).first();
  if (l && t - l.debut < fenetre && l.n >= max) throw new Refus(429, "Trop de tentatives. Réessayez dans quelques minutes.");
  await env.DB.prepare(`INSERT INTO tentatives (cle, n, debut) VALUES (?1, 1, ?2)
    ON CONFLICT (cle) DO UPDATE SET n = CASE WHEN ?2 - debut < ?3 THEN n + 1 ELSE 1 END,
                                    debut = CASE WHEN ?2 - debut < ?3 THEN debut ELSE ?2 END`).bind(cle, t, fenetre).run();
}
async function oublier(env, cle) { await env.DB.prepare("DELETE FROM tentatives WHERE cle = ?").bind(cle).run(); }

/* ---------- Sessions ---------- */
function lireCookie(requete) {
  const m = (requete.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([A-Za-z0-9_-]+)"));
  return m ? m[1] : null;
}
async function ouvrirSession(env, joueur) {
  const jeton = aleatoireHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE joueur = ? AND expire < ?").bind(joueur, secondes()),
    env.DB.prepare("INSERT INTO sessions (jeton, joueur, expire) VALUES (?, ?, ?)").bind(await sha256(jeton), joueur, secondes() + DUREE_SESSION),
  ]);
  return `${COOKIE}=${jeton}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DUREE_SESSION}`;
}
async function joueurConnecte(env, requete) {
  const jeton = lireCookie(requete);
  if (!jeton) return null;
  const s = await env.DB.prepare("SELECT joueur FROM sessions WHERE jeton = ? AND expire > ?").bind(await sha256(jeton), secondes()).first();
  return s ? s.joueur : null;
}

/* ---------- État d'un joueur ---------- */
async function chargerEtat(env, joueur) {
  const [j, p, r, h] = await env.DB.batch([
    env.DB.prepare("SELECT pseudo, points, offerts, jour, ouverts FROM joueurs WHERE id = ?").bind(joueur),
    env.DB.prepare("SELECT carte, n, importes, reserve FROM possessions WHERE joueur = ? AND n > 0").bind(joueur),
    env.DB.prepare("SELECT cle, date FROM reclames WHERE joueur = ?").bind(joueur),
    env.DB.prepare("SELECT date, operation, detail FROM journal WHERE joueur = ? ORDER BY id DESC LIMIT 20").bind(joueur),
  ]);
  const ligne = j.results[0];
  if (!ligne) throw new Refus(401, "Compte introuvable.");
  const etat = Regles.etatVide();
  Object.assign(etat, {points: ligne.points, offerts: ligne.offerts, jour: ligne.jour, ouverts: ligne.ouverts, verrous: {}});
  for (const x of p.results) {
    etat.possedees[x.carte] = x.n;
    if (x.importes + x.reserve) etat.verrous[x.carte] = x.importes + x.reserve;
  }
  for (const x of r.results) etat.objectifs[x.cle] = x.date;
  etat.journal = h.results.reverse().map(x => [x.date, x.operation, x.detail ? JSON.parse(x.detail) : null]);
  return {pseudo: ligne.pseudo, etat};
}
// Ajout : la ligne est créée au besoin. Retrait : simple mise à jour, car SQLite vérifie les contraintes CHECK
// d'une insertion avant de résoudre le conflit (une insertion négative échouerait toujours). Les lignes de
// possession ne sont jamais supprimées : un retrait vise donc une ligne vérifiée au préalable, et la contrainte
// « n >= importes + reserve » refuse tout retrait au-delà des exemplaires libres, même entre deux demandes croisées.
const ajoutCartes = (env, joueur, carte, d) => env.DB.prepare(
  `INSERT INTO possessions (joueur, carte, n) VALUES (?1, ?2, ?3)
   ON CONFLICT (joueur, carte) DO UPDATE SET n = n + excluded.n`).bind(joueur, carte, d);
const retraitCartes = (env, joueur, carte, q) => env.DB.prepare(
  "UPDATE possessions SET n = n - ? WHERE joueur = ? AND carte = ?").bind(q, joueur, carte);
const noterJournal = (env, joueur, operation, detail) => env.DB.prepare(
  "INSERT INTO journal (joueur, date, operation, detail) VALUES (?, ?, ?, ?)").bind(joueur, maintenant(), operation, JSON.stringify(detail));

// Applique une opération des règles à l'état du joueur, puis écrit les seules variations, sous contraintes
async function appliquer(env, joueur, operation) {
  const {etat: avant} = await chargerEtat(env, joueur);
  const apres = structuredClone(avant);
  const resultat = operation(apres);
  const requetes = [];
  for (const id of new Set([...Object.keys(avant.possedees), ...Object.keys(apres.possedees)])) {
    const d = (apres.possedees[id] || 0) - (avant.possedees[id] || 0);
    if (d > 0) requetes.push(ajoutCartes(env, joueur, id, d));
    else if (d < 0) requetes.push(retraitCartes(env, joueur, id, -d));  // carte présente dans l'état lu
  }
  const dPoints = apres.points - avant.points, dOfferts = apres.offerts - avant.offerts;
  if (dPoints || dOfferts) requetes.push(env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(dPoints, dOfferts, joueur));
  if (apres.jour !== avant.jour || apres.ouverts !== avant.ouverts) {
    const dOuverts = apres.ouverts - (avant.jour === apres.jour ? avant.ouverts : 0);
    requetes.push(env.DB.prepare(`UPDATE joueurs SET ouverts = CASE WHEN jour = ?1 THEN ouverts + ?2 ELSE ?3 END, jour = ?1 WHERE id = ?4`)
      .bind(apres.jour, dOuverts, apres.ouverts, joueur));
  }
  for (const cle of Object.keys(apres.objectifs)) if (!avant.objectifs[cle])
    requetes.push(env.DB.prepare("INSERT INTO reclames (joueur, cle, date) VALUES (?, ?, ?)").bind(joueur, cle, apres.objectifs[cle]));
  for (const [, op, detail] of apres.journal.slice(avant.journal.length)) requetes.push(noterJournal(env, joueur, op, detail));
  if (requetes.length) await lot(env, requetes);
  return resultat;
}

/* ---------- Comptes ---------- */
async function lireCorps(requete) {
  try { const c = await requete.json(); if (c && typeof c === "object") return c; } catch (_) {}
  throw new Refus(400, "Demande illisible.");
}
function validerIdentifiants(c) {
  const pseudo = String(c.pseudo || "").normalize("NFC").trim();
  if (!PSEUDO.test(pseudo)) throw new Refus(400, "Le pseudo doit faire de 3 à 20 caractères : lettres, chiffres, point, tiret ou soulignement.");
  if (!/^[0-9a-f]{64}$/.test(String(c.preuve || ""))) throw new Refus(400, "Mot de passe illisible.");
  return {pseudo, preuve: c.preuve};
}
async function inscription(env, requete, cat) {
  const c = await lireCorps(requete);
  const {pseudo, preuve} = validerIdentifiants(c);
  await limiter(env, "inscription:" + (requete.headers.get("cf-connecting-ip") || "?"), LIMITES.inscriptionIp);
  const sel = aleatoireHex(16);
  let joueur;
  try {
    joueur = (await env.DB.prepare("INSERT INTO joueurs (pseudo, sel, empreinte, cree) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(pseudo, sel, await sha256(sel + preuve), maintenant()).first()).id;
  } catch (e) { if (contrainte(e)) throw new Refus(409, "Ce pseudo est déjà pris."); throw e; }
  // Reprise de la collection du navigateur, une seule fois : les cartes comptent pour la collection et les
  // objectifs, mais restent verrouillées (ni recyclées, ni cédées), faute de pouvoir vérifier leur origine.
  // Les paliers déjà atteints sont marqués comme réclamés : le navigateur les a déjà payés. Points et
  // paquets offerts ne sont pas repris.
  const repris = {};
  const brut = c.collection && typeof c.collection === "object" ? c.collection : {};
  for (const [id, n] of Object.entries(brut)) {
    const k = entier(n, 1, MAX_PAR_CARTE);
    if (k && cat.parId[id]) repris[id] = k;
  }
  const ids = Object.keys(repris), requetes = [];
  for (let i = 0; i < ids.length; i += 30) {
    const tranche = ids.slice(i, i + 30);
    requetes.push(env.DB.prepare(`INSERT INTO possessions (joueur, carte, n, importes) VALUES ${tranche.map(() => "(?, ?, ?, ?)").join(", ")}`)
      .bind(...tranche.flatMap(id => [joueur, id, repris[id], repris[id]])));
  }
  const etat = Regles.etatVide(); etat.possedees = repris;
  const date = maintenant();
  for (const o of cat.objectifs) for (const e of Regles.avancement(etat, o).aReclamer)
    requetes.push(env.DB.prepare("INSERT INTO reclames (joueur, cle, date) VALUES (?, ?, ?)").bind(joueur, e.cle, date));
  if (ids.length) requetes.push(noterJournal(env, joueur, "reprise", {cartes: ids.length, exemplaires: ids.reduce((a, id) => a + repris[id], 0)}));
  for (let i = 0; i < requetes.length; i += 50) await env.DB.batch(requetes.slice(i, i + 50));
  return json({connecte: true, ...(await chargerEtat(env, joueur))}, 201, {"set-cookie": await ouvrirSession(env, joueur)});
}
async function connexion(env, requete) {
  const {pseudo, preuve} = validerIdentifiants(await lireCorps(requete));
  const cle = "connexion:" + pseudo.toLowerCase();
  await limiter(env, cle, LIMITES.connexion);
  await limiter(env, "connexion-ip:" + (requete.headers.get("cf-connecting-ip") || "?"), LIMITES.connexionIp);
  const j = await env.DB.prepare("SELECT id, sel, empreinte FROM joueurs WHERE pseudo = ?").bind(pseudo).first();
  const attendu = j ? j.empreinte : "0".repeat(64);
  const obtenu = await sha256((j ? j.sel : "") + preuve);
  if (!j || !egaux(obtenu, attendu)) throw new Refus(401, "Pseudo ou mot de passe incorrect.");
  await oublier(env, cle);
  return json({connecte: true, ...(await chargerEtat(env, j.id))}, 200, {"set-cookie": await ouvrirSession(env, j.id)});
}
async function deconnexion(env, requete) {
  const jeton = lireCookie(requete);
  if (jeton) await env.DB.prepare("DELETE FROM sessions WHERE jeton = ?").bind(await sha256(jeton)).run();
  return json({connecte: false}, 200, {"set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`});
}

/* ---------- Bourse : échanges et marché ---------- */
async function idJoueur(env, pseudo) {
  const j = await env.DB.prepare("SELECT id, pseudo FROM joueurs WHERE pseudo = ?").bind(String(pseudo || "").normalize("NFC").trim()).first();
  if (!j) throw new Refus(404, "Aucun joueur ne porte ce pseudo.");
  return j;
}
async function libres(env, joueur) {
  const r = await env.DB.prepare("SELECT carte, n - importes - reserve AS libres FROM possessions WHERE joueur = ? AND n - importes - reserve > 0").bind(joueur).all();
  return Object.fromEntries(r.results.map(x => [x.carte, x.libres]));
}
function lireLot(cat, brut) {
  const l = {};
  for (const [id, q] of Object.entries(brut && typeof brut === "object" ? brut : {})) {
    const k = entier(q, 1, MAX_ECHANGE);
    if (!k || !cat.parId[id]) throw new Refus(400, "Carte inconnue ou quantité invalide.");
    l[id] = k;
  }
  return l;
}
const somme = l => Object.values(l).reduce((a, b) => a + b, 0);
async function proposerEchange(env, requete, joueur, cat) {
  const c = await lireCorps(requete);
  const dest = await idJoueur(env, c.vers);
  if (dest.id === joueur) throw new Refus(400, "Vous ne pouvez pas échanger avec vous-même.");
  const donne = lireLot(cat, c.donne), recoit = lireLot(cat, c.recoit);
  if (!somme(donne) && !somme(recoit)) throw new Refus(400, "Choisissez au moins une carte.");
  if (somme(donne) + somme(recoit) > MAX_ECHANGE) throw new Refus(400, `Un échange porte au plus sur ${MAX_ECHANGE} cartes.`);
  const [mes, ses] = [await libres(env, joueur), await libres(env, dest.id)];
  for (const [id, q] of Object.entries(donne)) if ((mes[id] || 0) < q) throw new Refus(409, "Vous n'avez pas assez d'exemplaires libres de l'une des cartes proposées.");
  for (const [id, q] of Object.entries(recoit)) if ((ses[id] || 0) < q) throw new Refus(409, `${dest.pseudo} n'a pas assez d'exemplaires libres de l'une des cartes demandées.`);
  const enCours = await env.DB.prepare("SELECT COUNT(*) AS n FROM echanges WHERE de = ? AND statut = 'proposee'").bind(joueur).first();
  if (enCours.n >= MAX_ECHANGES_EN_COURS) throw new Refus(429, `Vous avez déjà ${MAX_ECHANGES_EN_COURS} propositions en attente.`);
  const date = maintenant();
  await env.DB.prepare("INSERT INTO echanges (de, vers, donne, recoit, statut, cree, maj) VALUES (?, ?, ?, ?, 'proposee', ?, ?)")
    .bind(joueur, dest.id, JSON.stringify(donne), JSON.stringify(recoit), date, date).run();
  return json({ok: true}, 201);
}
async function listeEchanges(env, joueur) {
  const r = await env.DB.prepare(`SELECT e.id, e.de, e.vers, e.donne, e.recoit, e.statut, e.cree, e.maj, a.pseudo AS pseudo_de, b.pseudo AS pseudo_vers
    FROM echanges e JOIN joueurs a ON a.id = e.de JOIN joueurs b ON b.id = e.vers
    WHERE (e.de = ?1 OR e.vers = ?1) ORDER BY (e.statut = 'proposee') DESC, e.maj DESC LIMIT 60`).bind(joueur).all();
  return json({echanges: r.results.map(e => ({id: e.id, recu: e.vers === joueur, avec: e.vers === joueur ? e.pseudo_de : e.pseudo_vers,
    donne: JSON.parse(e.donne), recoit: JSON.parse(e.recoit), statut: e.statut, cree: e.cree, maj: e.maj}))});
}
async function cloreEchange(env, joueur, id, action) {
  const e = await env.DB.prepare("SELECT * FROM echanges WHERE id = ?").bind(id).first();
  if (!e || e.statut !== "proposee") throw new Refus(409, "Cet échange n'est plus en attente.");
  const permis = action === "annuler" ? e.de === joueur : e.vers === joueur;
  if (!permis) throw new Refus(403, "Cet échange ne vous est pas adressé.");
  const statut = {accepter: "acceptee", refuser: "refusee", annuler: "annulee"}[action];
  const requetes = [
    env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('echange', ?)").bind(id),
    env.DB.prepare("UPDATE echanges SET statut = ?, maj = ? WHERE id = ?").bind(statut, maintenant(), id),
  ];
  if (action === "accepter") {
    const donne = JSON.parse(e.donne), recoit = JSON.parse(e.recoit);
    const [libresDe, libresVers] = [await libres(env, e.de), await libres(env, e.vers)];
    const manque = Object.entries(donne).some(([c, q]) => (libresDe[c] || 0) < q) || Object.entries(recoit).some(([c, q]) => (libresVers[c] || 0) < q);
    if (manque) throw new Refus(409, "L'échange n'est plus possible : l'un de vous n'a plus assez d'exemplaires libres.");
    for (const [carte, q] of Object.entries(donne)) requetes.push(retraitCartes(env, e.de, carte, q), ajoutCartes(env, e.vers, carte, q));
    for (const [carte, q] of Object.entries(recoit)) requetes.push(retraitCartes(env, e.vers, carte, q), ajoutCartes(env, e.de, carte, q));
    requetes.push(noterJournal(env, e.de, "echange", {id, avec: e.vers}), noterJournal(env, e.vers, "echange", {id, avec: e.de}));
  }
  await lot(env, requetes, action === "accepter"
    ? "L'échange n'est plus possible : l'un de vous n'a plus assez d'exemplaires libres." : "Cet échange n'est plus en attente.");
  return json({ok: true});
}
async function marche(env, url) {
  const ids = (url.searchParams.get("cartes") || "").split(",").filter(Boolean).slice(0, 50);
  const tri = url.searchParams.get("tri") === "prix" ? "a.prix ASC, a.id DESC" : "a.id DESC";
  const filtre = ids.length ? `AND a.carte IN (${ids.map(() => "?").join(",")})` : "";
  const r = await env.DB.prepare(`SELECT a.id, a.carte, a.prix, a.cree, j.pseudo AS vendeur FROM annonces a JOIN joueurs j ON j.id = a.vendeur
    WHERE a.statut = 'ouverte' ${filtre} ORDER BY ${tri} LIMIT 200`).bind(...ids).all();
  return json({annonces: r.results});
}
async function mesAnnonces(env, joueur) {
  const r = await env.DB.prepare(`SELECT a.id, a.carte, a.prix, a.statut, a.cree, a.maj, j.pseudo AS acheteur FROM annonces a
    LEFT JOIN joueurs j ON j.id = a.acheteur WHERE a.vendeur = ? ORDER BY (a.statut = 'ouverte') DESC, a.id DESC LIMIT 100`).bind(joueur).all();
  return json({annonces: r.results});
}
async function vendre(env, requete, joueur, cat) {
  const c = await lireCorps(requete);
  const carte = String(c.carte || ""), prix = entier(c.prix, 1, PRIX_MAX);
  if (!cat.parId[carte]) throw new Refus(400, "Carte inconnue.");
  if (!prix) throw new Refus(400, `Le prix va de 1 à ${PRIX_MAX.toLocaleString("fr-FR")} voix.`);
  const p = await env.DB.prepare("SELECT n - importes - reserve AS libres FROM possessions WHERE joueur = ? AND carte = ?").bind(joueur, carte).first();
  if (!p || p.libres < 1) throw new Refus(409, "Vous n'avez pas d'exemplaire libre de cette carte.");
  const ouvertes = await env.DB.prepare("SELECT COUNT(*) AS n FROM annonces WHERE vendeur = ? AND statut = 'ouverte'").bind(joueur).first();
  if (ouvertes.n >= MAX_ANNONCES) throw new Refus(429, `Vous avez déjà ${MAX_ANNONCES} cartes au comptoir.`);
  const date = maintenant();
  await lot(env, [
    env.DB.prepare("UPDATE possessions SET reserve = reserve + 1 WHERE joueur = ? AND carte = ?").bind(joueur, carte),
    env.DB.prepare("INSERT INTO annonces (vendeur, carte, prix, statut, cree, maj) VALUES (?, ?, ?, 'ouverte', ?, ?)").bind(joueur, carte, prix, date, date),
  ], "Vous n'avez plus d'exemplaire libre de cette carte.");
  return json({ok: true}, 201);
}
async function cloreAnnonce(env, joueur, id, action) {
  const a = await env.DB.prepare("SELECT * FROM annonces WHERE id = ?").bind(id).first();
  if (!a || a.statut !== "ouverte") throw new Refus(409, "Cette carte n'est plus au comptoir.");
  const date = maintenant();
  const requetes = [env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('annonce', ?)").bind(id)];
  if (action === "retirer") {
    if (a.vendeur !== joueur) throw new Refus(403, "Cette carte du comptoir n'est pas la vôtre.");
    requetes.push(env.DB.prepare("UPDATE annonces SET statut = 'retiree', maj = ? WHERE id = ?").bind(date, id),
      env.DB.prepare("UPDATE possessions SET reserve = reserve - 1 WHERE joueur = ? AND carte = ?").bind(a.vendeur, a.carte));
    await lot(env, requetes, "Cette carte n'est plus au comptoir.");
  } else {
    if (a.vendeur === joueur) throw new Refus(400, "Vous ne pouvez pas acheter votre propre carte.");
    requetes.push(env.DB.prepare("UPDATE annonces SET statut = 'vendue', acheteur = ?, maj = ? WHERE id = ?").bind(joueur, date, id),
      env.DB.prepare("UPDATE joueurs SET points = points - ? WHERE id = ?").bind(a.prix, joueur),
      env.DB.prepare("UPDATE joueurs SET points = points + ? WHERE id = ?").bind(a.prix, a.vendeur),
      env.DB.prepare("UPDATE possessions SET n = n - 1, reserve = reserve - 1 WHERE joueur = ? AND carte = ?").bind(a.vendeur, a.carte),
      ajoutCartes(env, joueur, a.carte, 1),
      noterJournal(env, joueur, "achat", {annonce: id, carte: a.carte, prix: a.prix}),
      noterJournal(env, a.vendeur, "vente", {annonce: id, carte: a.carte, prix: a.prix}));
    await lot(env, requetes, "Achat impossible : voix insuffisantes, ou carte déjà vendue ou retirée du comptoir.");
  }
  return json({ok: true});
}

/* ---------- Routage ---------- */
async function api(requete, env, url) {
  const methode = requete.method, chemin = url.pathname.replace(/\/+$/, "");
  if (methode === "POST") {
    // Protection contre les requêtes venues d'autres sites : en-tête propre au jeu et origine identique
    const origine = requete.headers.get("origin");
    if (requete.headers.get("x-hemicycle") !== "1" || (origine && origine !== url.origin)) throw new Refus(403, "Demande refusée.");
  }
  await preparerBase(env);
  // Catalogue chargé seulement par les opérations qui en ont besoin (tirage, recyclage, objectifs, contrôle
  // des cartes) : l'état du joueur, la connexion, le comptoir et les échanges n'en dépendent pas
  const catalogueDuJeu = () => lireCatalogue(env, url);
  if (methode === "POST" && chemin === "/api/inscription") return inscription(env, requete, await catalogueDuJeu());
  if (methode === "POST" && chemin === "/api/connexion") return connexion(env, requete);
  if (methode === "POST" && chemin === "/api/deconnexion") return deconnexion(env, requete);
  const joueur = await joueurConnecte(env, requete);
  if (methode === "GET" && chemin === "/api/moi") return json(joueur ? {connecte: true, ...(await chargerEtat(env, joueur))} : {connecte: false});
  if (!joueur) throw new Refus(401, "Connectez-vous pour continuer.");
  const avecEtat = async resultat => json({resultat, ...(await chargerEtat(env, joueur))});
  if (methode === "POST" && chemin === "/api/paquet") {
    const cat = await catalogueDuJeu();
    const r = await appliquer(env, joueur, e => Regles.ouvrirPaquet(e, cat, {jour: Regles.jourDuJeu(), aleatoire}));
    if (!r) throw new Refus(409, "Aucun paquet disponible pour l'instant.");
    return avecEtat({tirage: r.tirage.map(c => c.id), neuves: [...r.neuves], origine: r.origine});
  }
  if (methode === "POST" && chemin === "/api/recycler") {
    const c = await lireCorps(requete);
    const raretes = (Array.isArray(c.raretes) ? c.raretes : []).filter(r => Regles.ORDRE.includes(r));
    const cat = await catalogueDuJeu();
    return avecEtat(await appliquer(env, joueur, e => Regles.recycler(e, cat, raretes)));
  }
  if (methode === "POST" && chemin === "/api/echanger-points") {
    if (!(await appliquer(env, joueur, e => Regles.echangerPoints(e)))) throw new Refus(409, `Il faut ${Regles.PRIX_PAQUET} voix pour un paquet.`);
    return avecEtat(true);
  }
  if (methode === "POST" && chemin === "/api/reclamer") {
    const c = await lireCorps(requete);
    const cat = await catalogueDuJeu();
    return avecEtat(await appliquer(env, joueur, e => Regles.reclamer(e, cat, String(c.id || ""))));
  }
  let m;
  if (methode === "GET" && (m = chemin.match(/^\/api\/joueurs\/([^/]+)$/))) {
    const j = await idJoueur(env, decodeURIComponent(m[1]));
    return json({pseudo: j.pseudo, libres: await libres(env, j.id)});
  }
  if (methode === "GET" && chemin === "/api/echanges") return listeEchanges(env, joueur);
  if (methode === "POST" && chemin === "/api/echanges") return proposerEchange(env, requete, joueur, await catalogueDuJeu());
  if (methode === "POST" && (m = chemin.match(/^\/api\/echanges\/(\d+)\/(accepter|refuser|annuler)$/))) return cloreEchange(env, joueur, Number(m[1]), m[2]);
  if (methode === "GET" && chemin === "/api/marche") return marche(env, url);
  if (methode === "GET" && chemin === "/api/annonces") return mesAnnonces(env, joueur);
  if (methode === "POST" && chemin === "/api/annonces") return vendre(env, requete, joueur, await catalogueDuJeu());
  if (methode === "POST" && (m = chemin.match(/^\/api\/annonces\/(\d+)\/(acheter|retirer)$/))) return cloreAnnonce(env, joueur, Number(m[1]), m[2]);
  throw new Refus(404, "Adresse inconnue.");
}

export default {
  async fetch(requete, env) {
    const url = new URL(requete.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(requete);
    try { return await api(requete, env, url); }
    catch (e) {
      if (e instanceof Refus) return json({erreur: e.message}, e.statut);
      console.error(e);
      return json({erreur: "Le serveur a rencontré une erreur. Réessayez dans un instant."}, 500);
    }
  },
};
