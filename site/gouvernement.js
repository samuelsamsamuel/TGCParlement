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
  function fichesDeJeu(data) {
    const fiches = new Map();
    for (const [id, f] of Object.entries(data.fiches)) {
      const etoiles = new Map();
      for (const e of f[1]) etoiles.set(e >> 2, e & 3);
      fiches.set(id, {id, stature: f[0], etoiles, annees: f[2], groupe: f[3], deps: f[4], gouv: f[5] || [], chefs: f[6] || []});
    }
    return {themes: data.themes, fiches};
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

  // Réglages lus à l'appel (la simulation les fait varier)
  const api = {ETOILE, PLAFOND_STATURE, LIENS_MAX, MINISTRES, ANNONCES, MANCHES, VICTOIRE, fichesDeJeu, liens, force,
               verifierGouvernement, jugerManche};
  return api;
});
