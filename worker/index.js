/* Hémicycle : serveur (Cloudflare Worker et base D1).

Le Worker sert le site (dossier site/, en ressources statiques) et répond sous /api/ : comptes, collection,
paquets, recyclage, objectifs, échanges entre joueurs et marché. Les règles sont celles de site/regles.js,
exécutées ici : le serveur est seul juge des tirages et des récompenses, le navigateur n'envoie que des demandes.

Intégrité : chaque écriture est une variation (« n = n + d ») protégée par des contraintes de la base
(possessions jamais négatives, exemplaires verrouillés jamais cédés, version du joueur inchangée, points
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
import Gouvernement from "../site/gouvernement.js";
import {CODES} from "./codes.js";

const DUREE_SESSION = 90 * 24 * 3600;           // secondes
const COOKIE = "hemicycle_session";
const MAX_PAR_CARTE = 999;                       // exemplaires repris au plus par carte
const MAX_VOIX_REPRISES = 1000;                  // voix du navigateur reprises au plus à l'inscription
const MAX_ECHANGE = 40;                          // cartes au plus dans un échange (deux côtés)
const MAX_ECHANGES_EN_COURS = 20, MAX_ANNONCES = 50, MAX_OFFRES_EN_COURS = 20, MAX_ALERTES = 50;
const PRIX_MAX = 100000;
// Tentatives par fenêtre de 15 minutes (1 heure pour les inscriptions). Par adresse IP, des plafonds hauts : une
// box familiale, une classe, un bureau ou les abonnés mobiles d'un opérateur partagent une même adresse (demande de
// l'utilisateur, octobre 2026 : « le plus possible ») ; ils n'arrêtent plus qu'un script. Par pseudo, la limite reste
// basse contre les essais de mots de passe.
const LIMITES = {
  connexion: [10, 15 * 60], connexionIp: [300, 15 * 60], inscriptionIp: [100, 3600],
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS joueurs (
     id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE, sel TEXT NOT NULL, empreinte TEXT NOT NULL,
     cree TEXT NOT NULL,
     points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
     offerts INTEGER NOT NULL DEFAULT 0 CHECK (offerts >= 0),
     jour TEXT NOT NULL DEFAULT '',
     ouverts INTEGER NOT NULL DEFAULT 0 CHECK (ouverts BETWEEN 0 AND 3))`,  // jour, ouverts : ancienne règle (paquets du jour), inutilisés
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
  // Nombre de joueurs qui ont une carte (aperçu de « Toutes les cartes ») : lu dans l'index seul
  `CREATE INDEX IF NOT EXISTS possessions_carte ON possessions (carte, n)`,
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
  `CREATE INDEX IF NOT EXISTS annonces_acheteur ON annonces (acheteur)`,
  // Contre-offres au comptoir : un acheteur propose moins que le prix demandé, le vendeur accepte ou refuse ; une offre
  // en attente par acheteur et par annonce (la nouvelle remplace l'ancienne) ; numéros jamais réutilisés (clôtures)
  `CREATE TABLE IF NOT EXISTS offres (id INTEGER PRIMARY KEY AUTOINCREMENT, annonce INTEGER NOT NULL, acheteur INTEGER NOT NULL,
     prix INTEGER NOT NULL CHECK (prix BETWEEN 1 AND ${PRIX_MAX}), statut TEXT NOT NULL, cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS offres_annonce ON offres (annonce, statut)`,
  `CREATE INDEX IF NOT EXISTS offres_acheteur ON offres (acheteur, statut)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS offres_une ON offres (annonce, acheteur) WHERE statut = 'proposee'`,
  // Alertes de vente : le joueur est averti quand une carte qu'il guette est posée au comptoir ; le nom de la carte,
  // donné par son navigateur, ne sert qu'au texte de sa propre notification (le catalogue du serveur n'a pas les noms)
  `CREATE TABLE IF NOT EXISTS alertes (joueur INTEGER NOT NULL, carte TEXT NOT NULL, nom TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
     PRIMARY KEY (joueur, carte)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS alertes_carte ON alertes (carte)`,
  // Codes à saisir dans Mon siège, créés par l'éditeur dans la console D1 : voix, paquets offerts et cartes (liste JSON
  // d'identifiants) ; limite d'utilisations et date de fin facultatives ; un compte n'utilise un code qu'une fois
  `CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY COLLATE NOCASE, voix INTEGER NOT NULL DEFAULT 0 CHECK (voix >= 0),
     paquets INTEGER NOT NULL DEFAULT 0 CHECK (paquets >= 0), cartes TEXT NOT NULL DEFAULT '[]', limite INTEGER,
     utilisations INTEGER NOT NULL DEFAULT 0, fin TEXT, CHECK (limite IS NULL OR utilisations <= limite))`,
  `CREATE TABLE IF NOT EXISTS codes_utilises (code TEXT NOT NULL COLLATE NOCASE, joueur INTEGER NOT NULL, date TEXT NOT NULL,
     PRIMARY KEY (code, joueur))`,
  // Duels de questions : mêmes questions (même graine) pour les deux joueurs, pour la gloire (pas de voix)
  `CREATE TABLE IF NOT EXISTS duels (id INTEGER PRIMARY KEY, de INTEGER NOT NULL, vers INTEGER NOT NULL, graine INTEGER NOT NULL,
     score_de INTEGER, score_vers INTEGER, cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS duels_de ON duels (de)`,
  `CREATE INDEX IF NOT EXISTS duels_vers ON duels (vers)`,
  // Messages du formulaire de contact (exercice des droits, questions) ; signalements de pseudos (retirés à la demande
  // de l'utilisateur, octobre 2026 : table gardée pour les lignes déjà écrites, effacées avec le compte)
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, joueur INTEGER, reponse TEXT, message TEXT NOT NULL, date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS signalements (id INTEGER PRIMARY KEY, de INTEGER NOT NULL, cible INTEGER NOT NULL, motif TEXT, date TEXT NOT NULL)`,
  // Amis : une demande (de -> vers), puis une amitié acceptée, réciproque
  `CREATE TABLE IF NOT EXISTS amis (de INTEGER NOT NULL, vers INTEGER NOT NULL, statut TEXT NOT NULL, date TEXT NOT NULL,
     PRIMARY KEY (de, vers)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS amis_vers ON amis (vers, statut)`,
  // Notifications : abonnements Web Push (un par appareil) et messages en attente, lus par le service de travail
  `CREATE TABLE IF NOT EXISTS abonnements (endpoint TEXT PRIMARY KEY, joueur INTEGER NOT NULL, buvette INTEGER NOT NULL DEFAULT 1,
     reserve INTEGER NOT NULL DEFAULT 1, reserve_vue TEXT NOT NULL DEFAULT '', date TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS abonnements_joueur ON abonnements (joueur)`,
  `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, joueur INTEGER NOT NULL, texte TEXT NOT NULL, date TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notifications_joueur ON notifications (joueur)`,
  // Réglages du serveur : migrations faites, clés VAPID des notifications
  `CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)`,
  // Garde de concurrence : une insertion n'y a lieu que lorsque la version du joueur a changé entre la lecture
  // et l'écriture ; sa contrainte échoue alors et annule tout le lot (voir appliquer)
  `CREATE TABLE IF NOT EXISTS garde (ok INTEGER NOT NULL CHECK (ok = 0))`,
  // Jeu du Gouvernement (octobre 2026) : gouvernements enregistrés (cinq au plus, un chef et huit ministres) et parties
  // (contre l'ordinateur, contre le gouvernement enregistré d'un joueur tiré au hasard, ou contre un ami avec mise) ;
  // camps figés au choix du gouvernement, coups [ministre, 49.3] jugés par site/gouvernement.js
  `CREATE TABLE IF NOT EXISTS gouvernements (id INTEGER PRIMARY KEY AUTOINCREMENT, joueur INTEGER NOT NULL, nom TEXT NOT NULL,
     chef TEXT NOT NULL, ministres TEXT NOT NULL, cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gouvernements_joueur ON gouvernements (joueur)`,
  `CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER,
     graine INTEGER NOT NULL, annonces TEXT NOT NULL, camp_a TEXT, camp_b TEXT, coups_a TEXT NOT NULL DEFAULT '[]',
     coups_b TEXT NOT NULL DEFAULT '[]', niveau INTEGER NOT NULL DEFAULT 0, fantome INTEGER, statut TEXT NOT NULL,
     mise_voix INTEGER NOT NULL DEFAULT 0 CHECK (mise_voix >= 0), mise_paquets INTEGER NOT NULL DEFAULT 0 CHECK (mise_paquets >= 0),
     gagnant INTEGER, cree TEXT NOT NULL, maj TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS parties_a ON parties (a, statut)`,
  `CREATE INDEX IF NOT EXISTS parties_b ON parties (b, statut)`,
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
// Modération des pseudos : mots injurieux ou haineux recherchés dans le pseudo (chiffres lus comme des lettres),
// mots courts et noms réservés refusés seulement s'ils forment tout le pseudo (« pute » est dans « depute »,
// « nique » dans « Monique »). Le reste passe par le formulaire de contact.
const MOTS_INTERDITS = ["connard", "connasse", "salope", "salaud", "encule", "batard", "putain", "merde", "couille",
  "negre", "negro", "bougnoul", "youpin", "youtre", "bicot", "chinetoque", "hitler", "pedophile", "violeur", "tapette",
  "gouine", "fiotte", "branleur", "nazi"];
const NOMS_RESERVES = ["admin", "administrateur", "administration", "moderateur", "moderation", "modo", "hemicycle", "support",
  "officiel", "staff", "equipe", "systeme", "anonyme", "pd", "fdp", "ntm", "pute", "bite", "nique", "pedo"];
function pseudoAutorise(pseudo) {
  const n = Regles.normer(pseudo).replace(/[013457@$]/g, ch => ({0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s"})[ch]);
  const lettres = n.replace(/[^a-z]/g, "");
  return !NOMS_RESERVES.includes(lettres) && !MOTS_INTERDITS.some(m => lettres.includes(m));
}

/* ---------- Catalogue et base ---------- */
let catalogue = null, schemaPret = null;
async function lireCatalogue(env, url) {
  catalogue ||= env.ASSETS.fetch(new Request(new URL("/serveur.json", url))).then(r => {
    if (!r.ok) throw new Error("serveur.json introuvable : " + r.status);
    return r.json();
  }).then(Regles.catalogueCompact).catch(e => { catalogue = null; throw e; });
  return catalogue;
}
// Données des questions des duels (scripts/catalogue_serveur.js), chargées par les seules routes des duels
let quizDuels = null;
async function lireQuiz(env, url) {
  quizDuels ||= env.ASSETS.fetch(new Request(new URL("/quiz-serveur.json", url))).then(r => {
    if (!r.ok) throw new Error("quiz-serveur.json introuvable : " + r.status);
    return r.json();
  }).then(Regles.catalogueQuiz).catch(e => { quizDuels = null; throw e; });
  return quizDuels;
}
// Colonnes ajoutées après la mise en service : ajoutées à la volée si la table existante ne les a pas
const COLONNES = {
  joueurs: [
    ["stock", `INTEGER NOT NULL DEFAULT ${Regles.RESERVE_MAX} CHECK (stock >= 0)`],  // réserve de paquets à l'ancre (plafond : règles)
    ["ancre", "INTEGER NOT NULL DEFAULT 0"],      // instant (ms) depuis lequel la réserve se recharge ; 0 : pleine
    ["version", "INTEGER NOT NULL DEFAULT 0"],    // incrémentée à chaque opération des règles (garde de concurrence)
    ["vitrine", "TEXT NOT NULL DEFAULT '[]'"],    // cartes choisies pour la vitrine publique
    ["quiz", "TEXT NOT NULL DEFAULT ''"],         // jour des dernières questions au Gouvernement récompensées
    ["favoris", "TEXT NOT NULL DEFAULT '[]'"],    // cartes marquées d'une étoile par le joueur
    ["gardes", "TEXT NOT NULL DEFAULT '[]'"],     // cartes dont les doubles ne sont pas proposés à la dissolution
    ["quotidien", "TEXT NOT NULL DEFAULT '{}'"],  // série de connexion, lot à choisir, objectifs du jour (règles : quotidien)
    // Première version de la série du Gouvernement (octobre 2026), remplacée par quotidien.gouv (règles) : inutilisées
    ["serie_gouv", "INTEGER NOT NULL DEFAULT 0 CHECK (serie_gouv BETWEEN 0 AND 5)"],
    ["gains_gouv", "TEXT NOT NULL DEFAULT ''"],
    ["gouv_formes", "INTEGER NOT NULL DEFAULT 0"],  // gouvernements formés depuis l'ouverture du compte (le premier est offert)
  ],
  annonces: [
    ["rarete", "TEXT NOT NULL DEFAULT ''"],       // rareté de la carte, pour les prix médians par rareté
  ],
  // Voix ajoutées à un échange (octobre 2026), d'un seul côté : données par celui qui propose ou demandées à l'autre
  echanges: [
    ["voix_donne", "INTEGER NOT NULL DEFAULT 0 CHECK (voix_donne >= 0)"],
    ["voix_recoit", "INTEGER NOT NULL DEFAULT 0 CHECK (voix_recoit >= 0)"],
  ],
  // Duels avec mise (octobre 2026) : mise de chacun, état, réponses jugées par le serveur ([choix, juste] par question)
  duels: [
    ["mise_voix", "INTEGER NOT NULL DEFAULT 0 CHECK (mise_voix >= 0)"],
    ["mise_paquets", "INTEGER NOT NULL DEFAULT 0 CHECK (mise_paquets >= 0)"],
    ["statut", "TEXT NOT NULL DEFAULT 'accepte'"],  // propose, accepte, fini, refuse, annule, expire ; anciens duels : accepte
    ["accepte", "TEXT"],                            // date où l'adversaire a relevé le défi
    ["rep_de", "TEXT NOT NULL DEFAULT '[]'"],
    ["rep_vers", "TEXT NOT NULL DEFAULT '[]'"],
    ["gagnant", "INTEGER"],                         // identifiant du gagnant, 0 pour une égalité
  ],
  // Choix de cartes offert (JSON {choix, raretes}, règles : offrirChoixGouv), une carte à garder parmi `choix`
  codes: [["choix", "TEXT"]],
  // Présence dans une partie entre amis (instant en ms de la dernière consultation de chaque camp) : « en direct »
  parties: [["vu_a", "INTEGER NOT NULL DEFAULT 0"], ["vu_b", "INTEGER NOT NULL DEFAULT 0"]],
  // Ce que la notification ouvre quand on la touche (« partie:12 »)
  notifications: [["lien", "TEXT"]],
};
// Migrations à n'exécuter qu'une fois, notées dans la table « reglages »
const MIGRATIONS = {
  // Les exemplaires repris du navigateur ne sont plus verrouillés (vente et échange permis)
  "importes-liberes": "UPDATE possessions SET importes = 0 WHERE importes > 0",
  // Comptes qui ont formé un gouvernement avant la colonne gouv_formes (octobre 2026) : marqués comme l'ayant fait, pour que
  // supprimer leur dernier gouvernement ne rende pas le suivant gratuit (gouvernement encore enregistré, ou partie jouée
  // avec un gouvernement)
  "gouv-formes-anciens": `UPDATE joueurs SET gouv_formes = 1 WHERE gouv_formes = 0 AND (id IN (SELECT joueur FROM gouvernements)
    OR id IN (SELECT a FROM parties WHERE camp_a IS NOT NULL) OR id IN (SELECT b FROM parties WHERE mode = 'ami' AND camp_b IS NOT NULL))`,
};
async function migrationsUniques(env) {
  const faites = new Set((await env.DB.prepare("SELECT cle FROM reglages").all()).results.map(x => x.cle));
  for (const [cle, sql] of Object.entries(MIGRATIONS)) if (!faites.has(cle))
    await env.DB.batch([env.DB.prepare(sql), env.DB.prepare("INSERT OR IGNORE INTO reglages (cle, valeur) VALUES (?, ?)").bind(cle, maintenant())]);
}
// La colonne stock portait le plafond de la réserve dans sa contrainte (CHECK stock BETWEEN 0 AND 8) : passé à dix
// paquets (octobre 2026), il bloquait toute ouverture depuis une réserve de plus de huit. SQLite ne modifie pas une
// contrainte : la table joueurs est reconstruite une fois, à l'identique (même définition, mêmes lignes et mêmes
// identifiants), avec CHECK (stock >= 0) ; le plafond reste tenu par les règles. Sans effet si la contrainte est déjà levée.
async function leverPlafondStock(env) {
  const t = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'joueurs'").first();
  if (!t || !/CHECK \(stock BETWEEN 0 AND \d+\)/.test(t.sql)) return;
  const nouvelle = t.sql.replace(/CHECK \(stock BETWEEN 0 AND \d+\)/, "CHECK (stock >= 0)").replace(/^CREATE TABLE\s+("?)joueurs\1/, "CREATE TABLE joueurs_nouveau");
  try {
    await env.DB.batch([
      env.DB.prepare("DROP TABLE IF EXISTS joueurs_nouveau"),
      env.DB.prepare(nouvelle),
      env.DB.prepare("INSERT INTO joueurs_nouveau SELECT * FROM joueurs"),
      env.DB.prepare("DROP TABLE joueurs"),
      env.DB.prepare("ALTER TABLE joueurs_nouveau RENAME TO joueurs"),
    ]);
  } catch (e) {
    // Une autre instance l'a fait au même moment : la contrainte doit être levée
    const apres = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'joueurs'").first();
    if (!apres || /CHECK \(stock BETWEEN 0 AND \d+\)/.test(apres.sql)) throw e;
  }
}
async function preparerBase(env) {
  schemaPret ||= (async () => {
    await env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql)));
    // Colonnes d'abord : une migration peut s'en servir (gouv-formes-anciens)
    for (const [table, colonnes] of Object.entries(COLONNES)) {
      const existantes = new Set((await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name));
      for (const [nom, def] of colonnes) if (!existantes.has(nom)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${nom} ${def}`).run();
    }
    await migrationsUniques(env);
    await leverPlafondStock(env);
  })().catch(e => { schemaPret = null; throw e; });
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
// Les compteurs de tentatives (qui portent l'adresse IP) ne sont gardés qu'une journée
async function purgerTentatives(env) { await env.DB.prepare("DELETE FROM tentatives WHERE debut < ?").bind(secondes() - 86400).run(); }
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
    env.DB.prepare("SELECT pseudo, cree, points, offerts, stock, ancre, version, quiz, vitrine, favoris, gardes, quotidien FROM joueurs WHERE id = ?").bind(joueur),
    // Toutes les lignes : celles à zéro (cartes cédées) se lisent de toute façon avec les autres par la clé du joueur
    env.DB.prepare("SELECT carte, n, importes, reserve FROM possessions WHERE joueur = ?").bind(joueur),
    env.DB.prepare("SELECT cle, date FROM reclames WHERE joueur = ?").bind(joueur),
    env.DB.prepare("SELECT date, operation, detail FROM journal WHERE joueur = ? ORDER BY id DESC LIMIT 20").bind(joueur),
  ]);
  const ligne = j.results[0];
  if (!ligne) throw new Refus(401, "Compte introuvable.");
  const etat = Regles.etatVide();
  Object.assign(etat, {points: ligne.points, offerts: ligne.offerts, reserve: ligne.stock, ancre: ligne.ancre, quiz: ligne.quiz, verrous: {}});
  for (const x of p.results) {
    if (!x.n) { etat.deja.push(x.carte); continue; }   // cartes cédées : restent « obtenues » dans Toutes les cartes
    etat.possedees[x.carte] = x.n;
    if (x.importes + x.reserve) etat.verrous[x.carte] = x.importes + x.reserve;
  }
  for (const x of r.results) etat.objectifs[x.cle] = x.date;
  etat.journal = h.results.reverse().map(x => [x.date, x.operation, x.detail ? JSON.parse(x.detail) : null]);
  etat.favoris = JSON.parse(ligne.favoris || "[]");
  etat.gardes = JSON.parse(ligne.gardes || "[]");
  try { etat.quotidien = JSON.parse(ligne.quotidien || "{}"); } catch (_) { etat.quotidien = {}; }
  return {pseudo: ligne.pseudo, cree: ligne.cree, etat, version: ligne.version, vitrine: JSON.parse(ligne.vitrine || "[]"),
          gouvernement: true};
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
// La version du joueur, lue avec l'état, doit être inchangée au moment d'écrire : sinon une autre opération est
// passée entre-temps (deux paquets ouverts à la même seconde, par exemple), la garde échoue et rien n'est écrit.
// L'état écrit est gardé pour la réponse (env.etatEcrit) : la renvoyer ne demande pas de relire la collection,
// ce qui divise par deux les lignes lues en base à chaque opération (D1 facture les lignes lues).
// `liees` : écritures à faire dans le même lot (transaction), quel que soit le résultat de l'opération
async function appliquer(env, joueur, operation, liees = []) {
  const lu = await chargerEtat(env, joueur), {etat: avant, version} = lu;
  const apres = structuredClone(avant);
  const resultat = operation(apres);
  const requetes = [
    env.DB.prepare("UPDATE joueurs SET version = version + 1 WHERE id = ? AND version = ?").bind(joueur, version),
    env.DB.prepare("INSERT INTO garde (ok) SELECT 1 WHERE changes() = 0"),
  ];
  for (const id of new Set([...Object.keys(avant.possedees), ...Object.keys(apres.possedees)])) {
    const d = (apres.possedees[id] || 0) - (avant.possedees[id] || 0);
    if (d > 0) requetes.push(ajoutCartes(env, joueur, id, d));
    else if (d < 0) requetes.push(retraitCartes(env, joueur, id, -d));  // carte présente dans l'état lu
  }
  const dPoints = apres.points - avant.points, dOfferts = apres.offerts - avant.offerts;
  if (dPoints || dOfferts) requetes.push(env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(dPoints, dOfferts, joueur));
  if (apres.quiz !== avant.quiz) requetes.push(env.DB.prepare("UPDATE joueurs SET quiz = ? WHERE id = ?").bind(apres.quiz, joueur));
  const quotidien = JSON.stringify(apres.quotidien || {});
  if (quotidien !== JSON.stringify(avant.quotidien || {})) requetes.push(env.DB.prepare("UPDATE joueurs SET quotidien = ? WHERE id = ?").bind(quotidien, joueur));
  if (apres.reserve !== avant.reserve || apres.ancre !== avant.ancre)
    requetes.push(env.DB.prepare("UPDATE joueurs SET stock = ?, ancre = ? WHERE id = ?").bind(apres.reserve, apres.ancre, joueur));
  for (const cle of Object.keys(apres.objectifs)) if (!avant.objectifs[cle])
    requetes.push(env.DB.prepare("INSERT INTO reclames (joueur, cle, date) VALUES (?, ?, ?)").bind(joueur, cle, apres.objectifs[cle]));
  for (const [, op, detail] of apres.journal.slice(avant.journal.length)) requetes.push(noterJournal(env, joueur, op, detail));
  requetes.push(...liees);
  if (requetes.length > 2) await lot(env, requetes);
  // Même forme que chargerEtat : exemplaires à zéro retirés, vingt dernières lignes du journal
  for (const id of Object.keys(apres.possedees)) if (!apres.possedees[id]) { delete apres.possedees[id]; if (avant.possedees[id]) apres.deja.push(id); }
  apres.journal = apres.journal.slice(-20);
  env.etatEcrit = {...lu, etat: requetes.length > 2 ? apres : avant, version: requetes.length > 2 ? version + 1 : version};
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
// D1 accepte au plus 100 paramètres par requête : insertions groupées par tranches qui restent en dessous
const PARAMETRES_MAX = 100;
function insertionsGroupees(env, debut, colonnes, lignes) {
  const parTranche = Math.floor(PARAMETRES_MAX / colonnes), requetes = [];
  for (let i = 0; i < lignes.length; i += parTranche) {
    const tranche = lignes.slice(i, i + parTranche);
    requetes.push(env.DB.prepare(`${debut} VALUES ${tranche.map(() => "(" + Array(colonnes).fill("?").join(", ") + ")").join(", ")}`).bind(...tranche.flat()));
  }
  return requetes;
}
async function inscription(env, requete, cat) {
  const c = await lireCorps(requete);
  const {pseudo, preuve} = validerIdentifiants(c);
  if (!pseudoAutorise(pseudo)) throw new Refus(400, "Ce pseudo n'est pas accepté. Choisissez-en un autre.");
  await purgerTentatives(env);
  await limiter(env, "inscription:" + (requete.headers.get("cf-connecting-ip") || "?"), LIMITES.inscriptionIp);
  const sel = aleatoireHex(16);
  let joueur;
  try {
    joueur = (await env.DB.prepare("INSERT INTO joueurs (pseudo, sel, empreinte, cree) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(pseudo, sel, await sha256(sel + preuve), maintenant()).first()).id;
  } catch (e) {
    if (!contrainte(e)) throw e;
    // Pseudo existant : si c'est un compte resté vide (inscription interrompue) et que le mot de passe est le
    // même, l'inscription reprend dans ce compte ; sinon le pseudo est pris.
    const ex = await env.DB.prepare(`SELECT id, sel, empreinte FROM joueurs WHERE pseudo = ?1
      AND NOT EXISTS (SELECT 1 FROM possessions WHERE joueur = joueurs.id) AND NOT EXISTS (SELECT 1 FROM journal WHERE joueur = joueurs.id)`).bind(pseudo).first();
    if (!ex || !egaux(await sha256(ex.sel + preuve), ex.empreinte)) throw new Refus(409, "Ce pseudo est déjà pris.");
    joueur = ex.id;
  }
  // Reprise de la collection du navigateur, une seule fois : les cartes deviennent des cartes ordinaires du
  // compte (décision de l'utilisateur, octobre 2026 : vendre les cartes du navigateur doit être possible, au prix
  // d'une collection locale que le serveur ne peut pas vérifier). Les paliers déjà atteints sont marqués comme réclamés : le navigateur les a déjà payés. Les voix
  // sont reprises aussi (demande de l'utilisateur, octobre 2026), jusqu'à MAX_VOIX_REPRISES : comme les cartes, le
  // serveur ne peut pas les vérifier, et le plafond borne ce qu'un navigateur retouché ferait entrer dans le comptoir.
  // Les paquets offerts ne sont pas repris. En cas d'échec, le compte reste vide et une nouvelle inscription le reprend.
  const repris = {};
  const brut = c.collection && typeof c.collection === "object" ? c.collection : {};
  for (const [id, n] of Object.entries(brut)) {
    const k = entier(n, 1, MAX_PAR_CARTE);
    if (k && cat.parId[id]) repris[id] = k;
  }
  const ids = Object.keys(repris), date = maintenant();
  const voix = Math.min(MAX_VOIX_REPRISES, entier(c.voix, 0, 1e9) || 0);
  const requetes = [
    ...insertionsGroupees(env, "INSERT INTO possessions (joueur, carte, n)", 3, ids.map(id => [joueur, id, repris[id]])),
    ...insertionsGroupees(env, "INSERT OR IGNORE INTO reclames (joueur, cle, date)", 3, Regles.clesAtteintes(cat, repris).map(cle => [joueur, cle, date])),
    ...(voix ? [env.DB.prepare("UPDATE joueurs SET points = points + ? WHERE id = ?").bind(voix, joueur)] : []),
  ];
  // Le journal en dernier : sa présence marque une reprise terminée
  if (ids.length || voix) requetes.push(noterJournal(env, joueur, "reprise", {cartes: ids.length, exemplaires: ids.reduce((a, id) => a + repris[id], 0), voix}));
  // Un seul lot, exécuté comme une transaction : la reprise passe en entier ou pas du tout
  if (requetes.length) await env.DB.batch(requetes);
  return json({connecte: true, ...(await chargerEtat(env, joueur))}, 201, {"set-cookie": await ouvrirSession(env, joueur)});
}
async function connexion(env, requete) {
  const {pseudo, preuve} = validerIdentifiants(await lireCorps(requete));
  const cle = "connexion:" + pseudo.toLowerCase();
  await purgerTentatives(env);
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
  const voixDonne = entier(c.voix_donne ?? 0, 0, PRIX_MAX), voixRecoit = entier(c.voix_recoit ?? 0, 0, PRIX_MAX);
  if (voixDonne === null || voixRecoit === null) throw new Refus(400, `Les voix d'un échange vont de 0 à ${PRIX_MAX.toLocaleString("fr-FR")}.`);
  if (voixDonne && voixRecoit) throw new Refus(400, "Ajoutez des voix d'un seul côté de l'échange.");
  if (!somme(donne) && !somme(recoit)) throw new Refus(400, "Choisissez au moins une carte.");
  if (somme(donne) + somme(recoit) > MAX_ECHANGE) throw new Refus(400, `Un échange porte au plus sur ${MAX_ECHANGE} cartes.`);
  const [mes, ses] = [await libres(env, joueur), await libres(env, dest.id)];
  for (const [id, q] of Object.entries(donne)) if ((mes[id] || 0) < q) throw new Refus(409, "Vous n'avez pas assez d'exemplaires libres de l'une des cartes proposées.");
  for (const [id, q] of Object.entries(recoit)) if ((ses[id] || 0) < q) throw new Refus(409, `${dest.pseudo} n'a pas assez d'exemplaires libres de l'une des cartes demandées.`);
  // Les voix de l'autre joueur ne sont pas vérifiées ici (ce serait dévoiler son solde) : seulement à l'acceptation
  if (voixDonne && (await env.DB.prepare("SELECT points FROM joueurs WHERE id = ?").bind(joueur).first()).points < voixDonne)
    throw new Refus(409, "Vous n'avez pas assez de voix pour cette proposition.");
  const enCours = await env.DB.prepare("SELECT COUNT(*) AS n FROM echanges WHERE de = ? AND statut = 'proposee'").bind(joueur).first();
  if (enCours.n >= MAX_ECHANGES_EN_COURS) throw new Refus(429, `Vous avez déjà ${MAX_ECHANGES_EN_COURS} propositions en attente.`);
  const date = maintenant();
  await env.DB.prepare("INSERT INTO echanges (de, vers, donne, recoit, statut, cree, maj, voix_donne, voix_recoit) VALUES (?, ?, ?, ?, 'proposee', ?, ?, ?, ?)")
    .bind(joueur, dest.id, JSON.stringify(donne), JSON.stringify(recoit), date, date, voixDonne, voixRecoit).run();
  await notifier(env, dest.id, `${await pseudoDe(env, joueur)} vous propose un échange à la buvette.`);
  return json({ok: true}, 201);
}
async function listeEchanges(env, joueur) {
  const r = await env.DB.prepare(`SELECT e.id, e.de, e.vers, e.donne, e.recoit, e.voix_donne, e.voix_recoit, e.statut, e.cree, e.maj, a.pseudo AS pseudo_de, b.pseudo AS pseudo_vers
    FROM echanges e JOIN joueurs a ON a.id = e.de JOIN joueurs b ON b.id = e.vers
    WHERE (e.de = ?1 OR e.vers = ?1) ORDER BY (e.statut = 'proposee') DESC, e.maj DESC LIMIT 60`).bind(joueur).all();
  return json({echanges: r.results.map(e => ({id: e.id, recu: e.vers === joueur, avec: e.vers === joueur ? e.pseudo_de : e.pseudo_vers,
    donne: JSON.parse(e.donne), recoit: JSON.parse(e.recoit), voixDonne: e.voix_donne, voixRecoit: e.voix_recoit, statut: e.statut, cree: e.cree, maj: e.maj}))});
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
    // Voix : retirées sous la contrainte points >= 0, qui annule tout l'échange si l'un n'en a plus assez
    const virement = (de, vers, v) => [env.DB.prepare("UPDATE joueurs SET points = points - ? WHERE id = ?").bind(v, de),
      env.DB.prepare("UPDATE joueurs SET points = points + ? WHERE id = ?").bind(v, vers)];
    if (e.voix_donne) requetes.push(...virement(e.de, e.vers, e.voix_donne));
    if (e.voix_recoit) requetes.push(...virement(e.vers, e.de, e.voix_recoit));
    requetes.push(noterJournal(env, e.de, "echange", {id, avec: e.vers}), noterJournal(env, e.vers, "echange", {id, avec: e.de}));
  }
  await lot(env, requetes, action === "accepter"
    ? "L'échange n'est plus possible : l'un de vous n'a plus assez d'exemplaires libres ou de voix." : "Cet échange n'est plus en attente.");
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
// Annonces du joueur (vendeur), ses achats (historique de la buvette), les offres reçues sur ses annonces ouvertes et
// celles qu'il a faites
async function mesAnnonces(env, joueur) {
  const [r, achats, recues, faites] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id, a.carte, a.prix, a.statut, a.cree, a.maj, j.pseudo AS acheteur FROM annonces a
      LEFT JOIN joueurs j ON j.id = a.acheteur WHERE a.vendeur = ? ORDER BY (a.statut = 'ouverte') DESC, a.id DESC LIMIT 100`).bind(joueur),
    env.DB.prepare(`SELECT a.id, a.carte, a.prix, a.maj, j.pseudo AS vendeur FROM annonces a JOIN joueurs j ON j.id = a.vendeur
      WHERE a.acheteur = ? ORDER BY a.id DESC LIMIT 100`).bind(joueur),
    env.DB.prepare(`SELECT o.id, o.annonce, o.prix, o.cree, j.pseudo AS acheteur FROM annonces a JOIN offres o ON o.annonce = a.id
      JOIN joueurs j ON j.id = o.acheteur WHERE a.vendeur = ? AND a.statut = 'ouverte' AND o.statut = 'proposee' ORDER BY o.id DESC LIMIT 200`).bind(joueur),
    env.DB.prepare(`SELECT id, annonce, prix, statut, maj FROM offres WHERE acheteur = ? AND statut = 'proposee' ORDER BY id DESC LIMIT ${MAX_OFFRES_EN_COURS}`).bind(joueur),
  ]);
  return json({annonces: r.results, achats: achats.results, offres: recues.results, mesOffres: faites.results});
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
    env.DB.prepare("INSERT INTO annonces (vendeur, carte, prix, statut, cree, maj, rarete) VALUES (?, ?, ?, 'ouverte', ?, ?, ?)").bind(joueur, carte, prix, date, date, cat.parId[carte].rarete),
  ], "Vous n'avez plus d'exemplaire libre de cette carte.");
  // Joueurs qui guettent cette carte (alertes de vente) : avertis après la réponse
  const guetteurs = (await env.DB.prepare("SELECT joueur, nom FROM alertes WHERE carte = ? AND joueur != ? LIMIT 200").bind(carte, joueur).all()).results;
  const avis = Promise.all(guetteurs.map(g => notifier(env, g.joueur, `${g.nom || "Une carte que vous guettez"} est en vente au comptoir : ${prix.toLocaleString("fr-FR")} voix.`)
    .catch(e => console.error("alerte", e))));
  if (env.ctx) env.ctx.waitUntil(avis); else await avis;
  return json({ok: true}, 201);
}
// Offres en attente d'une annonce qui se clôt (achat, retrait, offre acceptée) : closes avec elle, dans le même lot
const offresCaduques = (env, annonce, date, sauf = 0) => [
  env.DB.prepare("INSERT INTO clotures (nature, id) SELECT 'offre', id FROM offres WHERE annonce = ? AND statut = 'proposee' AND id != ?").bind(annonce, sauf),
  env.DB.prepare("UPDATE offres SET statut = 'caduque', maj = ? WHERE annonce = ? AND statut = 'proposee' AND id != ?").bind(date, annonce, sauf),
];
async function cloreAnnonce(env, joueur, id, action) {
  const a = await env.DB.prepare("SELECT * FROM annonces WHERE id = ?").bind(id).first();
  if (!a || a.statut !== "ouverte") throw new Refus(409, "Cette carte n'est plus au comptoir.");
  const date = maintenant();
  const requetes = [env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('annonce', ?)").bind(id), ...offresCaduques(env, id, date)];
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
    await notifier(env, a.vendeur, `Une de vos cartes s'est vendue ${a.prix} voix au comptoir.`);
  }
  return json({ok: true});
}
// Contre-offre : moins que le prix demandé, sans retenue de voix (vérifiées à l'acceptation, sous la contrainte points >= 0)
async function faireOffre(env, requete, joueur, id) {
  const c = await lireCorps(requete);
  const a = await env.DB.prepare("SELECT * FROM annonces WHERE id = ?").bind(id).first();
  if (!a || a.statut !== "ouverte") throw new Refus(409, "Cette carte n'est plus au comptoir.");
  if (a.vendeur === joueur) throw new Refus(400, "Vous ne pouvez pas faire d'offre sur votre propre carte.");
  if (a.prix < 2) throw new Refus(400, "Cette carte est déjà au plus bas prix.");
  const prix = entier(c.prix, 1, a.prix - 1);
  if (!prix) throw new Refus(400, `Une offre va de 1 à ${(a.prix - 1).toLocaleString("fr-FR")} voix ; au prix demandé, achetez la carte.`);
  const [moi, enCours] = await env.DB.batch([
    env.DB.prepare("SELECT points FROM joueurs WHERE id = ?").bind(joueur),
    env.DB.prepare("SELECT COUNT(*) AS n FROM offres WHERE acheteur = ? AND statut = 'proposee' AND annonce != ?").bind(joueur, id),
  ]);
  if (moi.results[0].points < prix) throw new Refus(409, "Vous n'avez pas assez de voix pour cette offre.");
  if (enCours.results[0].n >= MAX_OFFRES_EN_COURS) throw new Refus(429, `Vous avez déjà ${MAX_OFFRES_EN_COURS} offres en attente.`);
  const date = maintenant();
  await lot(env, [
    // La nouvelle offre remplace celle que l'acheteur avait déjà faite sur cette annonce
    env.DB.prepare("INSERT INTO clotures (nature, id) SELECT 'offre', id FROM offres WHERE annonce = ? AND acheteur = ? AND statut = 'proposee'").bind(id, joueur),
    env.DB.prepare("UPDATE offres SET statut = 'remplacee', maj = ? WHERE annonce = ? AND acheteur = ? AND statut = 'proposee'").bind(date, id, joueur),
    env.DB.prepare("INSERT INTO offres (annonce, acheteur, prix, statut, cree, maj) VALUES (?, ?, ?, 'proposee', ?, ?)").bind(id, joueur, prix, date, date),
  ], "Votre offre précédente vient d'être acceptée ou refusée.");
  await notifier(env, a.vendeur, `${await pseudoDe(env, joueur)} vous offre ${prix.toLocaleString("fr-FR")} voix pour une de vos cartes au comptoir.`);
  return json({ok: true}, 201);
}
// Accepter ou refuser (le vendeur), retirer (l'acheteur) ; acceptée, l'offre vaut achat au prix offert
async function cloreOffre(env, joueur, id, action) {
  const o = await env.DB.prepare(`SELECT o.*, a.vendeur, a.carte, a.statut AS etat_annonce FROM offres o JOIN annonces a ON a.id = o.annonce
    WHERE o.id = ?`).bind(id).first();
  if (!o || o.statut !== "proposee") throw new Refus(409, "Cette offre n'est plus en attente.");
  if ((action === "annuler" ? o.acheteur : o.vendeur) !== joueur) throw new Refus(403, "Cette offre ne vous est pas adressée.");
  const date = maintenant(), requetes = [env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('offre', ?)").bind(id)];
  if (action !== "accepter") {
    requetes.push(env.DB.prepare("UPDATE offres SET statut = ?, maj = ? WHERE id = ?").bind(action === "refuser" ? "refusee" : "annulee", date, id));
    await lot(env, requetes, "Cette offre n'est plus en attente.");
    if (action === "refuser") await notifier(env, o.acheteur, `${await pseudoDe(env, joueur)} a refusé votre offre de ${o.prix.toLocaleString("fr-FR")} voix au comptoir.`);
    return json({ok: true});
  }
  if (o.etat_annonce !== "ouverte") throw new Refus(409, "Cette carte n'est plus au comptoir.");
  requetes.push(
    env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('annonce', ?)").bind(o.annonce),
    ...offresCaduques(env, o.annonce, date, id),
    env.DB.prepare("UPDATE offres SET statut = 'acceptee', maj = ? WHERE id = ?").bind(date, id),
    // Prix de vente : celui de l'offre (historique, prix médians du comptoir)
    env.DB.prepare("UPDATE annonces SET statut = 'vendue', acheteur = ?, prix = ?, maj = ? WHERE id = ?").bind(o.acheteur, o.prix, date, o.annonce),
    env.DB.prepare("UPDATE joueurs SET points = points - ? WHERE id = ?").bind(o.prix, o.acheteur),
    env.DB.prepare("UPDATE joueurs SET points = points + ? WHERE id = ?").bind(o.prix, o.vendeur),
    env.DB.prepare("UPDATE possessions SET n = n - 1, reserve = reserve - 1 WHERE joueur = ? AND carte = ?").bind(o.vendeur, o.carte),
    ajoutCartes(env, o.acheteur, o.carte, 1),
    noterJournal(env, o.acheteur, "achat", {annonce: o.annonce, carte: o.carte, prix: o.prix, offre: id}),
    noterJournal(env, o.vendeur, "vente", {annonce: o.annonce, carte: o.carte, prix: o.prix, offre: id}));
  await lot(env, requetes, "Vente impossible : l'acheteur n'a plus assez de voix, ou la carte a déjà quitté le comptoir.");
  await notifier(env, o.acheteur, `${await pseudoDe(env, joueur)} accepte votre offre de ${o.prix.toLocaleString("fr-FR")} voix : la carte est dans votre hémicycle.`);
  return json({ok: true});
}
// Alertes de vente : posées ou retirées depuis la grande carte (MAX_ALERTES au plus)
async function changerAlerte(env, requete, joueur, cat) {
  const c = await lireCorps(requete), carte = String(c.carte || "");
  if (!cat.parId[carte]) throw new Refus(400, "Carte inconnue.");
  if (c.actif) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM alertes WHERE joueur = ? AND carte != ?").bind(joueur, carte).first();
    if (n.n >= MAX_ALERTES) throw new Refus(409, `${MAX_ALERTES} alertes au plus : retirez-en une d'abord.`);
    await env.DB.prepare("INSERT INTO alertes (joueur, carte, nom, date) VALUES (?, ?, ?, ?) ON CONFLICT (joueur, carte) DO UPDATE SET nom = excluded.nom")
      .bind(joueur, carte, String(c.nom || "").replace(/\s+/g, " ").trim().slice(0, 80), maintenant()).run();
  } else await env.DB.prepare("DELETE FROM alertes WHERE joueur = ? AND carte = ?").bind(joueur, carte).run();
  return listeAlertes(env, joueur);
}
async function listeAlertes(env, joueur) {
  const r = await env.DB.prepare("SELECT carte FROM alertes WHERE joueur = ? ORDER BY date").bind(joueur).all();
  return json({alertes: r.results.map(x => x.carte)});
}

/* ---------- Notifications (Web Push) ---------- */
// Envoi sans contenu chiffré : le serveur garde le texte dans « notifications » et réveille l'appareil par une
// poussée vide, signée VAPID (RFC 8292) ; le service de travail du site lit alors les messages en attente
// (GET /api/notifications) et les affiche. Les clés VAPID sont créées à la première demande et gardées en base.
const SERVICES_PUSH = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];
const b64url = octets => btoa(String.fromCharCode(...new Uint8Array(octets))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let clesVapid = null;
async function vapid(env, origine) {
  if (clesVapid) return clesVapid;
  const ligne = await env.DB.prepare("SELECT valeur FROM reglages WHERE cle = 'vapid'").first();
  let v = ligne && JSON.parse(ligne.valeur);
  if (!v) {
    const paire = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
    v = {publique: b64url(await crypto.subtle.exportKey("raw", paire.publicKey)), privee: await crypto.subtle.exportKey("jwk", paire.privateKey), sujet: origine};
    await env.DB.prepare("INSERT OR IGNORE INTO reglages (cle, valeur) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run();
    v = JSON.parse((await env.DB.prepare("SELECT valeur FROM reglages WHERE cle = 'vapid'").first()).valeur);   // une seule paire, même en cas de course
  }
  v.cle = await crypto.subtle.importKey("jwk", v.privee, {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  return (clesVapid = v);
}
async function pousser(env, endpoint) {
  const v = await vapid(env);
  const texte = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const corps = texte({typ: "JWT", alg: "ES256"}) + "." + texte({aud: new URL(endpoint).origin, exp: secondes() + 12 * 3600, sub: v.sujet});
  const signature = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, v.cle, new TextEncoder().encode(corps));
  const r = await fetch(endpoint, {method: "POST", headers: {TTL: "86400", Urgency: "normal", Authorization: `vapid t=${corps}.${b64url(signature)}, k=${v.publique}`}});
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM abonnements WHERE endpoint = ?").bind(endpoint).run();
  return r.status;
}
const pseudoDe = async (env, id) => (await env.DB.prepare("SELECT pseudo FROM joueurs WHERE id = ?").bind(id).first())?.pseudo || "Un joueur";
// Message pour un joueur (échanges, amis, duels, ventes) : gardé, puis poussé à ses appareils abonnés, après la réponse
async function notifier(env, joueur, texte, genre = "buvette", lien = null) {
  const abonnes = (await env.DB.prepare(`SELECT endpoint FROM abonnements WHERE joueur = ? AND ${genre === "reserve" ? "reserve" : "buvette"} = 1`).bind(joueur).all()).results;
  if (!abonnes.length) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications WHERE joueur = ? AND id NOT IN (SELECT id FROM notifications WHERE joueur = ? ORDER BY id DESC LIMIT 19)").bind(joueur, joueur),
    env.DB.prepare("DELETE FROM notifications WHERE joueur = ? AND texte = ?").bind(joueur, texte),  // même message non lu : remplacé
    env.DB.prepare("INSERT INTO notifications (joueur, texte, date, lien) VALUES (?, ?, ?, ?)").bind(joueur, texte, maintenant(), lien),
  ]);
  const envois = Promise.all(abonnes.map(a => pousser(env, a.endpoint).catch(e => console.error("poussée", e))));
  if (env.ctx) env.ctx.waitUntil(envois); else await envois;
}
async function abonner(env, requete, joueur, origine) {
  const c = await lireCorps(requete), a = c.abonnement || {};
  let hote;
  try { const u = new URL(String(a.endpoint || "")); if (u.protocol !== "https:") throw 0; hote = u.hostname; } catch (_) { throw new Refus(400, "Abonnement illisible."); }
  if (!SERVICES_PUSH.some(r => r.test(hote))) throw new Refus(400, "Service de notification inconnu.");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM abonnements WHERE joueur = ?").bind(joueur).first();
  if (n.n >= 10) await env.DB.prepare("DELETE FROM abonnements WHERE joueur = ? AND endpoint IN (SELECT endpoint FROM abonnements WHERE joueur = ? ORDER BY date LIMIT 1)").bind(joueur, joueur).run();
  await vapid(env, origine);
  await env.DB.prepare(`INSERT INTO abonnements (endpoint, joueur, buvette, reserve, date) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET joueur = excluded.joueur, buvette = excluded.buvette, reserve = excluded.reserve`)
    .bind(a.endpoint, joueur, c.buvette === false ? 0 : 1, c.reserve === false ? 0 : 1, maintenant()).run();
  return json({ok: true});
}
async function lireNotifications(env, joueur) {
  const [r] = await env.DB.batch([
    env.DB.prepare("SELECT texte, date, lien FROM notifications WHERE joueur = ? ORDER BY id").bind(joueur),
    env.DB.prepare("DELETE FROM notifications WHERE joueur = ?").bind(joueur),
  ]);
  return json({notifications: r.results});
}
// Toutes les heures (déclencheur planifié) : réserve pleine, une fois par remplissage. Seulement si la moitié au moins
// de la réserve s'est remplie depuis le dernier paquet ouvert (RESERVE_MIN_AVIS) : un paquet ouvert d'une réserve
// pleine la rendait de nouveau pleine une heure plus tard, d'où une notification presque à chaque paquet (signalé par
// l'utilisateur, octobre 2026)
const RESERVE_MIN_AVIS = Regles.RESERVE_MAX / 2;
async function surveillerReserves(env) {
  await preparerBase(env);
  const r = await env.DB.prepare(`SELECT DISTINCT j.id, j.stock, j.ancre, j.offerts, j.points FROM abonnements a JOIN joueurs j ON j.id = a.joueur
    WHERE a.reserve = 1 AND a.reserve_vue != j.ancre || '|' || j.stock AND j.stock <= ?`).bind(Regles.RESERVE_MAX - RESERVE_MIN_AVIS).all();
  for (const j of r.results) {
    if (!Regles.reserveCourante({reserve: j.stock, ancre: j.ancre}).pleine) continue;
    await env.DB.prepare("UPDATE abonnements SET reserve_vue = ? WHERE joueur = ?").bind(j.ancre + "|" + j.stock, j.id).run();
    await notifier(env, j.id, `Votre réserve est pleine : ${Regles.RESERVE_MAX} paquets vous attendent en séance.`, "reserve");
  }
}

/* ---------- Prix du comptoir, attente, vitrine, favoris, amis, compte ---------- */
async function prixComptoir(env, url, cat) {
  const carte = String(url.searchParams.get("carte") || "");
  if (!cat.parId[carte]) throw new Refus(400, "Carte inconnue.");
  const rarete = cat.parId[carte].rarete;
  const [ventes, parRarete] = await env.DB.batch([
    env.DB.prepare("SELECT prix, maj AS date FROM annonces WHERE carte = ? AND statut = 'vendue' ORDER BY id DESC LIMIT 10").bind(carte),
    env.DB.prepare("SELECT prix FROM annonces WHERE rarete = ? AND statut = 'vendue' ORDER BY id DESC LIMIT 50").bind(rarete),
  ]);
  const prix = parRarete.results.map(x => x.prix).sort((a, b) => a - b);
  const mediane = prix.length ? (prix.length % 2 ? prix[(prix.length - 1) / 2] : Math.round((prix[prix.length / 2 - 1] + prix[prix.length / 2]) / 2)) : null;
  return json({ventes: ventes.results, rarete, mediane, ventesRarete: prix.length});
}
// Identifiant de carte : numéro Sycomore, « S » et matricule, ou « G- » et nom (Gouvernement sans mandat, 41 signes)
const ID_CARTE = /^[A-Za-z0-9-]{1,60}$/;
// Nombre de joueurs qui ont au moins un exemplaire d'une carte, sans dire lesquels ; gardé dix minutes en cache
async function detenteurs(env, url) {
  const carte = String(url.searchParams.get("carte") || "");
  if (!ID_CARTE.test(carte)) throw new Refus(400, "Carte inconnue.");
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM possessions WHERE carte = ? AND n > 0").bind(carte).first();
  return json({carte, joueurs: r.n}, 200, {"cache-control": "public, max-age=600"});
}
async function attente(env, joueur) {
  const [e, d, a, o, g] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM echanges WHERE vers = ? AND statut = 'proposee'").bind(joueur),
    env.DB.prepare("SELECT COUNT(*) AS n FROM amis WHERE vers = ? AND statut = 'demande'").bind(joueur),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM duels WHERE statut IN ('propose', 'accepte')
      AND ((de = ?1 AND score_de IS NULL) OR (vers = ?1 AND score_vers IS NULL AND statut = 'accepte') OR (vers = ?1 AND statut = 'propose'))`).bind(joueur),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM annonces a JOIN offres o ON o.annonce = a.id WHERE a.vendeur = ? AND a.statut = 'ouverte' AND o.statut = 'proposee'`).bind(joueur),
    // Jeu du Gouvernement : défi reçu, gouvernement à choisir, coup à jouer
    env.DB.prepare(`SELECT COUNT(*) AS n FROM parties WHERE (b = ?1 AND mode = 'ami' AND statut = 'propose') OR (a = ?1 AND statut = 'preparation')
      OR (statut = 'en-cours' AND ((a = ?1 AND json_array_length(coups_a) <= json_array_length(coups_b))
                                   OR (b = ?1 AND mode = 'ami' AND json_array_length(coups_b) <= json_array_length(coups_a))))`).bind(joueur),
  ]);
  return json({echanges: e.results[0].n, amis: d.results[0].n, duels: a.results[0].n, offres: o.results[0].n, gouvernement: g.results[0].n});
}
const MAX_VITRINE = 6;
async function changerVitrine(env, requete, joueur) {
  const ids = [...new Set((await lireCorps(requete)).cartes || [])].map(String).slice(0, MAX_VITRINE);
  if (ids.length) {
    const r = await env.DB.prepare(`SELECT carte FROM possessions WHERE joueur = ? AND n > 0 AND carte IN (${ids.map(() => "?").join(",")})`).bind(joueur, ...ids).all();
    if (r.results.length !== ids.length) throw new Refus(409, "La vitrine ne peut montrer que des cartes de votre collection.");
  }
  await env.DB.prepare("UPDATE joueurs SET vitrine = ? WHERE id = ?").bind(JSON.stringify(ids), joueur).run();
  return json({ok: true, vitrine: ids});
}
async function profil(env, pseudo) {
  const j = await env.DB.prepare("SELECT id, pseudo, cree, vitrine FROM joueurs WHERE pseudo = ?").bind(String(pseudo).normalize("NFC").trim()).first();
  if (!j) throw new Refus(404, "Aucun joueur ne porte ce pseudo.");
  const [c, p, d, v] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM possessions WHERE joueur = ? AND n > 0").bind(j.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reclames WHERE joueur = ?").bind(j.id),
    env.DB.prepare(`SELECT COUNT(*) AS joues, SUM(CASE WHEN (de = ?1 AND score_de > score_vers) OR (vers = ?1 AND score_vers > score_de) THEN 1 ELSE 0 END) AS gagnes
      FROM duels WHERE (de = ?1 OR vers = ?1) AND score_de IS NOT NULL AND score_vers IS NOT NULL`).bind(j.id),
    env.DB.prepare(`SELECT carte FROM possessions WHERE joueur = ? AND n > 0 AND carte IN (SELECT value FROM json_each(?))`).bind(j.id, j.vitrine),
  ]);
  const garde = new Set(v.results.map(x => x.carte));
  return json({pseudo: j.pseudo, cree: j.cree, cartes: c.results[0].n, paliers: p.results[0].n,
    duels: {joues: d.results[0].joues || 0, gagnes: d.results[0].gagnes || 0}, vitrine: JSON.parse(j.vitrine).filter(id => garde.has(id))});
}
// Favoris : étoile posée ou retirée sur une carte de la collection (300 au plus)
const MAX_FAVORIS = 300;
async function changerFavori(env, requete, joueur, cat) {
  const c = await lireCorps(requete);
  const carte = String(c.carte || "");
  if (!cat.parId[carte]) throw new Refus(400, "Carte inconnue.");
  const j = await env.DB.prepare("SELECT favoris FROM joueurs WHERE id = ?").bind(joueur).first();
  const favoris = JSON.parse(j.favoris || "[]").filter(id => id !== carte);
  if (c.actif) {
    if (favoris.length >= MAX_FAVORIS) throw new Refus(409, `${MAX_FAVORIS} favoris au plus.`);
    favoris.push(carte);
  }
  await env.DB.prepare("UPDATE joueurs SET favoris = ? WHERE id = ?").bind(JSON.stringify(favoris), joueur).run();
  return json({favoris});
}
// Cartes gardées (« Ne pas dissoudre ») : posées ou levées par lot depuis la sélection de l'hémicycle ou la grande carte
async function changerGardes(env, requete, joueur, cat) {
  const c = await lireCorps(requete);
  const ids = (Array.isArray(c.cartes) ? c.cartes : []).map(String).slice(0, Regles.MAX_GARDES);
  if (!ids.length || ids.some(id => !cat.parId[id])) throw new Refus(400, "Carte inconnue.");
  const j = await env.DB.prepare("SELECT gardes FROM joueurs WHERE id = ?").bind(joueur).first();
  const etat = {gardes: JSON.parse(j.gardes || "[]")};
  Regles.garderCartes(etat, ids, c.actif === true);
  await env.DB.prepare("UPDATE joueurs SET gardes = ? WHERE id = ?").bind(JSON.stringify(etat.gardes), joueur).run();
  return json({gardes: etat.gardes});
}
// Amis : demande, acceptation (une demande croisée vaut acceptation), retrait (refus, annulation, fin d'amitié)
const MAX_AMIS = 200;
// Amis qui ont une carte : exemplaires et exemplaires libres (hors vente), pour leur proposer un échange
async function amisAvecCarte(env, url, joueur) {
  const carte = String(url.searchParams.get("carte") || "");
  if (!ID_CARTE.test(carte)) throw new Refus(400, "Carte inconnue.");
  const r = await env.DB.prepare(`SELECT j.pseudo, p.n, p.n - p.importes - p.reserve AS libres FROM amis a
    JOIN possessions p ON p.joueur = a.vers AND p.carte = ?2 JOIN joueurs j ON j.id = a.vers
    WHERE a.de = ?1 AND a.statut = 'accepte' AND p.n > 0 ORDER BY libres DESC, j.pseudo COLLATE NOCASE`).bind(joueur, carte).all();
  return json({carte, amis: r.results});
}
async function listeAmis(env, joueur) {
  const r = await env.DB.prepare(`SELECT a.de, a.vers, a.statut, j.pseudo, j.vitrine FROM amis a JOIN joueurs j ON j.id = CASE WHEN a.de = ?1 THEN a.vers ELSE a.de END
    WHERE a.de = ?1 OR a.vers = ?1 ORDER BY j.pseudo COLLATE NOCASE`).bind(joueur).all();
  // vitrines : les trois premières cartes de la vitrine de chaque ami, pour la liste (déjà dans la ligne du joueur)
  const amis = [], recues = [], envoyees = [], vitrines = {};
  for (const x of r.results) {
    if (x.statut === "accepte") {
      if (x.de !== joueur) continue;
      amis.push(x.pseudo);
      try { vitrines[x.pseudo] = JSON.parse(x.vitrine || "[]").filter(Boolean).slice(0, 3); } catch (_) { vitrines[x.pseudo] = []; }
    }
    else (x.vers === joueur ? recues : envoyees).push(x.pseudo);
  }
  // Suggestions : amis de mes amis, sans lien avec moi (ni ami, ni demande dans un sens ou l'autre), les plus d'amis en
  // commun d'abord ; parcours des clés (de, vers) de la table amis, quelques lignes par ami
  const s = await env.DB.prepare(`SELECT j.pseudo, COUNT(*) AS communs FROM amis a1
    JOIN amis a2 ON a2.de = a1.vers AND a2.statut = 'accepte' JOIN joueurs j ON j.id = a2.vers
    WHERE a1.de = ?1 AND a1.statut = 'accepte' AND a2.vers != ?1
      AND NOT EXISTS (SELECT 1 FROM amis x WHERE (x.de = ?1 AND x.vers = a2.vers) OR (x.de = a2.vers AND x.vers = ?1))
    GROUP BY a2.vers ORDER BY communs DESC, j.pseudo COLLATE NOCASE LIMIT 6`).bind(joueur).all();
  return json({amis, recues, envoyees, vitrines, suggestions: s.results});
}
async function actionAmi(env, requete, joueur, action) {
  const autre = await idJoueur(env, (await lireCorps(requete)).pseudo);
  if (autre.id === joueur) throw new Refus(400, "Vous ne pouvez pas être votre propre ami.");
  const date = maintenant();
  if (action === "demander") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM amis WHERE de = ?").bind(joueur).first();
    if (n.n >= MAX_AMIS) throw new Refus(429, `${MAX_AMIS} amis au plus.`);
    const inverse = await env.DB.prepare("SELECT statut FROM amis WHERE de = ? AND vers = ?").bind(autre.id, joueur).first();
    if (inverse) action = "accepter";   // l'autre l'avait déjà demandé : c'est une acceptation
    else {
      await env.DB.prepare("INSERT OR IGNORE INTO amis (de, vers, statut, date) VALUES (?, ?, 'demande', ?)").bind(joueur, autre.id, date).run();
      await notifier(env, autre.id, `${await pseudoDe(env, joueur)} vous demande en ami.`);
      return json({ok: true, statut: "demande"});
    }
  }
  if (action === "accepter") {
    const demande = await env.DB.prepare("SELECT 1 FROM amis WHERE de = ? AND vers = ?").bind(autre.id, joueur).first();
    if (!demande) throw new Refus(409, "Aucune demande de ce joueur.");
    await env.DB.batch([
      env.DB.prepare("UPDATE amis SET statut = 'accepte', date = ? WHERE de = ? AND vers = ?").bind(date, autre.id, joueur),
      env.DB.prepare("INSERT INTO amis (de, vers, statut, date) VALUES (?, ?, 'accepte', ?) ON CONFLICT (de, vers) DO UPDATE SET statut = 'accepte'").bind(joueur, autre.id, date),
    ]);
    await notifier(env, autre.id, `${await pseudoDe(env, joueur)} a accepté votre demande d'ami.`);
    return json({ok: true, statut: "accepte"});
  }
  await env.DB.prepare("DELETE FROM amis WHERE (de = ?1 AND vers = ?2) OR (de = ?2 AND vers = ?1)").bind(joueur, autre.id).run();
  return json({ok: true, statut: "aucun"});
}
// Code saisi dans Mon siège : 10 essais par quart d'heure (on ne devine pas un code au hasard) ; tout est écrit dans un
// seul lot, la clé de codes_utilises empêche une seconde utilisation et la contrainte de codes la limite d'utilisations
async function utiliserCode(env, requete, joueur, cat) {
  const saisi = String((await lireCorps(requete)).code || "").normalize("NFC").trim().slice(0, 60);
  if (!saisi) throw new Refus(400, "Saisissez un code.");
  await purgerTentatives(env);
  await limiter(env, "code:" + joueur, LIMITES.connexion);
  // Code du dépôt (worker/codes.js, par empreinte) : recopié ou mis à jour dans D1, qui compte les utilisations.
  // CODE_ESSAI (variable du Worker local des tests seulement) ajoute le code « essai-depot »
  const empreinte = await sha256(saisi.toLowerCase());
  const essais = env.CODE_ESSAI ? [{empreinte: await sha256("essai-depot"), voix: 4, paquets: 0, cartes: [], limite: null, fin: null},
    {empreinte: await sha256("essai-choix"), voix: 0, paquets: 0, cartes: [], choix: {choix: 3, raretes: ["rare", "epique", "legendaire", "mythique"]}, limite: null, fin: null}] : [];
  const depot = [...CODES, ...essais].find(x => x.empreinte === empreinte);
  // Une limite abaissée sous les utilisations déjà faites viole la contrainte : le code reste alors épuisé
  if (depot) await env.DB.prepare(`INSERT INTO codes (code, voix, paquets, cartes, limite, fin, choix) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (code) DO UPDATE SET voix = excluded.voix, paquets = excluded.paquets, cartes = excluded.cartes, limite = excluded.limite, fin = excluded.fin, choix = excluded.choix`)
    .bind(saisi.toLowerCase(), depot.voix || 0, depot.paquets || 0, JSON.stringify(depot.cartes || []), depot.limite ?? null, depot.fin ?? null,
      depot.choix ? JSON.stringify(depot.choix) : null).run()
    .catch(e => { if (!contrainte(e)) throw e; });
  const c = await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(saisi).first();
  // fin : « 2026-12-31 » vaut jusqu'à la fin de ce jour (heure UTC), comparée à la même longueur
  if (!c || (c.fin && c.fin < maintenant().slice(0, c.fin.length))) throw new Refus(404, "Ce code n'existe pas ou n'est plus valable.");
  if (await env.DB.prepare("SELECT 1 FROM codes_utilises WHERE code = ? AND joueur = ?").bind(c.code, joueur).first())
    throw new Refus(409, "Vous avez déjà utilisé ce code.");
  if (c.limite !== null && c.utilisations >= c.limite) throw new Refus(409, "Ce code a déjà servi autant de fois que prévu.");
  let cartes = [];
  try { cartes = [].concat(JSON.parse(c.cartes || "[]")).map(String).filter(id => cat.parId[id]); } catch (_) { cartes = []; }
  const parCarte = {};
  for (const id of cartes) parCarte[id] = (parCarte[id] || 0) + 1;
  const ecritures = [
    env.DB.prepare("INSERT INTO codes_utilises (code, joueur, date) VALUES (?, ?, ?)").bind(c.code, joueur, maintenant()),
    env.DB.prepare("UPDATE codes SET utilisations = utilisations + 1 WHERE code = ?").bind(c.code),
    env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(c.voix, c.paquets, joueur),
    ...Object.entries(parCarte).map(([id, q]) => ajoutCartes(env, joueur, id, q)),
    noterJournal(env, joueur, "code", {code: c.code, voix: c.voix, paquets: c.paquets, cartes}),
  ];
  // Choix de cartes : lot de la série (règles : offrirChoixGouv), écrit dans le même lot que l'utilisation du code ; refusé
  // tant qu'un autre lot attend d'être choisi
  const choix = lireJson(c.choix, null);
  let offertes = null;
  if (choix) {
    const r = await appliquer(env, joueur, e => {
      const x = Regles.offrirChoixGouv(e, cat, choix, aleatoire);
      if (!x) throw new Refus(409, "Choisissez d'abord la carte qui vous attend au jeu du Gouvernement, puis saisissez de nouveau ce code.");
      return x;
    }, ecritures).catch(e => { if (e instanceof Refus) throw e; if (contrainte(e)) throw new Refus(409, "Ce code vient d'être utilisé : réessayez."); throw e; });
    offertes = r.choix;
  } else await lot(env, ecritures, "Ce code vient d'être utilisé : réessayez.");
  await oublier(env, "code:" + joueur);
  return json({gain: {voix: c.voix, paquets: c.paquets, cartes, ...(offertes ? {choix: offertes} : {})}, ...(await chargerEtat(env, joueur))});
}
// Changement de mot de passe : l'ancien est vérifié (10 essais par quart d'heure), le nouveau reçoit un sel neuf ; les
// autres sessions du joueur sont fermées, celle de l'appareil qui fait le changement reste ouverte
async function changerMotDePasse(env, requete, joueur) {
  const c = await lireCorps(requete), ancienne = String(c.ancienne || ""), nouvelle = String(c.nouvelle || "");
  if (![ancienne, nouvelle].every(p => /^[0-9a-f]{64}$/.test(p))) throw new Refus(400, "Mot de passe illisible.");
  const cle = "mot-de-passe:" + joueur;
  await purgerTentatives(env);
  await limiter(env, cle, LIMITES.connexion);
  const j = await env.DB.prepare("SELECT sel, empreinte FROM joueurs WHERE id = ?").bind(joueur).first();
  if (!j || !egaux(await sha256(j.sel + ancienne), j.empreinte)) throw new Refus(401, "Mot de passe actuel incorrect.");
  const sel = aleatoireHex(16), jeton = lireCookie(requete);
  await env.DB.batch([
    env.DB.prepare("UPDATE joueurs SET sel = ?, empreinte = ? WHERE id = ?").bind(sel, await sha256(sel + nouvelle), joueur),
    env.DB.prepare("DELETE FROM sessions WHERE joueur = ? AND jeton != ?").bind(joueur, jeton ? await sha256(jeton) : ""),
  ]);
  await oublier(env, cle);
  return json({ok: true});
}
async function supprimerCompte(env, requete, joueur) {
  const preuve = String((await lireCorps(requete)).preuve || "");
  const j = await env.DB.prepare("SELECT sel, empreinte FROM joueurs WHERE id = ?").bind(joueur).first();
  if (!j || !/^[0-9a-f]{64}$/.test(preuve) || !egaux(await sha256(j.sel + preuve), j.empreinte)) throw new Refus(401, "Mot de passe incorrect.");
  const date = maintenant();
  // Duels en cours : chaque adversaire récupère la mise qu'il avait engagée
  const ouverts = (await env.DB.prepare("SELECT * FROM duels WHERE (de = ?1 OR vers = ?1) AND statut IN ('propose', 'accepte')").bind(joueur).all()).results;
  const rendus = ouverts.filter(d => d.statut === "accepte" || d.de !== joueur).map(d =>
    env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.de === joueur ? d.vers : d.de));
  // Parties du Gouvernement entre amis : même chose (mise du lanceur rendue si le défi attendait ce joueur)
  const parties = (await env.DB.prepare("SELECT * FROM parties WHERE mode = 'ami' AND (a = ?1 OR b = ?1) AND statut IN ('propose', 'en-cours')").bind(joueur).all()).results;
  rendus.push(...parties.filter(d => d.statut === "en-cours" || d.a !== joueur).map(d =>
    env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.a === joueur ? d.b : d.a)));
  await env.DB.batch([
    ...rendus,
    // Offres sur ses annonces ouvertes, closes avec elles ; ses propres offres, effacées
    env.DB.prepare("UPDATE offres SET statut = 'caduque', maj = ? WHERE statut = 'proposee' AND annonce IN (SELECT id FROM annonces WHERE vendeur = ? AND statut = 'ouverte')").bind(date, joueur),
    env.DB.prepare("DELETE FROM offres WHERE acheteur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM alertes WHERE joueur = ?").bind(joueur),
    env.DB.prepare("UPDATE annonces SET statut = 'retiree', maj = ? WHERE vendeur = ? AND statut = 'ouverte'").bind(date, joueur),
    env.DB.prepare("UPDATE echanges SET statut = 'annulee', maj = ? WHERE (de = ?2 OR vers = ?2) AND statut = 'proposee'").bind(date, joueur),
    // Clôtures des duels effacés d'abord : leur numéro peut resservir à un nouveau duel (clé sans AUTOINCREMENT)
    env.DB.prepare("DELETE FROM clotures WHERE nature IN ('duel-releve', 'duel-clos', 'duel-fini') AND id IN (SELECT id FROM duels WHERE de = ?1 OR vers = ?1)").bind(joueur),
    env.DB.prepare("DELETE FROM duels WHERE de = ?1 OR vers = ?1").bind(joueur),
    env.DB.prepare("DELETE FROM parties WHERE a = ?1 OR (b = ?1 AND mode = 'ami')").bind(joueur),
    env.DB.prepare("DELETE FROM gouvernements WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM possessions WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM reclames WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM journal WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM sessions WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM signalements WHERE de = ?1 OR cible = ?1").bind(joueur),
    env.DB.prepare("DELETE FROM amis WHERE de = ?1 OR vers = ?1").bind(joueur),
    env.DB.prepare("DELETE FROM abonnements WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM notifications WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM codes_utilises WHERE joueur = ?").bind(joueur),
    env.DB.prepare("UPDATE messages SET joueur = NULL WHERE joueur = ?").bind(joueur),
    env.DB.prepare("DELETE FROM joueurs WHERE id = ?").bind(joueur),
  ]);
  return json({connecte: false}, 200, {"set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`});
}
async function contact(env, requete, joueur) {
  const c = await lireCorps(requete);
  const message = String(c.message || "").trim().slice(0, 2000), reponse = String(c.reponse || "").trim().slice(0, 200);
  if (message.length < 5) throw new Refus(400, "Écrivez votre message.");
  await limiter(env, "contact:" + (requete.headers.get("cf-connecting-ip") || "?"), [5, 3600]);
  // Les messages sont supprimés un an après leur réception (politique de confidentialité)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE date < ?").bind(new Date(Date.now() - 365 * 86400000).toISOString()),
    env.DB.prepare("INSERT INTO messages (joueur, reponse, message, date) VALUES (?, ?, ?, ?)").bind(joueur, reponse || null, message, maintenant()),
  ]);
  return json({ok: true}, 201);
}

/* ---------- Duels de questions ---------- */
// Le serveur juge les duels : il garde la graine, envoie les questions sans les réponses et corrige chaque réponse.
// Mise facultative, en voix ou en paquets offerts, retenue à chacun quand il s'engage (lancer, relever) ; le gagnant
// emporte les deux mises, une égalité rend la sienne à chacun. Un défi ignoré DUREE_DUEL est remboursé ; un duel relevé
// et resté inachevé est clos avec les réponses données (une question sans réponse est fausse).
const MAX_DUELS_EN_COURS = 20, MISE_VOIX_MAX = 100, MISE_PAQUETS_MAX = 3, DUREE_DUEL = 3 * 86400 * 1000;
const reponses = t => { try { return JSON.parse(t || "[]"); } catch (_) { return []; } };
const justes = l => l.filter(x => x[1]).length;
async function lancerDuel(env, requete, joueur) {
  const c = await lireCorps(requete);
  const adversaire = await idJoueur(env, c.vers);
  if (adversaire.id === joueur) throw new Refus(400, "Vous ne pouvez pas vous défier vous-même.");
  const voix = entier(c.voix ?? 0, 0, MISE_VOIX_MAX), paquets = entier(c.paquets ?? 0, 0, MISE_PAQUETS_MAX);
  if (voix === null || paquets === null) throw new Refus(400, `Mise de 0 à ${MISE_VOIX_MAX} voix et de 0 à ${MISE_PAQUETS_MAX} paquets.`);
  const enCours = await env.DB.prepare("SELECT COUNT(*) AS n FROM duels WHERE de = ? AND statut IN ('propose', 'accepte')").bind(joueur).first();
  if (enCours.n >= MAX_DUELS_EN_COURS) throw new Refus(429, `Vous avez déjà ${MAX_DUELS_EN_COURS} duels en cours.`);
  const date = maintenant(), graine = crypto.getRandomValues(new Uint32Array(1))[0];
  const [d] = await lot(env, [
    env.DB.prepare(`INSERT INTO duels (de, vers, graine, cree, maj, mise_voix, mise_paquets, statut) VALUES (?, ?, ?, ?, ?, ?, ?, 'propose') RETURNING id`)
      .bind(joueur, adversaire.id, graine, date, date, voix, paquets),
    env.DB.prepare("UPDATE joueurs SET points = points - ?, offerts = offerts - ? WHERE id = ?").bind(voix, paquets, joueur),
  ], "Vous n'avez pas assez de voix ou de paquets pour cette mise.");
  const mise = voix || paquets ? `, mise : ${[voix ? voix + " voix" : "", paquets ? paquets + (paquets > 1 ? " paquets" : " paquet") : ""].filter(Boolean).join(" et ")}` : "";
  await notifier(env, adversaire.id, `${await pseudoDe(env, joueur)} vous défie en duel aux questions au Gouvernement${mise}.`);
  return json({id: d.results[0].id, avec: adversaire.pseudo}, 201);
}
async function listeDuels(env, joueur) {
  const r = await env.DB.prepare(`SELECT d.*, a.pseudo AS pseudo_de, b.pseudo AS pseudo_vers FROM duels d
    JOIN joueurs a ON a.id = d.de JOIN joueurs b ON b.id = d.vers WHERE d.de = ?1 OR d.vers = ?1 ORDER BY d.id DESC LIMIT 30`).bind(joueur).all();
  return json({duels: r.results.map(d => {
    const moi = d.de === joueur, mes = reponses(moi ? d.rep_de : d.rep_vers), ses = reponses(moi ? d.rep_vers : d.rep_de);
    const mien = moi ? d.score_de : d.score_vers, sien = moi ? d.score_vers : d.score_de;
    const termine = d.statut === "fini" || (mien !== null && sien !== null);
    // Le score de l'adversaire n'est montré qu'une fois le duel terminé ; la graine reste sur le serveur
    return {id: d.id, avec: moi ? d.pseudo_vers : d.pseudo_de, lance: moi, statut: d.statut, voix: d.mise_voix, paquets: d.mise_paquets,
      repondues: mes.length, mien, sien: termine ? (sien ?? justes(ses)) : null, termine,
      issue: d.gagnant === null ? null : d.gagnant === 0 ? "egalite" : d.gagnant === joueur ? "gagne" : "perdu",
      echeance: new Date(Date.parse(d.statut === "propose" ? d.cree : (d.accepte || d.cree)) + DUREE_DUEL).toISOString(), cree: d.cree};
  })});
}
async function duelDe(env, joueur, id) {
  const d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(id).first();
  if (!d || (d.de !== joueur && d.vers !== joueur)) throw new Refus(404, "Duel introuvable.");
  return d;
}
// Relever (l'adversaire, mise retenue), refuser (l'adversaire) ou annuler (le lanceur) un défi pas encore relevé
async function repondreDefi(env, joueur, id, action) {
  const d = await duelDe(env, joueur, id), date = maintenant();
  if (d.statut !== "propose") throw new Refus(409, "Ce défi n'est plus en attente.");
  if ((action === "annuler") !== (d.de === joueur)) throw new Refus(403, action === "annuler" ? "Seul le lanceur peut annuler ce défi." : "Ce défi ne vous est pas adressé.");
  if (action === "relever") {
    await lot(env, [
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('duel-releve', ?)").bind(id),
      env.DB.prepare("UPDATE duels SET statut = 'accepte', accepte = ?, maj = ? WHERE id = ?").bind(date, date, id),
      env.DB.prepare("UPDATE joueurs SET points = points - ?, offerts = offerts - ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, joueur),
    ], "Vous n'avez pas assez de voix ou de paquets pour relever ce défi.");
    await terminerSiComplet(env, id);
  } else {
    await lot(env, [
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('duel-clos', ?)").bind(id),
      env.DB.prepare("UPDATE duels SET statut = ?, maj = ? WHERE id = ?").bind(action === "refuser" ? "refuse" : "annule", date, id),
      env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.de),
    ], "Ce défi vient d'être relevé ou clos.");
    if (action === "refuser") await notifier(env, d.de, `${await pseudoDe(env, joueur)} a décliné votre duel : votre mise vous est rendue.`);
  }
  return json({ok: true});
}
// Questions du duel, sans les réponses ; celles déjà données reviennent avec leur correction (reprise d'un duel)
async function questionsDuel(env, joueur, id, url) {
  const d = await duelDe(env, joueur, id);
  const moi = d.de === joueur, mes = reponses(moi ? d.rep_de : d.rep_vers);
  if (!["propose", "accepte"].includes(d.statut) || (!moi && d.statut === "propose")) throw new Refus(409, d.statut === "propose" ? "Relevez d'abord le défi." : "Ce duel est terminé.");
  const liste = Regles.questions(await lireQuiz(env, url), d.graine);
  return json({id, questions: liste.map((q, i) => ({texte: q.texte, choix: q.choix, ...(q.photo ? {photo: q.photo} : {}), carte: i < mes.length ? q.carte : null,
    ...(i < mes.length ? {repondu: mes[i][0], bonne: q.bonne, explication: q.explication} : {})}))});
}
// Une réponse, dans l'ordre : le serveur la corrige et la garde ; la cinquième fixe le score
async function repondreDuel(env, requete, joueur, id, url) {
  const c = await lireCorps(requete), d = await duelDe(env, joueur, id);
  const moi = d.de === joueur, colonne = moi ? "rep_de" : "rep_vers", score = moi ? "score_de" : "score_vers", mes = reponses(d[colonne]);
  if (!["propose", "accepte"].includes(d.statut) || (!moi && d.statut === "propose")) throw new Refus(409, "Ce duel ne se joue pas en ce moment.");
  const liste = Regles.questions(await lireQuiz(env, url), d.graine), i = entier(c.question, 0, liste.length - 1), choix = entier(c.choix, 0, 3);
  if (i === null || choix === null) throw new Refus(400, "Réponse illisible.");
  if (i !== mes.length) throw new Refus(409, "Cette question a déjà reçu une réponse.");
  const q = liste[i], apres = [...mes, [choix, choix === q.bonne ? 1 : 0]], fin = apres.length === liste.length;
  const r = await env.DB.prepare(`UPDATE duels SET ${colonne} = ?, ${score} = ?, maj = ? WHERE id = ? AND ${colonne} = ?`)
    .bind(JSON.stringify(apres), fin ? justes(apres) : null, maintenant(), id, d[colonne]).run();
  if (!r.meta.changes) throw new Refus(409, "Cette question a déjà reçu une réponse.");
  const resultat = fin ? await terminerSiComplet(env, id) : null;
  return json({bonne: q.bonne, juste: choix === q.bonne, explication: q.explication, carte: q.carte, fin, score: fin ? justes(apres) : null, resultat});
}
// Clôture d'un duel relevé : le gagnant emporte les deux mises, l'égalité rend la sienne à chacun (une fois : clotures)
async function cloreDuel(env, d) {
  const sd = d.score_de ?? justes(reponses(d.rep_de)), sv = d.score_vers ?? justes(reponses(d.rep_vers));
  const gagnant = sd > sv ? d.de : sv > sd ? d.vers : 0, date = maintenant();
  const credit = (id, fois) => env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix * fois, d.mise_paquets * fois, id);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('duel-fini', ?)").bind(d.id),
      env.DB.prepare("UPDATE duels SET statut = 'fini', score_de = ?, score_vers = ?, gagnant = ?, maj = ? WHERE id = ?").bind(sd, sv, gagnant, date, d.id),
      ...(gagnant ? [credit(gagnant, 2)] : [credit(d.de, 1), credit(d.vers, 1)]),
    ]);
  } catch (e) { if (contrainte(e)) return null; throw e; }
  // Pas de notification de résultat (retirée à la demande de l'utilisateur, octobre 2026) : le résultat se lit dans la Séance
  return {score: [sd, sv], gagnant};
}
async function terminerSiComplet(env, id) {
  const d = await env.DB.prepare("SELECT * FROM duels WHERE id = ?").bind(id).first();
  if (!d || d.statut !== "accepte" || d.score_de === null || d.score_vers === null) return null;
  return cloreDuel(env, d);
}
// Tâche horaire : défis ignorés remboursés, duels relevés et inachevés clos avec les réponses données
async function expirerDuels(env) {
  const limite = new Date(Date.now() - DUREE_DUEL).toISOString();
  const ignores = (await env.DB.prepare("SELECT * FROM duels WHERE statut = 'propose' AND cree < ?").bind(limite).all()).results;
  for (const d of ignores) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('duel-clos', ?)").bind(d.id),
      env.DB.prepare("UPDATE duels SET statut = 'expire', maj = ? WHERE id = ?").bind(maintenant(), d.id),
      env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.de),
    ]).catch(e => { if (!contrainte(e)) throw e; });
  }
  const inacheves = (await env.DB.prepare("SELECT * FROM duels WHERE statut = 'accepte' AND COALESCE(accepte, cree) < ?").bind(limite).all()).results;
  for (const d of inacheves) await cloreDuel(env, d);
}

/* ---------- Jeu du Gouvernement ---------- */
// Règles : site/gouvernement.js. Le fichier complet des fiches est trop long à lire dans la limite de calcul du plan
// gratuit : le serveur lit les fiches découpées par scripts/fiches_gouvernement.py (site/fiches/), en cache ensuite.
// Contre l'ordinateur ou un joueur tiré au hasard, la partie fait avancer la série (règles : issueSerieGouv, récompense
// encaissée à la fin) ; l'adversaire est vu avant de choisir son gouvernement, et une partie commencée ne se
// relance pas (une seule à la fois) : l'abandon vaut défaite. Contre un ami, mise comme aux duels, rendue sur un nul.
// Ouvert à tous les comptes (demande de l'utilisateur, octobre 2026), après une mise au point réservée à quatre testeurs.
// Annonce du nouveau mode (même demande) : une notification, une seule fois, à chaque joueur dont un appareil accepte une
// notification (buvette ou réserve), par la tâche horaire entre 10 h et 20 h à Paris (ANNONCE_TOUTE_HEURE pour les tests),
// par lots de ANNONCE_LOT joueurs (limite de sous-requêtes du plan gratuit) ; avancement noté dans reglages
const ANNONCE_GOUV = "Nouveau mode de jeu : le Gouvernement ! Formez votre équipe de ministres (le premier gouvernement est offert) et enchaînez les victoires pour gagner des récompenses.";
const ANNONCE_LOT = 15;
async function annoncerGouvernement(env) {
  const etape = await env.DB.prepare("SELECT valeur FROM reglages WHERE cle = 'annonce-gouv'").first();
  if (etape?.valeur === "fini") return;
  const heure = Number(new Intl.DateTimeFormat("fr-FR", {timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23"}).format(new Date()));
  if (!env.ANNONCE_TOUTE_HEURE && (heure < 10 || heure >= 20)) return;
  const dernier = Number(etape?.valeur || 0);
  const r = (await env.DB.prepare("SELECT DISTINCT joueur FROM abonnements WHERE (buvette = 1 OR reserve = 1) AND joueur > ? ORDER BY joueur LIMIT ?")
    .bind(dernier, ANNONCE_LOT).all()).results;
  const suite = r.length < ANNONCE_LOT ? "fini" : String(r[r.length - 1].joueur);
  // avancement noté d'abord : une exécution interrompue ne renvoie jamais deux fois l'annonce au même joueur
  await env.DB.prepare("INSERT INTO reglages (cle, valeur) VALUES ('annonce-gouv', ?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur").bind(suite).run();
  for (const {joueur} of r) {
    const genre = (await env.DB.prepare("SELECT 1 FROM abonnements WHERE joueur = ? AND buvette = 1").bind(joueur).first()) ? "buvette" : "reserve";
    await notifier(env, joueur, ANNONCE_GOUV, genre).catch(e => console.error("annonce", e));
  }
}
const MAX_GOUVERNEMENTS = 5, PRIX_GOUVERNEMENT = 10, MAX_PARTIES_AMIS = 20;
// Le premier gouvernement est offert (demande de l'utilisateur, octobre 2026) ; un compte qui a déjà formé un gouvernement,
// même supprimé depuis, paie les suivants (gouv_formes ; avant cette colonne, un gouvernement encore enregistré compte aussi)
const prixGouvernement = (formes, enregistres) => formes || enregistres ? PRIX_GOUVERNEMENT : 0;
const DUREE_PARTIE = 3 * 86400 * 1000, DUREE_PREPARATION = 86400 * 1000;
const ORIGINE_INTERNE = "https://hemicycle.interne/";  // adresse des fichiers du site pour la tâche planifiée (ASSETS)
const paquetsFiches = new Map();
let reelsServeur = null;
function lireFichier(env, url, chemin) {
  return env.ASSETS.fetch(new Request(new URL(chemin, url))).then(r => { if (!r.ok) throw new Error(chemin + " : " + r.status); return r.json(); });
}
async function fichesServeur(env, url, ids) {
  const fiches = new Map();
  for (const id of new Set(ids.map(String))) {
    const n = Gouvernement.paquetDeFiche(id);
    if (!paquetsFiches.has(n)) paquetsFiches.set(n, lireFichier(env, url, `/fiches/p${String(n).padStart(3, "0")}.json`).catch(e => { paquetsFiches.delete(n); throw e; }));
    const brut = (await paquetsFiches.get(n))[id];
    if (brut) fiches.set(id, Gouvernement.ficheDe(id, brut));
  }
  return fiches;
}
async function lireReels(env, url) {
  reelsServeur ||= lireFichier(env, url, "/fiches/reels.json").catch(e => { reelsServeur = null; throw e; });
  return reelsServeur;
}
const lireJson = (t, defaut) => { try { return JSON.parse(t); } catch (_) { return defaut; } };
const idsCamp = c => [c.chef, ...c.ministres];

// Gouvernement proposé par le joueur : neuf cartes de sa collection, plafond de stature respecté
async function verifierCamp(env, url, joueur, chef, ministres) {
  chef = String(chef || ""); ministres = Array.isArray(ministres) ? ministres.map(String) : [];
  if (![chef, ...ministres].every(id => ID_CARTE.test(id))) throw new Refus(400, "Carte inconnue.");
  const fiches = await fichesServeur(env, url, [chef, ...ministres]);
  if (![chef, ...ministres].every(id => fiches.has(id))) throw new Refus(400, "Carte inconnue.");
  const erreur = Gouvernement.verifierGouvernement(fiches.get(chef), ministres.map(id => fiches.get(id)));
  if (erreur) throw new Refus(400, erreur);
  const ids = [chef, ...ministres];
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM possessions WHERE joueur = ? AND n > 0 AND carte IN (${ids.map(() => "?").join(",")})`).bind(joueur, ...ids).first();
  if (r.n !== ids.length) throw new Refus(409, "Toutes les cartes du gouvernement doivent être dans votre collection.");
  return {chef, ministres};
}
// Postes vacants : cartes du gouvernement sorties de la collection depuis (vente, échange, dissolution)
async function vacants(env, joueur, gouvs) {
  const ids = [...new Set(gouvs.flatMap(g => [g.chef, ...lireJson(g.ministres, [])]))];
  if (!ids.length) return new Set();
  const r = await env.DB.prepare(`SELECT carte FROM possessions WHERE joueur = ? AND n > 0 AND carte IN (SELECT value FROM json_each(?))`).bind(joueur, JSON.stringify(ids)).all();
  const a = new Set(r.results.map(x => x.carte));
  return new Set(ids.filter(id => !a.has(id)));
}
async function listeGouvernements(env, joueur) {
  const [g, j] = await env.DB.batch([
    env.DB.prepare("SELECT id, nom, chef, ministres, maj FROM gouvernements WHERE joueur = ? ORDER BY id").bind(joueur),
    env.DB.prepare("SELECT quotidien, gouv_formes FROM joueurs WHERE id = ?").bind(joueur),
  ]);
  const manquent = await vacants(env, joueur, g.results);
  return json({gouvernements: g.results.map(x => ({id: x.id, nom: x.nom, chef: x.chef, ministres: lireJson(x.ministres, []),
                 vacants: [x.chef, ...lireJson(x.ministres, [])].filter(id => manquent.has(id))})),
               serie: Regles.serieGouv({quotidien: lireJson(j.results[0].quotidien, {})}), prix: prixGouvernement(j.results[0].gouv_formes, g.results.length), max: MAX_GOUVERNEMENTS});
}
// Création (PRIX_GOUVERNEMENT voix) ou recomposition (gratuite) d'un gouvernement enregistré
async function enregistrerGouvernement(env, requete, joueur, url) {
  const c = await lireCorps(requete);
  const nom = String(c.nom || "").normalize("NFC").trim().slice(0, 40) || "Mon gouvernement";
  const camp = await verifierCamp(env, url, joueur, c.chef, c.ministres), date = maintenant();
  if (c.id !== undefined && c.id !== null) {
    const id = entier(c.id, 1, Number.MAX_SAFE_INTEGER);
    const r = await env.DB.prepare("UPDATE gouvernements SET nom = ?, chef = ?, ministres = ?, maj = ? WHERE id = ? AND joueur = ?")
      .bind(nom, camp.chef, JSON.stringify(camp.ministres), date, id, joueur).run();
    if (!r.meta.changes) throw new Refus(404, "Gouvernement introuvable.");
    return json({id});
  }
  const [n, j] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM gouvernements WHERE joueur = ?").bind(joueur),
    env.DB.prepare("SELECT gouv_formes FROM joueurs WHERE id = ?").bind(joueur),
  ]);
  if (n.results[0].n >= MAX_GOUVERNEMENTS) throw new Refus(409, `${MAX_GOUVERNEMENTS} gouvernements au plus : recomposez-en un.`);
  const formes = j.results[0].gouv_formes, prix = prixGouvernement(formes, n.results[0].n);
  // Le compte des gouvernements formés n'avance que s'il n'a pas bougé entre-temps (deux créations simultanées : une seule offerte)
  const [, , ins] = await lot(env, [
    env.DB.prepare("UPDATE joueurs SET points = points - ?, gouv_formes = gouv_formes + 1 WHERE id = ? AND gouv_formes = ?").bind(prix, joueur, formes),
    env.DB.prepare("INSERT INTO garde (ok) SELECT 1 WHERE changes() = 0"),
    env.DB.prepare("INSERT INTO gouvernements (joueur, nom, chef, ministres, cree, maj) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(joueur, nom, camp.chef, JSON.stringify(camp.ministres), date, date),
  ], `Il faut ${prix} voix pour former un gouvernement.`);
  return json({id: ins.results[0].id}, 201);
}
async function supprimerGouvernement(env, joueur, id) {
  await env.DB.prepare("DELETE FROM gouvernements WHERE id = ? AND joueur = ?").bind(id, joueur).run();
  return json({ok: true});
}

function partieDe(d) {
  return {graine: d.graine, annonces: lireJson(d.annonces, []), camps: [lireJson(d.camp_a, null), lireJson(d.camp_b, null)],
          coups: [lireJson(d.coups_a, []), lireJson(d.coups_b, [])]};
}
async function partieAvec(env, joueur, id) {
  const d = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(id).first();
  // Contre un joueur tiré au hasard, le propriétaire du gouvernement affronté n'a pas accès à la partie
  if (!d || (d.a !== joueur && (d.b !== joueur || d.mode !== "ami"))) throw new Refus(404, "Partie introuvable.");
  return d;
}
// Gouvernement de l'ordinateur : un gouvernement réel, au niveau de la série du joueur
async function campOrdinateur(env, url, annonces, niveau) {
  const reels = await lireReels(env, url);
  const possibles = reels.chefs.map((c, i) => [i, c[1]]).filter(([, n]) => n >= Gouvernement.MINISTRES);
  for (let essai = 0; essai < 8 && possibles.length; essai++) {
    const [i] = possibles.splice(Math.floor(aleatoire() * possibles.length), 1)[0];
    const g = await lireFichier(env, url, `/fiches/g${String(i).padStart(2, "0")}.json`);
    const chef = Gouvernement.ficheDe(g.chef[0], g.chef[1]), membres = g.membres.map(([id, f]) => Gouvernement.ficheDe(id, f));
    const camp = Gouvernement.gouvernementOrdinateur([[chef, membres]], annonces, aleatoire, niveau);
    if (camp) return camp;
  }
  throw new Refus(503, "L'ordinateur n'a pas pu former de gouvernement. Réessayez.");
}
// Gouvernement enregistré d'un autre joueur, complet et toujours dans sa collection
async function campFantome(env, joueur) {
  const candidats = (await env.DB.prepare("SELECT * FROM gouvernements WHERE joueur != ? ORDER BY RANDOM() LIMIT 8").bind(joueur).all()).results;
  for (const g of candidats) if (!(await vacants(env, g.joueur, [g])).size) return g;
  return null;
}
// Nouvelle partie : contre l'ordinateur ou un joueur au hasard (une à la fois, reprise si elle existe), ou contre un ami
async function nouvellePartie(env, requete, joueur, url) {
  const c = await lireCorps(requete), mode = ["ordi", "hasard", "ami"].includes(c.mode) ? c.mode : null;
  if (!mode) throw new Refus(400, "Mode de jeu inconnu.");
  const date = maintenant(), graine = crypto.getRandomValues(new Uint32Array(1))[0];
  const annonces = Gouvernement.annoncesDePartie(graine, (await lireReels(env, url)).themes);
  if (mode === "ami") {
    const adversaire = await idJoueur(env, c.vers);
    if (adversaire.id === joueur) throw new Refus(400, "Vous ne pouvez pas vous défier vous-même.");
    const voix = entier(c.voix ?? 0, 0, MISE_VOIX_MAX), paquets = entier(c.paquets ?? 0, 0, MISE_PAQUETS_MAX);
    if (voix === null || paquets === null) throw new Refus(400, `Mise de 0 à ${MISE_VOIX_MAX} voix et de 0 à ${MISE_PAQUETS_MAX} paquets.`);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE a = ? AND mode = 'ami' AND statut IN ('preparation', 'propose', 'en-cours')").bind(joueur).first();
    if (n.n >= MAX_PARTIES_AMIS) throw new Refus(429, `Vous avez déjà ${MAX_PARTIES_AMIS} parties en cours.`);
    const [ins] = await lot(env, [
      env.DB.prepare(`INSERT INTO parties (mode, a, b, graine, annonces, statut, mise_voix, mise_paquets, cree, maj)
        VALUES ('ami', ?, ?, ?, ?, 'preparation', ?, ?, ?, ?) RETURNING id`).bind(joueur, adversaire.id, graine, JSON.stringify(annonces), voix, paquets, date, date),
      env.DB.prepare("UPDATE joueurs SET points = points - ?, offerts = offerts - ? WHERE id = ?").bind(voix, paquets, joueur),
    ], "Vous n'avez pas assez de voix ou de paquets pour cette mise.");
    return json({id: ins.results[0].id}, 201);
  }
  const ouverte = await env.DB.prepare("SELECT id FROM parties WHERE a = ? AND mode IN ('ordi', 'hasard') AND statut IN ('preparation', 'en-cours')").bind(joueur).first();
  if (ouverte) return json({id: ouverte.id, reprise: true});
  const niveau = Regles.serieGouv({quotidien: lireJson((await env.DB.prepare("SELECT quotidien FROM joueurs WHERE id = ?").bind(joueur).first()).quotidien, {})}).serie;
  let fantome = mode === "hasard" ? await campFantome(env, joueur) : null, camp, b = null, modeReel = mode;
  if (fantome) { camp = {chef: fantome.chef, ministres: lireJson(fantome.ministres, []), nom: fantome.nom}; b = fantome.joueur; }
  else { camp = await campOrdinateur(env, url, annonces, niveau); modeReel = "ordi"; }
  const ins = await env.DB.prepare(`INSERT INTO parties (mode, a, b, graine, annonces, camp_b, niveau, fantome, statut, cree, maj)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparation', ?, ?) RETURNING id`)
    .bind(modeReel, joueur, b, graine, JSON.stringify(annonces), JSON.stringify(camp), niveau, fantome ? fantome.id : null, date, date).first();
  return json({id: ins.id, mode: modeReel}, 201);
}
// Choix du gouvernement : le lanceur (avant d'inviter son ami, ou contre l'ordinateur), puis l'ami qui relève le défi
async function choisirGouvernement(env, requete, joueur, id, url) {
  const c = await lireCorps(requete), d = await partieAvec(env, joueur, id), date = maintenant();
  const g = await env.DB.prepare("SELECT * FROM gouvernements WHERE id = ? AND joueur = ?").bind(entier(c.gouvernement, 1, Number.MAX_SAFE_INTEGER), joueur).first();
  if (!g) throw new Refus(404, "Gouvernement introuvable.");
  const camp = {...(await verifierCamp(env, url, joueur, g.chef, lireJson(g.ministres, []))), nom: g.nom};
  if (d.a === joueur && d.statut === "preparation") {
    const statut = d.mode === "ami" ? "propose" : "en-cours";
    const r = await env.DB.prepare("UPDATE parties SET camp_a = ?, statut = ?, maj = ? WHERE id = ? AND statut = 'preparation'").bind(JSON.stringify(camp), statut, date, id).run();
    if (!r.meta.changes) throw new Refus(409, "La partie a changé entre-temps.");
    if (d.mode === "ami") await notifier(env, d.b, `${await pseudoDe(env, joueur)} vous défie au jeu du Gouvernement${texteMise(d)}. Touchez pour voir le défi.`, "buvette", `partie:${id}`);
  } else if (d.b === joueur && d.mode === "ami" && d.statut === "propose") {
    await lot(env, [
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('partie-relevee', ?)").bind(id),
      env.DB.prepare("UPDATE parties SET camp_b = ?, statut = 'en-cours', maj = ? WHERE id = ?").bind(JSON.stringify(camp), date, id),
      env.DB.prepare("UPDATE joueurs SET points = points - ?, offerts = offerts - ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, joueur),
    ], "Vous n'avez pas assez de voix ou de paquets pour relever ce défi.");
    await notifier(env, d.a, `${await pseudoDe(env, joueur)} a relevé votre défi au jeu du Gouvernement : à vous de jouer la première manche.`, "buvette", `partie:${id}`);
  } else throw new Refus(409, "Le gouvernement de cette partie est déjà choisi.");
  return vuePartieServeur(env, joueur, id, url);
}
const texteMise = d => d.mise_voix || d.mise_paquets ? `, mise : ${[d.mise_voix ? d.mise_voix + " voix" : "", d.mise_paquets ? d.mise_paquets + (d.mise_paquets > 1 ? " paquets" : " paquet") : ""].filter(Boolean).join(" et ")}` : "";
// Refuser (l'ami), annuler (le lanceur, avant que l'ami ne relève) : mise rendue ; abandonner une partie en cours : défaite
async function quitterPartie(env, joueur, id, action) {
  const d = await partieAvec(env, joueur, id), date = maintenant();
  if (action === "abandonner") {
    if (d.statut !== "en-cours" && !(d.statut === "preparation" && d.mode !== "ami")) throw new Refus(409, "Cette partie ne se joue pas en ce moment.");
    if (d.statut === "preparation") {
      // Adversaire vu, gouvernement pas encore choisi : la partie compte comme perdue (pas de nouveau tirage gratuit)
      const cat = await lireCatalogue(env, ORIGINE_INTERNE);
      await appliquer(env, joueur, e => Regles.issueSerieGouv(e, cat, "perdu", Regles.jourDuJeu(), aleatoire), [
        env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('partie-finie', ?)").bind(id),
        env.DB.prepare("UPDATE parties SET statut = 'fini', gagnant = ?, maj = ? WHERE id = ?").bind(d.b || -1, date, id)]);
      return json({ok: true});
    }
    return json({resultat: await clorePartie(env, d, {forfait: d.a === joueur ? 1 : 2})});
  }
  if (d.mode !== "ami" || !["preparation", "propose"].includes(d.statut)) throw new Refus(409, "Ce défi n'est plus en attente.");
  if ((action === "annuler") !== (d.a === joueur)) throw new Refus(403, action === "annuler" ? "Seul le lanceur peut annuler ce défi." : "Ce défi ne vous est pas adressé.");
  await lot(env, [
    env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('partie-relevee', ?)").bind(id),
    env.DB.prepare("UPDATE parties SET statut = ?, maj = ? WHERE id = ?").bind(action === "refuser" ? "refuse" : "annule", date, id),
    env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.a),
  ], "Ce défi vient d'être relevé ou clos.");
  if (action === "refuser") await notifier(env, d.a, `${await pseudoDe(env, joueur)} a décliné votre défi au jeu du Gouvernement : votre mise vous est rendue.`, "buvette", `partie:${id}`);
  return json({ok: true});
}
// Un coup : contre l'ordinateur ou un joueur au hasard, l'ordinateur répond aussitôt ; la partie finie est close
async function jouerPartie(env, requete, joueur, id, url) {
  const c = await lireCorps(requete), d = await partieAvec(env, joueur, id);
  if (d.statut !== "en-cours") throw new Refus(409, "Cette partie ne se joue pas en ce moment.");
  const p = partieDe(d), k = d.a === joueur ? 0 : 1, fiches = await fichesServeur(env, url, [...idsCamp(p.camps[0]), ...idsCamp(p.camps[1])]);
  const avant = [d.coups_a, d.coups_b];
  const erreur = Gouvernement.jouerCoup(p, k, entier(c.ministre, 0, Gouvernement.MINISTRES - 1) ?? -1, c.avec493 === true, fiches);
  if (erreur) throw new Refus(409, erreur);
  const solo = d.mode !== "ami";
  if (solo) {
    const r = Gouvernement.choixOrdinateur(p, 1, fiches, aleatoire, d.niveau);
    Gouvernement.jouerCoup(p, 1, r.ministre, r.avec493, fiches);
  }
  const maj = await env.DB.prepare("UPDATE parties SET coups_a = ?, coups_b = ?, maj = ? WHERE id = ? AND coups_a = ? AND coups_b = ? AND statut = 'en-cours'")
    .bind(JSON.stringify(p.coups[0]), JSON.stringify(p.coups[1]), maintenant(), id, avant[0], avant[1]).run();
  if (!maj.meta.changes) throw new Refus(409, "La partie a changé entre-temps. Rechargez.");
  const etat = Gouvernement.resoudre(p, fiches);
  if (etat.fini) await clorePartie(env, {...d, coups_a: JSON.stringify(p.coups[0]), coups_b: JSON.stringify(p.coups[1])}, {fiches});
  else if (!solo && p.coups[1 - k].length < p.coups[k].length && !(await adversairePresent(env, d, 1 - k))) {
    // Notification seulement si l'adversaire n'a pas la partie sous les yeux (en direct, sa page se met à jour seule)
    const sc = k ? [etat.score[0], etat.score[1]] : [etat.score[1], etat.score[0]];
    await notifier(env, k ? d.a : d.b, `Jeu du Gouvernement : ${await pseudoDe(env, joueur)} a joué la manche ${p.coups[k].length}. À vous de jouer ! (score : vous ${sc[0]}, ${await pseudoDe(env, joueur)} ${sc[1]})`, "buvette", `partie:${id}`);
  }
  return vuePartieServeur(env, joueur, id, url);
}
// Clôture : une fois (clôture « partie-finie ») ; série et gains contre l'ordinateur ou un joueur au hasard, mises entre amis.
// `forfait` : camp (1 ou 2) qui abandonne ; `expire` : délai passé, la manche jouée d'un seul côté lui revient
async function clorePartie(env, d, {fiches = null, forfait = 0, expire = false} = {}) {
  const p = partieDe(d);
  const gagnant = forfait ? (forfait === 1 ? 2 : 1) : Gouvernement.resoudre(p, fiches, {expire}).gagnant;
  const gagnantId = gagnant === 1 ? d.a : gagnant === 2 ? (d.b || -1) : 0, date = maintenant();
  const cloture = [
    env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('partie-finie', ?)").bind(d.id),
    env.DB.prepare("UPDATE parties SET statut = 'fini', gagnant = ?, maj = ? WHERE id = ?").bind(gagnantId, date, d.id),
  ];
  let serie = null;
  try {
    if (d.mode === "ami") {
      const credit = (id, fois) => env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix * fois, d.mise_paquets * fois, id);
      await lot(env, [...cloture, ...(gagnant ? [credit(gagnantId, 2)] : [credit(d.a, 1), credit(d.b, 1)])]);
    } else {
      // Série du joueur (règles : issueSerieGouv), écrite dans le même lot que la clôture de la partie
      const issue = gagnant === 1 ? "gagne" : gagnant === 2 ? "perdu" : "egalite", cat = await lireCatalogue(env, ORIGINE_INTERNE);
      serie = await appliquer(env, d.a, e => Regles.issueSerieGouv(e, cat, issue, Regles.jourDuJeu(), aleatoire), cloture);
    }
  } catch (e) { if (e instanceof Refus && e.statut === 409) return null; throw e; }
  // Pas de notification au propriétaire du gouvernement affronté, quelle que soit l'issue (demande de l'utilisateur,
  // octobre 2026 : trop de notifications)
  return {gagnant, serie};
}
// Ce que voit le joueur : la partie (règles : vuePartie), le mode, l'adversaire, la mise ; avant le choix du gouvernement,
// les thèmes annoncés et le gouvernement adverse s'il est connu
// Présence : un camp « regarde » la partie s'il l'a consultée il y a moins de PRESENCE_MS (la page ouverte la relit toutes
// les quelques secondes) ; noté au plus toutes les 5 s pour ne pas écrire à chaque relecture
const PRESENCE_MS = 15000;
async function adversairePresent(env, d, camp) {
  const r = await env.DB.prepare(`SELECT ${camp ? "vu_b" : "vu_a"} AS vu FROM parties WHERE id = ?`).bind(d.id).first();
  return !!r && r.vu > Date.now() - PRESENCE_MS;
}
async function vuePartieServeur(env, joueur, id, url) {
  const d0 = await partieAvec(env, joueur, id), k = d0.a === joueur ? 0 : 1, maintenantMs = Date.now();
  if (d0.mode === "ami" && !["fini", "refuse", "annule", "expire"].includes(d0.statut))
    await env.DB.prepare(`UPDATE parties SET ${k ? "vu_b" : "vu_a"} = ? WHERE id = ? AND ${k ? "vu_b" : "vu_a"} < ?`).bind(maintenantMs, id, maintenantMs - 5000).run();
  const d = d0, p = partieDe(d);
  const autreId = k ? d.a : d.b, autre = autreId > 0 ? await pseudoDe(env, autreId) : null;
  const base = {id: d.id, mode: d.mode, statut: d.statut, adversaire: d.mode === "ordi" ? null : autre, lance: k === 0,
    voix: d.mise_voix, paquets: d.mise_paquets, niveau: d.niveau, annonces: p.annonces,
    issue: d.gagnant === null ? null : d.gagnant === 0 ? "egalite" : d.gagnant === joueur ? "gagne" : "perdu",
    echeance: new Date(Date.parse(d.maj) + (d.statut === "preparation" && d.mode !== "ami" ? DUREE_PREPARATION : DUREE_PARTIE)).toISOString(),
    enDirect: d.mode === "ami" && (k ? d.vu_a : d.vu_b) > maintenantMs - PRESENCE_MS};
  if (!p.camps[0] || !p.camps[1]) return json({...base, moi: p.camps[k], lui: p.camps[1 - k]});
  const fiches = await fichesServeur(env, url, [...idsCamp(p.camps[0]), ...idsCamp(p.camps[1])]);
  // Partie close (délai, abandon) : la manche jouée d'un seul côté compte comme à la clôture
  const vue = Gouvernement.vuePartie(p, k, fiches, {expire: d.statut === "fini"});
  // Partie close par abandon ou délai : l'issue enregistrée prime sur le décompte des manches
  return json({...base, ...vue, issue: base.issue ?? vue.issue, fini: d.statut === "fini" || vue.fini});
}
async function listeParties(env, joueur) {
  const r = await env.DB.prepare(`SELECT p.id, p.mode, p.a, p.b, p.statut, p.gagnant, p.mise_voix, p.mise_paquets, p.coups_a, p.coups_b, p.camp_a, p.camp_b, p.maj,
      ja.pseudo AS pseudo_a, jb.pseudo AS pseudo_b FROM parties p JOIN joueurs ja ON ja.id = p.a LEFT JOIN joueurs jb ON jb.id = p.b
    WHERE (p.a = ?1 OR (p.b = ?1 AND p.mode = 'ami')) AND p.statut NOT IN ('annule') ORDER BY p.id DESC LIMIT 30`).bind(joueur).all();
  return json({parties: r.results.map(d => {
    const k = d.a === joueur ? 0 : 1, coups = [lireJson(d.coups_a, []), lireJson(d.coups_b, [])];
    const aJouer = d.statut === "en-cours" && coups[k].length <= coups[1 - k].length;
    return {id: d.id, mode: d.mode, statut: d.statut, lance: k === 0, adversaire: d.mode === "ordi" ? null : (k ? d.pseudo_a : d.pseudo_b),
      voix: d.mise_voix, paquets: d.mise_paquets, aJouer, aRelever: d.statut === "propose" && k === 1, aPreparer: d.statut === "preparation" && k === 0,
      nomAdverse: (lireJson(k ? d.camp_a : d.camp_b, null) || {}).nom || null,
      issue: d.gagnant === null ? null : d.gagnant === 0 ? "egalite" : d.gagnant === joueur ? "gagne" : "perdu", maj: d.maj};
  })});
}
// Tâche horaire : préparations oubliées annulées (mise rendue entre amis), parties en cours closes au délai
async function expirerParties(env) {
  const limite = new Date(Date.now() - DUREE_PARTIE).toISOString(), limitePrep = new Date(Date.now() - DUREE_PREPARATION).toISOString();
  const oubliees = (await env.DB.prepare(`SELECT * FROM parties WHERE (statut IN ('preparation', 'propose') AND mode = 'ami' AND maj < ?1)
    OR (statut = 'preparation' AND mode != 'ami' AND maj < ?2)`).bind(limite, limitePrep).all()).results;
  for (const d of oubliees) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO clotures (nature, id) VALUES ('partie-relevee', ?)").bind(d.id),
      env.DB.prepare("UPDATE parties SET statut = 'expire', maj = ? WHERE id = ?").bind(maintenant(), d.id),
      env.DB.prepare("UPDATE joueurs SET points = points + ?, offerts = offerts + ? WHERE id = ?").bind(d.mise_voix, d.mise_paquets, d.a),
    ]).catch(e => { if (!contrainte(e)) throw e; });
  }
  const enCours = (await env.DB.prepare("SELECT * FROM parties WHERE statut = 'en-cours' AND maj < ?").bind(limite).all()).results;
  for (const d of enCours) {
    const p = partieDe(d), fiches = await fichesServeur(env, ORIGINE_INTERNE, [...idsCamp(p.camps[0]), ...idsCamp(p.camps[1])]);
    await clorePartie(env, d, {fiches, expire: true});
  }
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
  if (methode === "POST" && chemin === "/api/contact") return contact(env, requete, joueur);
  let p;
  if (methode === "GET" && (p = chemin.match(/^\/api\/profil\/([^/]+)$/))) return profil(env, decodeURIComponent(p[1]));
  if (methode === "GET" && chemin === "/api/moi") return json(joueur ? {connecte: true, ...(await chargerEtat(env, joueur))} : {connecte: false});
  if (methode === "GET" && chemin === "/api/detenteurs") return detenteurs(env, url);
  if (!joueur) throw new Refus(401, "Connectez-vous pour continuer.");
  const avecEtat = async resultat => json({resultat, ...(env.etatEcrit || await chargerEtat(env, joueur))});
  if (methode === "POST" && chemin === "/api/paquet") {
    const cat = await catalogueDuJeu();
    const r = await appliquer(env, joueur, e => Regles.ouvrirPaquet(e, cat, {maintenant: Date.now(), aleatoire}));
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
  // Journée : premier passage du jour (compte du thème recherché), série de connexion, lot à choisir, objectifs du jour
  if (methode === "POST" && chemin === "/api/jour") {
    const cat = await catalogueDuJeu();
    return avecEtat(await appliquer(env, joueur, e => Regles.preparerJour(e, cat, Regles.jourDuJeu())));
  }
  if (methode === "POST" && chemin === "/api/serie") {
    const cat = await catalogueDuJeu();
    const gain = await appliquer(env, joueur, e => Regles.reclamerSerie(e, cat, Regles.jourDuJeu(), aleatoire));
    if (!gain) throw new Refus(409, "Le lot du jour est déjà reçu, ou une carte reste à choisir.");
    return avecEtat(gain);
  }
  if (methode === "POST" && chemin === "/api/lot") {
    const c = await lireCorps(requete), cat = await catalogueDuJeu();
    const r = await appliquer(env, joueur, e => Regles.choisirLot(e, cat, String(c.carte || "")));
    if (!r) throw new Refus(409, "Cette carte ne fait pas partie du lot à choisir.");
    return avecEtat(r);
  }
  if (methode === "POST" && chemin === "/api/objectif-du-jour") {
    const c = await lireCorps(requete), cat = await catalogueDuJeu();
    const gain = await appliquer(env, joueur, e => Regles.reclamerJour(e, cat, Regles.jourDuJeu(), String(c.cle || "")));
    if (!gain) throw new Refus(409, "Cet objectif n'est pas encore atteint, ou déjà reçu.");
    return avecEtat(gain);
  }
  if (methode === "POST" && chemin === "/api/quiz") {
    const c = await lireCorps(requete);
    const bonnes = entier(c.bonnes, 0, Regles.QUIZ_QUESTIONS);
    if (bonnes === null) throw new Refus(400, "Résultat illisible.");
    const voix = await appliquer(env, joueur, e => Regles.validerQuiz(e, Regles.jourDuJeu(), bonnes));
    return avecEtat(voix);
  }
  if (methode === "GET" && chemin === "/api/duels") return listeDuels(env, joueur);
  if (methode === "GET" && chemin === "/api/attente") return attente(env, joueur);
  if (methode === "GET" && chemin === "/api/notifications/cle") return json({cle: (await vapid(env, url.origin)).publique});
  if (methode === "POST" && chemin === "/api/notifications/abonner") return abonner(env, requete, joueur, url.origin);
  if (methode === "POST" && chemin === "/api/notifications/desabonner") {
    await env.DB.prepare("DELETE FROM abonnements WHERE endpoint = ? AND joueur = ?").bind(String((await lireCorps(requete)).endpoint || ""), joueur).run();
    return json({ok: true});
  }
  if (methode === "GET" && chemin === "/api/notifications") return lireNotifications(env, joueur);
  if (methode === "POST" && chemin === "/api/dissoudre") {
    const c = await lireCorps(requete);
    const cat = await catalogueDuJeu();
    // Sélection de l'hémicycle : plusieurs cartes en une opération
    if (Array.isArray(c.cartes)) return avecEtat(await appliquer(env, joueur, e => Regles.dissoudreSelection(e, cat, c.cartes.slice(0, Regles.MAX_SELECTION).map(String), c.garder !== false)));
    return avecEtat(await appliquer(env, joueur, e => Regles.dissoudre(e, cat, String(c.carte || ""), c.tout === true)));
  }
  if (methode === "POST" && chemin === "/api/favori") return changerFavori(env, requete, joueur, await catalogueDuJeu());
  if (methode === "GET" && chemin === "/api/alertes") return listeAlertes(env, joueur);
  if (methode === "POST" && chemin === "/api/gardes") return changerGardes(env, requete, joueur, await catalogueDuJeu());
  if (methode === "POST" && chemin === "/api/alertes") return changerAlerte(env, requete, joueur, await catalogueDuJeu());
  if (methode === "GET" && chemin === "/api/amis") return listeAmis(env, joueur);
  if (methode === "GET" && chemin === "/api/amis/carte") return amisAvecCarte(env, url, joueur);
  if (methode === "GET" && chemin === "/api/prix") return prixComptoir(env, url, await catalogueDuJeu());
  if (methode === "POST" && chemin === "/api/vitrine") return changerVitrine(env, requete, joueur);
  if (methode === "POST" && chemin === "/api/supprimer-compte") return supprimerCompte(env, requete, joueur);
  if (methode === "POST" && chemin === "/api/mot-de-passe") return changerMotDePasse(env, requete, joueur);
  if (methode === "POST" && chemin === "/api/code") return utiliserCode(env, requete, joueur, await catalogueDuJeu());
  if (methode === "POST" && chemin === "/api/duels") return lancerDuel(env, requete, joueur);
  if (methode === "GET" && chemin === "/api/gouvernements") return listeGouvernements(env, joueur);
  if (methode === "POST" && chemin === "/api/gouvernements") return enregistrerGouvernement(env, requete, joueur, url);
  if (methode === "GET" && chemin === "/api/parties") return listeParties(env, joueur);
  // Série : encaisser la récompense du palier atteint, puis choisir la carte proposée
  if (methode === "POST" && chemin === "/api/gouvernements/encaisser") {
    const cat = await catalogueDuJeu();
    const gain = await appliquer(env, joueur, e => Regles.encaisserSerieGouv(e, cat, Regles.jourDuJeu(), aleatoire));
    if (!gain) throw new Refus(409, "Rien à encaisser.");
    return avecEtat(gain);
  }
  if (methode === "POST" && chemin === "/api/gouvernements/lot") {
    const c = await lireCorps(requete), cat = await catalogueDuJeu();
    const r = await appliquer(env, joueur, e => Regles.choisirLotGouv(e, cat, String(c.carte || "")));
    if (!r) throw new Refus(409, "Cette carte ne fait pas partie des cartes proposées.");
    return avecEtat(r);
  }
  if (methode === "POST" && chemin === "/api/parties") return nouvellePartie(env, requete, joueur, url);
  let m;
  if (methode === "POST" && (m = chemin.match(/^\/api\/gouvernements\/(\d+)\/supprimer$/))) return supprimerGouvernement(env, joueur, Number(m[1]));
  if (methode === "GET" && (m = chemin.match(/^\/api\/parties\/(\d+)$/))) return vuePartieServeur(env, joueur, Number(m[1]), url);
  if (methode === "POST" && (m = chemin.match(/^\/api\/parties\/(\d+)\/gouvernement$/))) return choisirGouvernement(env, requete, joueur, Number(m[1]), url);
  if (methode === "POST" && (m = chemin.match(/^\/api\/parties\/(\d+)\/coup$/))) return jouerPartie(env, requete, joueur, Number(m[1]), url);
  if (methode === "POST" && (m = chemin.match(/^\/api\/parties\/(\d+)\/(refuser|annuler|abandonner)$/))) return quitterPartie(env, joueur, Number(m[1]), m[2]);
  if (methode === "POST" && (m = chemin.match(/^\/api\/amis\/(demander|accepter|retirer)$/))) return actionAmi(env, requete, joueur, m[1]);
  if (methode === "GET" && (m = chemin.match(/^\/api\/duels\/(\d+)\/questions$/))) return questionsDuel(env, joueur, Number(m[1]), url);
  if (methode === "POST" && (m = chemin.match(/^\/api\/duels\/(\d+)\/reponse$/))) return repondreDuel(env, requete, joueur, Number(m[1]), url);
  if (methode === "POST" && (m = chemin.match(/^\/api\/duels\/(\d+)\/(relever|refuser|annuler)$/))) return repondreDefi(env, joueur, Number(m[1]), m[2]);
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
  if (methode === "POST" && (m = chemin.match(/^\/api\/annonces\/(\d+)\/offre$/))) return faireOffre(env, requete, joueur, Number(m[1]));
  if (methode === "POST" && (m = chemin.match(/^\/api\/offres\/(\d+)\/(accepter|refuser|annuler)$/))) return cloreOffre(env, joueur, Number(m[1]), m[2]);
  throw new Refus(404, "Adresse inconnue.");
}

// Mesure des lignes lues en base (D1 facture les lignes lues), seulement en local : wrangler dev --var
// MESURE_LECTURES:1 ; le total de la requête est renvoyé dans l'en-tête x-lignes-lues
function compterLectures(db, total) {
  const lues = r => { total.n += (r && r.meta && r.meta.rows_read) || 0; return r; };
  const enrober = brut => new Proxy(brut, {get(t, k) {
    if (k === "brut") return t;
    if (k === "bind") return (...a) => enrober(t.bind(...a));
    if (k === "all" || k === "run") return async () => lues(await t[k]());
    if (k === "first") return async col => { const r = lues(await t.all()), ligne = r.results[0]; return ligne ? (col ? ligne[col] : ligne) : null; };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  }});
  return {prepare: sql => enrober(db.prepare(sql)), batch: async l => (await db.batch(l.map(x => x.brut || x))).map(lues)};
}
export default {
  async fetch(requete, env, ctx) {
    const url = new URL(requete.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(requete);
    // Version du déploiement dans chaque réponse de l'API : une page ouverte avant un déploiement se recharge
    // (index.html, versionNouvelle) au lieu de faire tourner l'ancien code face au nouveau serveur
    const version = env.CF_VERSION_METADATA?.id || "locale";
    const r = url.pathname === "/api/version" ? json({version}) : await repondre(requete, env, ctx, url);
    const copie = new Response(r.body, r); copie.headers.set("x-version", version); return copie;
  },
  async scheduled(evenement, env, ctx) {
    const e = Object.assign(Object.create(env), {ctx});
    ctx.waitUntil(surveillerReserves(e).then(() => expirerDuels(e)).then(() => expirerParties(e)).then(() => annoncerGouvernement(e)));
  },
};
async function repondre(requete, env, ctx, url) {
  if (env.MESURE_LECTURES) {
    const total = {n: 0}, monde = Object.assign(Object.create(env), {ctx, DB: compterLectures(env.DB, total)});
    const r = await api(requete, monde, url).catch(e => e instanceof Refus ? json({erreur: e.message}, e.statut) : Promise.reject(e));
    const copie = new Response(r.body, r); copie.headers.set("x-lignes-lues", String(total.n)); return copie;
  }
  // Le contexte suit l'environnement, pour les envois en arrière-plan (notifications)
  try { return await api(requete, Object.assign(Object.create(env), {ctx}), url); }
  catch (e) {
    if (e instanceof Refus) return json({erreur: e.message}, e.statut);
    console.error(e);
    return json({erreur: "Le serveur a rencontré une erreur. Réessayez dans un instant."}, 500);
  }
}
