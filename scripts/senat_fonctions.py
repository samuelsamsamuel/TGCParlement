#!/usr/bin/env python3
"""Fonctions au sein du Sénat : présidences de commission permanente, rapporteur général, présidences de groupe.

Sources officielles (data.senat.fr) : ODSEN_COMS.csv (appartenances courantes et historiques aux
commissions, avec la fonction occupée) et ODSEN_HISTOGROUPES.csv (appartenances aux groupes politiques).
Les fonctions sont ajoutées aux listes déjà établies pour l'Assemblée (mêmes codes, mêmes points) et au
détail des fonctions de chaque carte. Le Bureau du Sénat (vice-présidents, questeurs, secrétaires) ne
figure pas dans ces exports : il est lu dans l'export complet de la base par senat_bureau.py.
Rattachement : matricule du Sénat -> carte, d'après data/senat/correspondances.json (écrit par cartes.py).
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

RAPPORT = os.path.join("data", "listes", "rapports", "senat-fonctions-rapport.txt")


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

    # Ajout aux listes et au détail des fonctions (établis pour l'Assemblée par gouvernements_an.py)
    f_detail = os.path.join("data", "gouvernement", "fonctions_assemblee.json")
    detail = defaultdict(list)
    if os.path.exists(f_detail):
        with open(f_detail, encoding="utf-8") as f:
            detail.update(json.load(f))
    ajouts, orphelins = defaultdict(set), set()
    for code, matricule, titre, debut, fin in trouvees:
        ident = carte_de.get(matricule)
        if ident is None:
            orphelins.add(matricule)
            continue
        ajouts[code].add(ident)
        ligne = {"fonction": titre, "liste": code, "debut": debut, "fin": fin}
        if ligne not in detail[str(ident)]:
            detail[str(ident)].append(ligne)
    for code, ids in ajouts.items():
        chemin = os.path.join("data", "listes", code + ".json")
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as f:
                liste = json.load(f)
        else:
            liste = {"code": code, "points": {"presidence-commission": 10, "rapporteur-general": 10, "presidence-groupe": 8}[code],
                     "plancher": None, "libelle": code, "ids": []}
        liste["ids"] = sorted(set(liste["ids"]) | ids, key=str)
        liste["source"] = (liste.get("source") or "") + " ; Sénat, open data (commissions et groupes)"
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(liste, f, ensure_ascii=False, indent=1)
    with open(f_detail, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=0)
    rapport.insert(0, "Fonctions au sein du Sénat : " + ", ".join(f"{k} {len(v)}" for k, v in ajouts.items())
                   + f" ; matricules sans carte : {len(orphelins)}")
    rapport += [f"  {t} ({d or '?'} -> {f_ or ''})" for _, _, t, d, f_ in sorted(trouvees, key=lambda x: x[3] or "")[-25:]]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:6]))


if __name__ == "__main__":
    main()
