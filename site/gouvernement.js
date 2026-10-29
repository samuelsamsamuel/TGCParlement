// Jeu du Gouvernement : règles, sans interface ni stockage (comme regles.js), exécutées aussi sous Node par le serveur
// et par la simulation de réglage (scripts/simulation_gouvernement.js). Conception décidée avec l'utilisateur (octobre
// 2026, CLAUDE.md) : un chef et huit ministres, dix thèmes annoncés, sept tirés, premier à quatre manches ; force d'un
// ministre sur un thème = stature + ETOILE (2) par étoile de spécialité + liens (plafonnés) ; 49.3 une fois (stature du
// chef ajoutée) ; égalité départagée par la stature puis les années de mandat.
// Fiches : site/gouvernement.json, écrit par scripts/fiches_gouvernement.py.
(function (racine, fabrique) {
  const Gouvernement = fabrique();
  if (typeof module === "object" && module.exports) module.exports = Gouvernement;
  else racine.Gouvernement = Gouvernement;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const ETOILE = 2, PLAFOND_STATURE = 24, LIENS_MAX = 3, MINISTRES = 8, ANNONCES = 10, MANCHES = 7, VICTOIRE = 4;

  // Fiches compactes -> objets ; fiche : [stature, étoiles (thème × 4 + nombre), années, groupe, départements,
  // périodes de fonction gouvernementale, périodes à la tête du Gouvernement]
  function ficheDe(id, f) {
    const etoiles = new Map();
    for (const e of f[1]) etoiles.set(e >> 2, e & 3);
    return {id: String(id), stature: f[0], etoiles, annees: f[2], groupe: f[3], deps: f[4], gouv: f[5] || [], chefs: f[6] || []};
  }
  function fichesDeJeu(data) {
    const fiches = new Map();
    for (const [id, f] of Object.entries(data.fiches)) fiches.set(id, ficheDe(id, f));
    return {themes: data.themes, fiches};
  }
  // Paquet des fiches du serveur (site/fiches/pNNN.json) : empreinte FNV-1a de l'identifiant, modulo PAQUETS_FICHES
  const PAQUETS_FICHES = 256;
  function paquetDeFiche(id) {
    let h = 2166136261;
    for (const ch of String(id)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % PAQUETS_FICHES;
  }

  function chevauche(a, b) {
    for (const [d1, f1] of a) for (const [d2, f2] of b) if (d1 <= (f2 || "9999") && d2 <= (f1 || "9999")) return true;
    return false;
  }

  // Liens de chaque ministre (+1 chacun, LIENS_MAX au plus) : même département qu'un autre membre, même groupe que le
  // chef, a siégé dans un même gouvernement réel qu'un autre membre, a servi sous le chef
  function liens(chef, ministres) {
    const membres = [chef, ...ministres];
    return ministres.map(m => {
      const autres = membres.filter(x => x !== m);
      const detail = {
        departement: autres.some(x => x.deps.some(d => m.deps.includes(d))),
        groupe: m.groupe >= 0 && m.groupe === chef.groupe,
        solidarite: m.gouv.length > 0 && autres.some(x => chevauche(m.gouv, x.gouv)),
        sousLeChef: m.gouv.length > 0 && chef.chefs.length > 0 && chevauche(m.gouv, chef.chefs),
      };
      return {detail, total: Math.min(api.LIENS_MAX, Object.values(detail).filter(Boolean).length)};
    });
  }

  function force(ministre, theme, bonus) { return ministre.stature + api.ETOILE * (ministre.etoiles.get(theme) || 0) + bonus; }

  function verifierGouvernement(chef, ministres) {
    if (ministres.length !== MINISTRES) return "Il faut " + MINISTRES + " ministres.";
    const ids = new Set([chef.id, ...ministres.map(m => m.id)]);
    if (ids.size !== MINISTRES + 1) return "Une carte ne peut servir qu'une fois.";
    const total = ministres.reduce((s, m) => s + m.stature, 0);
    if (total > api.PLAFOND_STATURE) return "Stature totale de " + total + " : " + api.PLAFOND_STATURE + " au plus.";
    return null;
  }

  // Une manche : chaque camp {ministre, bonus, chef (si 49.3)} -> 1, 2 ou 0 (égalité complète) et les forces
  function jugerManche(theme, a, b) {
    const fa = force(a.ministre, theme, a.bonus) + (a.chef ? a.chef.stature : 0);
    const fb = force(b.ministre, theme, b.bonus) + (b.chef ? b.chef.stature : 0);
    let gagnant = fa > fb ? 1 : fb > fa ? 2 : 0, departage = null;
    if (!gagnant) {
      departage = "stature";
      gagnant = a.ministre.stature > b.ministre.stature ? 1 : b.ministre.stature > a.ministre.stature ? 2 : 0;
      if (!gagnant) {
        departage = "annees";
        gagnant = a.ministre.annees > b.ministre.annees ? 1 : b.ministre.annees > a.ministre.annees ? 2 : 0;
      }
    }
    return {gagnant, fa, fb, departage};
  }

  /* ---------- Partie ---------- */
  // Une partie, gardée par le serveur : {graine, annonces (10 thèmes), camps: [{chef, ministres: [8 identifiants]} × 2],
  // coups: [[[ministre, 49.3 (0 ou 1)], …] × 2]}. Les sept thèmes tirés sortent de la graine, un par manche : le joueur ne
  // connaît le thème d'une manche qu'une fois la précédente jouée des deux côtés. Un camp joue la manche k quand il en a
  // joué k et que les k précédentes sont réglées ; un ministre et le 49.3 ne servent qu'une fois.
  function hasard(graine) {  // mulberry32, comme regles.js
    let a = graine >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function melanger(l, alea) { l = l.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(alea() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; }
  function annoncesDePartie(graine, nbThemes) {
    return melanger([...Array(nbThemes).keys()], hasard(graine)).slice(0, ANNONCES).sort((a, b) => a - b);
  }
  function tirage(p) { return melanger(p.annonces, hasard(p.graine ^ 0x5bd1e995)).slice(0, MANCHES); }
  function campDe(p, k, fiches) {
    const c = p.camps[k], chef = fiches.get(String(c.chef)), ministres = c.ministres.map(id => fiches.get(String(id)));
    return {chef, ministres, bonus: liens(chef, ministres).map(l => l.total)};
  }
  // État d'une partie : manches réglées, score, manche en cours, fin ; `expire` donne la manche à qui seul l'a jouée
  function resoudre(p, fiches, {expire = false} = {}) {
    const ordre = tirage(p), camps = [0, 1].map(k => campDe(p, k, fiches));
    const manches = [], score = [0, 0];
    let k = 0;
    for (; k < MANCHES && Math.max(...score) < VICTOIRE; k++) {
      const [a, b] = [p.coups[0][k], p.coups[1][k]];
      if (!a || !b) {
        if (expire && (a || b)) { score[a ? 0 : 1]++; manches.push({theme: ordre[k], coups: [a || null, b || null], gagnant: a ? 1 : 2, forfait: true}); k++; }
        break;
      }
      const r = jugerManche(ordre[k], {ministre: camps[0].ministres[a[0]], bonus: camps[0].bonus[a[0]], chef: a[1] ? camps[0].chef : null},
                                       {ministre: camps[1].ministres[b[0]], bonus: camps[1].bonus[b[0]], chef: b[1] ? camps[1].chef : null});
      if (r.gagnant) score[r.gagnant - 1]++;
      manches.push({theme: ordre[k], coups: [a, b], forces: [r.fa, r.fb], gagnant: r.gagnant, departage: r.departage});
    }
    const fini = expire || Math.max(...score) >= VICTOIRE || manches.length === MANCHES;
    return {manches, score, fini, gagnant: !fini ? null : score[0] > score[1] ? 1 : score[1] > score[0] ? 2 : 0,
            theme: fini ? null : ordre[manches.length], camps};
  }
  function jouerCoup(p, k, ministre, avec493, fiches) {
    const etat = resoudre(p, fiches), mes = p.coups[k];
    if (etat.fini) return "La partie est terminée.";
    if (mes.length !== etat.manches.length) return "Attendez le coup de votre adversaire.";
    if (!Number.isInteger(ministre) || ministre < 0 || ministre >= MINISTRES) return "Ministre inconnu.";
    if (mes.some(c => c[0] === ministre)) return "Ce ministre a déjà siégé.";
    if (avec493 && mes.some(c => c[1])) return "Le 49.3 a déjà servi.";
    mes.push([ministre, avec493 ? 1 : 0]);
    return null;
  }
  // Ce qu'un camp voit : les deux gouvernements, les manches réglées, le thème en cours, son coup en attente
  function vuePartie(p, k, fiches, options = {}) {
    const e = resoudre(p, fiches, options), autre = 1 - k;
    return {annonces: p.annonces, moi: p.camps[k], lui: p.camps[autre], score: [e.score[k], e.score[autre]], fini: e.fini,
      issue: e.fini ? (e.gagnant === 0 ? "egalite" : e.gagnant === k + 1 ? "gagne" : "perdu") : null,
      manches: e.manches.map(m => ({theme: m.theme, moi: m.coups[k], lui: m.coups[autre], forces: m.forces ? [m.forces[k], m.forces[autre]] : null,
                                    gagne: m.gagnant === 0 ? null : m.gagnant === k + 1, departage: m.departage || null, forfait: !!m.forfait})),
      theme: e.theme, attente: !e.fini && p.coups[k].length > e.manches.length ? p.coups[k][e.manches.length] : null,
      bonus: [e.camps[k].bonus, e.camps[autre].bonus], a493: [p.coups[k].some(c => c[1]), p.coups[autre].some(c => c[1])]};
  }

  /* ---------- Ordinateur ---------- */
  // Choix d'un ministre : gagner au moindre coût (garder les ministres utiles aux thèmes encore possibles), sacrifier le
  // moins utile quand la manche est perdue d'avance, 49.3 quand il fait basculer la manche ; une part d'imprévu
  // Niveau de 0 à 5 (palier de la série du joueur) : plus il est bas, plus l'ordinateur laisse de place à l'imprévu
  const imprevu = niveau => 0.6 - 0.07 * niveau;
  function choixOrdinateur(p, k, fiches, alea, niveau = 5) {
    const e = resoudre(p, fiches), theme = e.theme, moi = e.camps[k], lui = e.camps[1 - k];
    const pris = c => new Set(c.map(x => x[0]));
    const mesPris = pris(p.coups[k]), sesPris = pris(p.coups[1 - k].slice(0, e.manches.length));
    const joues = new Set(e.manches.map(m => m.theme).concat(theme));
    const restants = p.annonces.filter(t => !joues.has(t));
    const sesDispo = lui.ministres.map((_, i) => i).filter(i => !sesPris.has(i));
    const meilleurAdverse = Math.max(...sesDispo.map(i => force(lui.ministres[i], theme, lui.bonus[i])));
    const options = moi.ministres.map((m, i) => ({i, f: force(m, theme, moi.bonus[i]),
      u: Math.max(0, ...restants.map(t => force(m, t, moi.bonus[i])))})).filter(o => !mesPris.has(o.i));
    const a493 = p.coups[k].some(c => c[1]);
    const parCout = l => l.slice().sort((a, b) => a.u - b.u || a.f - b.f);
    let choix = parCout(options.filter(o => o.f > meilleurAdverse))[0], avec493 = false;
    if (!choix) {
      const proches = a493 ? [] : parCout(options.filter(o => o.f + moi.chef.stature > meilleurAdverse));
      if (proches.length) { choix = proches[0]; avec493 = true; } else choix = parCout(options)[0];
    }
    if (alea() < imprevu(niveau)) choix = options[Math.floor(alea() * options.length)];
    return {ministre: choix.i, avec493};
  }
  // Valeur d'un gouvernement pour des thèmes : affectation gloutonne des ministres aux thèmes (forces décroissantes)
  function valeur(chef, ministres, annonces) {
    const bonus = liens(chef, ministres).map(l => l.total), paires = [];
    ministres.forEach((m, i) => annonces.forEach(t => paires.push([force(m, t, bonus[i]), i, t])));
    paires.sort((a, b) => b[0] - a[0]);
    const pris = new Set(), faits = new Set(); let total = 0;
    for (const [f, i, t] of paires) if (!pris.has(i) && !faits.has(t)) { pris.add(i); faits.add(t); total += f; }
    return total;
  }
  // Composition pour des thèmes : ministres ajoutés un à un (meilleur gain, la stature consommant le plafond)
  function composer(chef, candidats, annonces) {
    const ministres = []; let reste = api.PLAFOND_STATURE;
    while (ministres.length < MINISTRES) {
      const places = MINISTRES - ministres.length - 1, base = ministres.length ? valeur(chef, ministres, annonces) : 0;
      const tri = candidats.filter(c => c !== chef && !ministres.includes(c) && c.stature <= reste - places)
        .map(c => [Math.max(...annonces.map(t => force(c, t, 0))), c]).sort((a, b) => b[0] - a[0]).slice(0, 40);
      let choix = null, v = -Infinity;
      for (const [, c] of tri) {
        const gain = valeur(chef, [...ministres, c], annonces) - base - 0.3 * c.stature;
        if (gain > v) { v = gain; choix = c; }
      }
      if (!choix) return null;
      ministres.push(choix); reste -= choix.stature;
    }
    return ministres;
  }
  // Gouvernements réels : chaque chef du Gouvernement et les membres de gouvernement qui ont servi sous lui (périodes qui
  // se chevauchent) ; le serveur les lit tout faits (site/fiches/, scripts/fiches_gouvernement.py)
  function gouvernementsReels(fiches) {
    const toutes = [...fiches.values()], gouv = toutes.filter(f => f.gouv.length);
    return toutes.filter(f => f.chefs.length).map(chef => [chef, gouv.filter(m => m !== chef && chevauche(m.gouv, chef.chefs))]);
  }
  // Composition rapide (calcul borné pour le serveur) : chaque candidat noté sur sa meilleure force parmi les thèmes,
  // moins ce que sa stature consomme du plafond, puis retenu dans l'ordre tant que le plafond le permet
  // Prise dans l'ordre d'une liste, en ne gardant un candidat que si les places restantes peuvent encore être pourvues
  // dans le plafond par les plus petites statures non prises
  function prendreDansPlafond(ordre, places = MINISTRES, plafond = api.PLAFOND_STATURE) {
    const ministres = [], pris = new Set(); let reste = plafond;
    const plusPetites = (n, sauf) => ordre.filter(c => !pris.has(c) && c !== sauf).map(c => c.stature).sort((a, b) => a - b).slice(0, n)
      .reduce((t, x) => t + x, 0);
    for (const c of ordre) {
      if (ministres.length === places) break;
      if (c.stature + plusPetites(places - ministres.length - 1, c) <= reste) { ministres.push(c); pris.add(c); reste -= c.stature; }
    }
    return ministres.length === places ? ministres : null;
  }
  // `places` et `plafond` : pour compléter un gouvernement déjà en partie formé
  function composerVite(chef, candidats, annonces, places = MINISTRES, plafond = api.PLAFOND_STATURE) {
    return prendreDansPlafond(candidats.filter(c => c !== chef)
      .map(c => [Math.max(...annonces.map(t => force(c, t, 0))) - 0.3 * c.stature, c]).sort((a, b) => b[0] - a[0]).map(x => x[1]), places, plafond);
  }
  // Gouvernement de l'ordinateur : un chef du Gouvernement réel et huit de ses ministres, choisis pour les thèmes à partir
  // du niveau 3, au hasard (dans le plafond) en dessous ; `reels` : [[chef, membres]] (gouvernementsReels)
  function auHasardDansPlafond(membres, alea) { return prendreDansPlafond(melanger(membres, alea)); }
  function gouvernementOrdinateur(reels, annonces, alea, niveau = 5) {
    for (const [chef, membres] of melanger(reels.filter(([, m]) => m.length >= MINISTRES), alea)) {
      // composé parmi une part de ses ministres tirée au hasard : un cinquième au niveau 3, un tiers au 4, la moitié au 5
      const part = {3: 0.2, 4: 0.35, 5: 0.5}[Math.min(5, niveau)] || 0;
      const vivier = melanger(membres, alea).slice(0, Math.max(MINISTRES, Math.ceil(membres.length * part)));
      const ministres = niveau >= 3 ? composerVite(chef, vivier, annonces) || composerVite(chef, membres, annonces) : auHasardDansPlafond(membres, alea);
      if (ministres) return {chef: chef.id, ministres: ministres.map(m => m.id)};
    }
    return null;
  }

  /* ---------- Série (contre l'ordinateur ou un joueur au hasard) ---------- */
  // Une victoire fait monter d'un palier (5 au plus) et paie le gain du palier atteint ; une défaite ramène à 0 ; un nul
  // ne change rien. Au palier 5, chaque victoire rapporte un paquet tant que la série tient.
  const GAINS_SERIE = [{voix: 5}, {voix: 10}, {voix: 15}, {voix: 20}, {paquets: 1}];
  function progresserSerie(serie, issue) {
    if (issue === "perdu") return {serie: 0, gain: null};
    if (issue !== "gagne") return {serie, gain: null};
    const s = Math.min(GAINS_SERIE.length, serie + 1);
    return {serie: s, gain: GAINS_SERIE[s - 1]};
  }

  // Réglages lus à l'appel (la simulation les fait varier)
  const api = {ETOILE, PLAFOND_STATURE, LIENS_MAX, MINISTRES, ANNONCES, MANCHES, VICTOIRE, GAINS_SERIE, fichesDeJeu, liens, force,
               verifierGouvernement, jugerManche, hasard, annoncesDePartie, resoudre, jouerCoup, vuePartie, choixOrdinateur,
               valeur, composer, composerVite, gouvernementsReels, gouvernementOrdinateur, progresserSerie, ficheDe, paquetDeFiche,
               PAQUETS_FICHES};
  return api;
});
