#!/usr/bin/env python3
"""Fonctions au sein du Sénat : présidences de commission permanente, rapporteur général, présidences de groupe.

Sources officielles (data.senat.fr) : ODSEN_COMS.csv (appartenances courantes et historiques aux
commissions, avec la fonction occupée) et ODSEN_HISTOGROUPES.csv (appartenances aux groupes politiques).
Les fonctions sont ajoutées aux listes déjà établies pour l'Assemblée (mêmes codes, mêmes points) et au
détail des fonctions de chaque carte. Le Bureau du Sénat (vice-présidents, questeurs, secrétaires) ne
figure pas dans ces exports : il est lu dans l'export complet de la base par senat_bureau.py.
Rattachement : matricule du Sénat -> carte, d'après data/senat/correspondances.json (écrit par cartes.py).
Symétrie avec l'Assemblée (DECISION_SYMETRIE) : le détail des cartes garde toute l'histoire, mais seules
les fonctions exercées à partir du 19 juin 2002 donnent des points.
Sortie complémentaire : data/listes/rapports/senat-fonctions-rapport.txt
"""
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from senateurs import telecharger  # noqa: E402
from gouvernements_an import LISTES_ASSEMBLEE  # noqa: E402

RAPPORT = os.path.join("data", "listes", "rapports", "senat-fonctions-rapport.txt")
F_DETAIL = os.path.join("data", "gouvernement", "fonctions_assemblee.json")

# Ouverture de la XIIe législature, d'après l'organe « Assemblée nationale de la 12ème législature »
# d'AMO30 (data.assemblee-nationale.fr). C'est le début réel de la couverture de l'Assemblée.
COUVERTURE_ASSEMBLEE = "2002-06-19"
DECISION_SYMETRIE = (
    "Les fonctions au sein de l'Assemblée (Bureau, présidences de commission et de groupe, rapporteur "
    "général) ne sont connues par l'open data de l'Assemblée qu'à partir de la XIIe législature : "
    "l'historique AMO30 ne porte aucun mandat au Bureau avant juin 2002, et aucune source officielle "
    "structurée ne couvre 1958-2002 (le site de l'Assemblée n'offre que des listes partielles, comme celle "
    "des femmes vice-présidentes, et les comptes rendus des séances en PDF). Le Sénat, lui, couvre ces "
    "fonctions depuis 1959. Pour que députés et sénateurs d'une même époque soient notés de la même façon, "
    f"une fonction du Sénat ne donne des points que si elle a été exercée le {COUVERTURE_ASSEMBLEE} ou "
    "après (en cours, ou terminée à cette date ou plus tard). Les fonctions antérieures restent dans le "
    "détail de la carte, sans points. Une fonction sans aucune date ne donne pas de points.")


def compte_pour_les_points(debut, fin):
    if fin:
        return fin >= COUVERTURE_ASSEMBLEE
    return debut is not None  # fonction en cours


def est_du_senat(ligne):
    return ligne["fonction"].endswith(" du Sénat") or ligne["fonction"].endswith(" au Sénat")


def ecrire_listes(codes, senat, detail, source, libelles=None):
    """Liste = membres de l'Assemblée (lus dans le détail, hors lignes du Sénat) + membres du Sénat retenus.

    Reconstruite à chaque exécution : un sénateur qui ne remplit plus la règle en sort."""
    bilan = {}
    for code in codes:
        assemblee = {k for k, v in detail.items() for x in v if x["liste"] == code and not est_du_senat(x)}
        chemin = os.path.join("data", "listes", code + ".json")
        liste = {"code": code, "points": None, "plancher": None, "libelle": code, "source": "", "ids": []}
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as f:
                liste = json.load(f)
        if libelles and code in libelles:
            liste["points"], liste["libelle"] = libelles[code]
        base = {i for i in liste["ids"] if str(i) in assemblee}
        avant = len(liste["ids"])
        liste["ids"] = sorted(base | senat.get(code, set()), key=str)
        # Source : segments de l'Assemblée conservés ; chaque liste n'est complétée que par un script du Sénat,
        # dont le segment est remplacé à chaque exécution
        parties = [x for x in (liste.get("source") or "").split(" ; ") if x and not x.startswith("Sénat")]
        liste["source"] = " ; ".join(parties + [source])
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(liste, f, ensure_ascii=False, indent=1)
        bilan[code] = (len(base), len(senat.get(code, set())), avant, len(liste["ids"]))
    return bilan


def norme(t):
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower().strip()


def colonne(ligne, *mots, exclure=()):
    for k in ligne:
        n = norme(k)
        if all(m in n for m in mots) and not any(x in n for x in exclure):
            return k
    return None


def iso(v):
    v = (v or "").strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", v) or None
    if m:
        return v[:10]
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", v)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def lire(nom, rapport):
    try:
        lignes = telecharger(nom)
    except SystemExit as e:
        rapport.append(f"{nom} : {e}")
        return [], {}
    if not lignes:
        rapport.append(f"{nom} : fichier vide")
        return [], {}
    l0 = lignes[0]

    def premiere(*noms):
        return next((n for n in noms if n in l0), None)
    # Intitulés exacts des exports du Sénat (relevés sur les fichiers), puis repli par mots-clés
    cols = {"matricule": premiere("Matricule") or colonne(l0, "matricule"),
            "organe": premiere("Nom commission", "Nom court du groupe politique") or colonne(l0, "nom", "commission"),
            "type": premiere("Type commission"),
            "fonction": premiere("Fonction", "Nom court fonction") or colonne(l0, "fonction", exclure=("id", "date", "debut", "fin")),
            "debut": premiere("Début de fonction", "Date de début de la fonction"),
            "fin": premiere("Fin de fonction", "Date de fin de la fonction")}
    rapport.append(f"{nom} : {len(lignes)} lignes ; colonnes : {' | '.join(l0.keys())}")
    rapport.append(f"  colonnes retenues : {cols}")
    if cols["fonction"]:
        if cols.get("type"):
            rapport.append("  types de commission : " + ", ".join(f"{t} ({n})" for t, n in Counter((l[cols['type']] or '').strip() for l in lignes).most_common(10)))
        rapport.append("  fonctions les plus fréquentes : " + ", ".join(
            f"{f} ({n})" for f, n in Counter((l[cols['fonction']] or '').strip() for l in lignes).most_common(15)))
    return lignes, cols


def main():
    rapport = []
    with open(os.path.join("data", "senat", "correspondances.json"), encoding="utf-8") as f:
        carte_de = json.load(f)
    trouvees = []  # (code, carte, intitulé, début, fin)

    coms, c = lire("ODSEN_COMS.csv", rapport)
    # Le type de commission ne sert que s'il nomme bien les commissions permanentes ; sinon, repli sur le nom
    types_utiles = bool(c.get("type")) and any("permanente" in norme(l.get(c["type"])) for l in coms)
    if c.get("matricule") and c.get("fonction"):
        for l in coms:
            fonction, organe = norme(l[c["fonction"]]), (l.get(c["organe"]) or "").strip() if c["organe"] else ""
            o = norme(organe)
            type_c = norme(l.get(c["type"])) if types_utiles else ""
            permanente = ("permanente" in type_c) if type_c else (
                o.startswith("commission") and not any(x in o for x in ("enquete", "speciale", "mixte"))
                and not re.search(r"\bmission\b", o))  # mot entier : « commission » contient « mission »
            if not permanente:
                continue  # commissions mixtes paritaires, spéciales, d'enquête et missions : non retenues
            nom_commission = organe[:1].lower() + organe[1:]
            if "rapporteur general" in fonction:
                code, titre = "rapporteur-general", f"Rapporteur général de la {nom_commission} du Sénat"
            elif fonction.startswith("president"):
                code, titre = "presidence-commission", f"Président de la {nom_commission} du Sénat"
            else:
                continue
            trouvees.append((code, l[c["matricule"]].strip(), titre, iso(l.get(c["debut"])), iso(l.get(c["fin"]))))

    groupes, g = lire("ODSEN_HISTOGROUPES.csv", rapport)
    if g.get("matricule") and g.get("fonction"):
        for l in groupes:
            fonction = norme(l[g["fonction"]])
            if fonction.startswith("president") and "vice" not in fonction:
                organe = (l.get(g["organe"]) or "").strip() if g["organe"] else ""
                organe = re.sub(r"^Groupe\s+", "", organe)  # « Groupe Les Républicains » -> « Les Républicains »
                trouvees.append(("presidence-groupe", l[g["matricule"]].strip(), f"Président du groupe {organe} au Sénat",
                                 iso(l.get(g["debut"])), iso(l.get(g["fin"]))))

    # Détail des fonctions (établi pour l'Assemblée par gouvernements_an.py) : les lignes de ce script
    # sont remplacées à chaque exécution ; listes reconstruites selon DECISION_SYMETRIE
    codes = ("presidence-commission", "rapporteur-general", "presidence-groupe")
    detail = defaultdict(list)
    if os.path.exists(F_DETAIL):
        with open(F_DETAIL, encoding="utf-8") as f:
            detail.update(json.load(f))
    for ident in list(detail):
        detail[ident] = [x for x in detail[ident] if not (x["liste"] in codes and est_du_senat(x))]
    ajouts, sans_points, orphelins = defaultdict(set), defaultdict(set), set()
    for code, matricule, titre, debut, fin in trouvees:
        ident = carte_de.get(matricule)
        if ident is None:
            orphelins.add(matricule)
            continue
        (ajouts if compte_pour_les_points(debut, fin) else sans_points)[code].add(ident)
        ligne = {"fonction": titre, "liste": code, "debut": debut, "fin": fin}
        if ligne not in detail[str(ident)]:
            detail[str(ident)].append(ligne)
    bilan = ecrire_listes(codes, ajouts, detail, "Sénat, open data (commissions et groupes), à partir de 2002",
                          LISTES_ASSEMBLEE)
    with open(F_DETAIL, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in detail.items() if v}, f, ensure_ascii=False, indent=0)
    rapport.insert(0, "Fonctions au sein du Sénat donnant des points : " + ", ".join(f"{k} {len(v)}" for k, v in ajouts.items())
                   + f" ; matricules sans carte : {len(orphelins)}")
    rapport.insert(1, "  DÉCISION (symétrie avec l'Assemblée) : " + DECISION_SYMETRIE)
    rapport.insert(2, "  cartes gardant ces fonctions sans points (exercées avant le " + COUVERTURE_ASSEMBLEE + ") : "
                   + ", ".join(f"{k} {len(v - ajouts[k])}" for k, v in sans_points.items()))
    rapport.insert(3, "  listes (membres de l'Assemblée + du Sénat ; taille avant -> après) : " + ", ".join(
        f"{k} {a} + {s_} ; {av} -> {ap}" for k, (a, s_, av, ap) in bilan.items()))
    rapport += [f"  {t} ({d or '?'} -> {f_ or ''})" for _, _, t, d, f_ in sorted(trouvees, key=lambda x: x[3] or "")[-25:]]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:6]))


if __name__ == "__main__":
    main()
