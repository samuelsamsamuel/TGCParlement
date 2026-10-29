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
    return {themes: data.themes, fiches, groupes: data.groupes || [], departements: data.departements || []};
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
  // chef, a siégé dans un même gouvernement réel qu'un autre membre, a servi sous le chef. `avec` : qui crée le lien
  // (pour l'affichage : département commun et membre concerné)
  function liens(chef, ministres) {
    const membres = [chef, ...ministres];
    return ministres.map(m => {
      const autres = membres.filter(x => x !== m);
      const dep = autres.find(x => x.deps.some(d => m.deps.includes(d)));
      const ensemble = m.gouv.length ? autres.find(x => chevauche(m.gouv, x.gouv)) : null;
      const detail = {
        departement: !!dep,
        groupe: m.groupe >= 0 && m.groupe === chef.groupe,
        solidarite: !!ensemble,
        sousLeChef: m.gouv.length > 0 && chef.chefs.length > 0 && chevauche(m.gouv, chef.chefs),
      };
      const avec = {departement: dep ? {id: dep.id, dep: m.deps.find(d => dep.deps.includes(d))} : null, solidarite: ensemble ? ensemble.id : null};
      return {detail, avec, total: Math.min(api.LIENS_MAX, Object.values(detail).filter(Boolean).length)};
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
  // Meilleur gouvernement avec les cartes disponibles (« Compléter pour moi », demande de l'utilisateur, octobre 2026) :
  // les thèmes ne sont connus qu'à la partie, d'où une note moyenne sur des tirages de dix thèmes (graine fixe : même
  // proposition à chaque fois) : forces des ministres affectés aux thèmes (valeur, liens compris) plus la stature du chef
  // (49.3). Recherche gloutonne, puis échanges un à un tant que la note monte, dans le plafond de stature ; les ministres
  // déjà choisis (`gardes`) restent.
  // Tirages équilibrés : chaque série de tirages partage tous les thèmes en groupes de dix, chacun revient donc aussi
  // souvent que les autres (moins de hasard dans la note qu'avec des tirages indépendants)
  function tiragesThemes(nbThemes, n = 60) {
    const alea = hasard(0x3e3e), tirages = [], groupes = Math.max(1, Math.floor(nbThemes / ANNONCES));
    while (tirages.length < n) {
      const ordre = melanger([...Array(nbThemes).keys()], alea);
      for (let g = 0; g < groupes && tirages.length < n; g++) tirages.push(ordre.slice(g * ANNONCES, (g + 1) * ANNONCES));
    }
    return tirages;
  }
  function noteMoyenne(chef, ministres, tirages) {
    return evaluateur(chef, ministres, tirages, Math.max(0, ...tirages.flat()) + 1)(ministres.map((_, i) => i));
  }
  // Vivier : les meilleurs sur leur meilleur thème, les trois meilleurs de chaque thème, ceux qui ont un lien avec le chef
  const meilleure = c => c.stature + api.ETOILE * Math.max(0, ...c.etoiles.values());
  // La somme des statures est plafonnée : ce qui départage, ce sont les étoiles (et les liens) obtenues pour peu de stature
  const etoilesDe = c => [...c.etoiles.values()].reduce((a, b) => a + b, 0);
  function vivierCommun(candidats, nbThemes, taille = 60) {
    const garde = new Set(), parTheme = Array.from({length: nbThemes}, () => []);
    candidats.slice().sort((a, b) => meilleure(b) - meilleure(a) || a.stature - b.stature).slice(0, taille).forEach(c => garde.add(c));
    candidats.slice().sort((a, b) => etoilesDe(b) * 2 - b.stature - (etoilesDe(a) * 2 - a.stature)).slice(0, taille).forEach(c => garde.add(c));
    for (const c of candidats) for (const t of c.etoiles.keys()) if (t < nbThemes) parTheme[t].push(c);
    // par thème : les meilleurs pour chaque stature (le plus d'étoiles à stature égale)
    parTheme.forEach((l, t) => {
      const parStature = new Map();
      for (const c of l.sort((a, b) => b.etoiles.get(t) - a.etoiles.get(t) || etoilesDe(b) - etoilesDe(a)))
        if ((parStature.get(c.stature) || 0) < 2) { parStature.set(c.stature, (parStature.get(c.stature) || 0) + 1); garde.add(c); }
    });
    // petites statures, pour qu'un gouvernement reste possible sous le plafond
    candidats.slice().sort((a, b) => a.stature - b.stature || meilleure(b) - meilleure(a)).slice(0, MINISTRES * 2).forEach(c => garde.add(c));
    return garde;
  }
  function vivier(chef, candidats, nbThemes, commun = vivierCommun(candidats, nbThemes)) {
    const garde = new Set(commun), parStature = new Map();
    // liés au chef (même parti, ont servi sous lui) : les meilleurs de chaque stature, les petites statures liées
    // valant souvent mieux qu'une grande sans lien
    candidats.filter(c => (c.gouv.length && chef.chefs.length && chevauche(c.gouv, chef.chefs)) || (c.groupe >= 0 && c.groupe === chef.groupe))
      .sort((a, b) => etoilesDe(b) - etoilesDe(a) || b.gouv.length - a.gouv.length)
      .forEach(c => { const k = parStature.get(c.stature) || 0; if (k < 10) { parStature.set(c.stature, k + 1); garde.add(c); } });
    garde.delete(chef);
    return [...garde];
  }
  // Évaluation rapide pour la recherche : liens entre toutes les cartes du vivier calculés une fois (mêmes règles que
  // `liens`) ; pour chaque tirage, affectation gloutonne des ministres aux thèmes, forces décroissantes (comme `valeur`) :
  // seuls les thèmes où un ministre a des étoiles sont examinés, un ministre sans étoile sur les thèmes restants y siège
  // à sa force de base (dix thèmes pour huit ministres : il en reste toujours un qu'aucun autre ne réclame)
  function evaluateur(chef, cartes, tirages, nbThemes) {
    const n = cartes.length;
    const seul = new Uint8Array(n), dep = new Uint8Array(n * n), sol = new Uint8Array(n * n);
    const depChef = new Uint8Array(n), solChef = new Uint8Array(n), etoiles = new Uint8Array(n * nbThemes);
    cartes.forEach((c, i) => {
      for (const [t, e] of c.etoiles) if (t < nbThemes) etoiles[i * nbThemes + t] = e;
      seul[i] = (c.groupe >= 0 && c.groupe === chef.groupe ? 1 : 0) + (c.gouv.length && chef.chefs.length && chevauche(c.gouv, chef.chefs) ? 1 : 0);
      depChef[i] = c.deps.some(d => chef.deps.includes(d)) ? 1 : 0;
      solChef[i] = c.gouv.length && chef.gouv.length && chevauche(c.gouv, chef.gouv) ? 1 : 0;
      for (let j = 0; j < i; j++) {
        const d = cartes[j];
        dep[i * n + j] = dep[j * n + i] = c.deps.some(x => d.deps.includes(x)) ? 1 : 0;
        sol[i * n + j] = sol[j * n + i] = c.gouv.length && d.gouv.length && chevauche(c.gouv, d.gouv) ? 1 : 0;
      }
    });
    // annonce[t] : rang du tirage + 1 où le thème t est annoncé, pour chaque tirage (marques sans remise à zéro)
    // pour chaque carte et chaque tirage, les thèmes annoncés où elle a des étoiles (listes à plat)
    const nbTirages = tirages.length, debut = new Int32Array(n * nbTirages + 1), hitT = [], hitE = [];
    for (let i = 0; i < n; i++) for (let r = 0; r < nbTirages; r++) {
      for (const t of tirages[r]) { const e = etoiles[i * nbThemes + t]; if (e) { hitT.push(t); hitE.push(e); } }
      debut[i * nbTirages + r + 1] = hitT.length;
    }
    const themesVus = Int16Array.from(hitT), etoilesVues = Uint8Array.from(hitE);
    const K = MINISTRES + 2, defaut = new Float64Array(K), pf = new Float64Array(K * ANNONCES), pa = new Int8Array(K * ANNONCES), pt = new Int16Array(K * ANNONCES);
    const libre = new Uint8Array(K), pris = new Int32Array(nbThemes), ordre = new Int8Array(K);
    let marque = 0;  // thème pris dans le tirage en cours : pris[t] === marque (sans remise à zéro)
    return equipe => {
      const k = equipe.length;
      for (let a = 0; a < k; a++) {
        const i = equipe[a]; let d = depChef[i], s = solChef[i];
        for (let b = 0; b < k && !(d && s); b++) if (b !== a) { const j = equipe[b]; d ||= dep[i * n + j]; s ||= sol[i * n + j]; }
        defaut[a] = cartes[i].stature + Math.min(api.LIENS_MAX, seul[i] + d + s);
      }
      for (let a = 0; a < k; a++) {  // ministres par force de base décroissante
        let x = a; while (x > 0 && defaut[ordre[x - 1]] < defaut[a]) { ordre[x] = ordre[x - 1]; x--; } ordre[x] = a;
      }
      let total = 0;
      for (let r = 0; r < nbTirages; r++) {
        let np = 0;
        // paires (ministre, thème annoncé où il a des étoiles), triées par force décroissante (insertion)
        for (let a = 0; a < k; a++) { const c = equipe[a] * nbTirages + r; for (let y = debut[c], fin = debut[c + 1]; y < fin; y++) {
          const t = themesVus[y], f = defaut[a] + api.ETOILE * etoilesVues[y]; let x = np++;
          while (x > 0 && pf[x - 1] < f) { pf[x] = pf[x - 1]; pa[x] = pa[x - 1]; pt[x] = pt[x - 1]; x--; }
          pf[x] = f; pa[x] = a; pt[x] = t;
        } }
        libre.fill(1, 0, k); marque++;
        // paires avec étoiles et forces de base fusionnées par force décroissante (à égalité, la force de base d'abord :
        // elle ne prend aucun thème réclamé)
        let x = 0, o = 0;
        while (o < k || x < np) {
          const etoile = x < np ? pf[x] : -Infinity, sans = o < k ? defaut[ordre[o]] : -Infinity;
          if (etoile > sans) { const a = pa[x], t = pt[x]; x++; if (libre[a] && pris[t] !== marque) { libre[a] = 0; pris[t] = marque; total += etoile; } }
          else { const a = ordre[o++]; if (libre[a]) { libre[a] = 0; total += sans; } }
        }
      }
      return total / nbTirages + chef.stature;
    };
  }
  function composerMieux(chef, candidats, nbThemes, gardes = [], options = {}) {
    const tirages = options.tirages || tiragesThemes(nbThemes), places = MINISTRES - gardes.length;
    const plafond = api.PLAFOND_STATURE - gardes.reduce((t, m) => t + m.stature, 0);
    const libres = candidats.filter(c => c !== chef && !gardes.includes(c));
    const pool = vivier(chef, libres, nbThemes, options.commun ? [...options.commun].filter(c => c !== chef && !gardes.includes(c)) : undefined);
    if (pool.length < places) return null;
    const cartes = [...gardes, ...pool], fixes = gardes.map((_, i) => i), P = pool.map((_, i) => gardes.length + i);
    const st = cartes.map(c => c.stature), evaluer = evaluateur(chef, cartes, tirages, nbThemes);
    const note = choix => evaluer([...fixes, ...choix]);
    const tri = P.slice().sort((a, b) => st[a] - st[b]);
    const petites = (sauf, n) => { let t = 0; for (const i of tri) { if (!n) break; if (!sauf.includes(i)) { t += st[i]; n--; } } return n ? Infinity : t; };
    const choix = []; let reste = plafond;
    while (choix.length < places) {
      let meilleur = -1, v = -Infinity;
      for (const c of P) {
        if (choix.includes(c) || st[c] + petites([...choix, c], places - choix.length - 1) > reste) continue;
        const x = note([...choix, c]);
        if (x > v) { v = x; meilleur = c; }
      }
      if (meilleur < 0) return null;
      choix.push(meilleur); reste -= st[meilleur];
    }
    let actuelle = note(choix);
    const somme = l => l.reduce((t, i) => t + st[i], 0);
    // Échanges d'un ministre, jusqu'à ne plus progresser ; au dernier passage, les meilleurs remplaçants de chaque poste
    // sont gardés pour les échanges de deux ministres
    let remplacants = [];
    const unParUn = () => {
      for (let tour = 0; tour < 30; tour++) {
        let mieux = null; remplacants = [];
        for (let a = 0; a < choix.length; a++) {
          const sans = plafond - somme(choix) + st[choix[a]], essai = choix.slice(), notes = [];
          for (const c of P) {
            if (choix.includes(c) || st[c] > sans) continue;
            essai[a] = c; const x = note(essai); notes.push([x, c]);
            if (x > actuelle + 1e-9 && (!mieux || x > mieux.x)) mieux = {a, c, x};
          }
          remplacants.push(notes.sort((u, v) => v[0] - u[0]).slice(0, options.premiers || 8).map(u => u[1]));
        }
        if (!mieux) return;
        choix[mieux.a] = mieux.c; actuelle = mieux.x;
      }
    };
    // Puis deux ministres retirés ensemble et remplacés au mieux (ce qu'un échange seul ne voit pas : une forte stature
    // contre deux petites, deux cartes liées entre elles), choisis parmi les meilleurs remplaçants d'un seul poste
    const deuxParDeux = () => {
      for (let a = 0; a < choix.length; a++) for (let b = a + 1; b < choix.length; b++) {
        const reste2 = choix.filter((_, k) => k !== a && k !== b), sans = plafond - somme(reste2);
        // remplaçants des deux postes, plus les petites statures (une grande contre deux petites)
        const premiers = [...new Set([...remplacants[a], ...remplacants[b], ...tri.slice(0, 6)])].filter(c => !reste2.includes(c) && st[c] < sans);
        let mieux = null;
        for (const c of premiers) for (const d of premiers) {
          if (d === c || reste2.includes(d) || st[c] + st[d] > sans) continue;
          const x = note([...reste2, c, d]);
          if (x > actuelle + 1e-9 && (!mieux || x > mieux.x)) mieux = {c, d, x};
        }
        if (mieux) { choix.splice(0, choix.length, ...reste2, mieux.c, mieux.d); actuelle = mieux.x; return true; }
      }
      return false;
    };
    const ameliorer = () => { unParUn(); for (let tour = 0; tour < 10 && deuxParDeux(); tour++) unParUn(); };
    if (!options.rapide) {
      ameliorer();
      // Relances (graine fixe, dans la limite de 0,6 s environ) : trois postes tirés au hasard repourvus dans le
      // plafond, puis amélioration ; la meilleure composition rencontrée est gardée
      let meilleur = choix.slice(), note0 = actuelle;
      const alea = hasard(0x49e3), fin = Date.now() + (options.duree ?? 600);
      for (let r = 0; r < (options.relances ?? 4) && Date.now() < fin; r++) {
        choix.splice(0, choix.length, ...meilleur);
        for (const a of melanger([...choix.keys()], alea).slice(0, Math.min(3, choix.length))) {
          const sans = plafond - somme(choix) + st[choix[a]], options_ = P.filter(c => !choix.includes(c) && st[c] <= sans);
          if (options_.length) choix[a] = options_[Math.floor(alea() * options_.length)];
        }
        actuelle = note(choix); ameliorer();
        if (actuelle > note0 + 1e-9) { note0 = actuelle; meilleur = choix.slice(); }
      }
      choix.splice(0, choix.length, ...meilleur);
    }
    return choix.map(i => cartes[i]);
  }
  // Premier ministre : parmi les plus hautes statures et ceux sous qui le plus de cartes disponibles ont servi ou qui
  // partagent leur parti, les deux dont le gouvernement composé vite (glouton) a la meilleure note, départagés par une
  // composition complète
  function meilleurChef(candidats, nbThemes, gardes = []) {
    const tirages = tiragesThemes(nbThemes, 30), libres = candidats.filter(c => !gardes.includes(c));
    const membres = candidats.filter(m => m.gouv.length), parPartis = new Map();
    for (const c of candidats) if (c.groupe >= 0) parPartis.set(c.groupe, (parPartis.get(c.groupe) || 0) + 1);
    const sous = new Map(libres.filter(c => c.chefs.length).map(c => [c, membres.filter(m => m !== c && chevauche(m.gouv, c.chefs)).length]));
    const parti = c => c.groupe >= 0 ? parPartis.get(c.groupe) - 1 : 0;
    const essais = new Set([...libres.slice().sort((a, b) => b.stature - a.stature || b.annees - a.annees).slice(0, 8),
      ...[...sous].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]),
      ...libres.slice().sort((a, b) => parti(b) - parti(a) || b.stature - a.stature).slice(0, 4)]);
    const commun = vivierCommun(libres, nbThemes), notes = [];
    for (const chef of essais) {
      const choix = composerMieux(chef, libres, nbThemes, gardes, {tirages, rapide: true, commun});
      if (choix) notes.push([noteMoyenne(chef, [...gardes, ...choix], tirages), chef]);
    }
    let meilleur = null, v = -Infinity;
    for (const [, chef] of notes.sort((a, b) => b[0] - a[0]).slice(0, 2)) {
      const choix = composerMieux(chef, libres, nbThemes, gardes, {tirages, relances: 0, commun});
      const n = choix ? noteMoyenne(chef, [...gardes, ...choix], tirages) : -Infinity;
      if (n > v) { v = n; meilleur = chef; }
    }
    return meilleur;
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

  // Réglages lus à l'appel (la simulation les fait varier)
  const api = {ETOILE, PLAFOND_STATURE, LIENS_MAX, MINISTRES, ANNONCES, MANCHES, VICTOIRE, fichesDeJeu, liens, force, chevauche,
               verifierGouvernement, jugerManche, hasard, annoncesDePartie, resoudre, jouerCoup, vuePartie, choixOrdinateur,
               valeur, composer, composerVite, composerMieux, meilleurChef, noteMoyenne, tiragesThemes, evaluateur, gouvernementsReels, gouvernementOrdinateur, ficheDe, paquetDeFiche,
               PAQUETS_FICHES};
  return api;
});
