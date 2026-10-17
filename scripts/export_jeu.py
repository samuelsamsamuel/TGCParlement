#!/usr/bin/env python3
"""Export des cartes pour l'application : site/jeu.json, format compact.

Chaque carte : [id, nom affiché, rareté, score, texte, première année, dernière année, source,
portrait (fichier Commons ou null), distinctions (codes), chambres ("A" Assemblée, "S" Sénat, "G" Gouvernement), sexe,
fonctions [intitulé, début, fin, rang], mandats regroupés [intitulé, département, début, fin, nombre]].
Le nom affiché est le nom d'usage : premier prénom et nom de famille pour les fiches Sycomore
(« Jacques, Michel, Pierre Chaban-Delmas » -> « Jacques Chaban-Delmas »).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from cartes import nom_famille_sycomore  # noqa: E402

RARETES = ["legendaire", "epique", "rare", "peu-commune", "commune", "hors-categorie"]


def nom_affiche(c):
    nom = c["nom"] or ""
    if isinstance(c["id"], int) and "," in nom:
        return f"{nom.split(',')[0].strip()} {nom_famille_sycomore(nom)}"
    return nom


def annees(c):
    dates = [m.get("debut") for m in c.get("mandats", []) if m.get("debut")]
    dates += [f.get("debut") for f in c.get("fonctions", []) if f.get("debut")]
    fins = [m.get("fin") for m in c.get("mandats", []) if m.get("fin")]
    en_cours = any(m.get("en_cours") for m in c.get("mandats", []))
    if not dates:
        return None, None
    return int(min(dates)[:4]), (None if en_cours else int(max(fins + dates)[:4]))


RANG = {"chef-etat": 0, "chef-etat-interim": 1, "chef-gouvernement": 1, "presidence": 2, "ministre": 3, "secretaire-etat": 4}


def an(d):
    return int(d[:4]) if d else None


def fonctions_carte(ident, gouv, pres):
    """[intitulé, année de début, année de fin (None si en cours ou inconnue), rang d'importance]."""
    liste = []
    for f in gouv.get(str(ident), []):
        liste.append([f["fonction"], an(f["debut"]), an(f["fin"]), RANG.get(f["liste"], 5)])
    for f in pres.get(str(ident), []):
        liste.append([f["fonction"], an(f["debut"]), an(f["fin"]), RANG["presidence"]])
    liste.sort(key=lambda x: (x[3], x[1] or 0))
    return liste


def mandats_carte(c):
    """Mandats regroupés par chambre et département : [intitulé, département, début, fin, nombre]."""
    feminin = c.get("sexe") == "F"
    groupes = []
    for m in sorted(c.get("mandats", []), key=lambda m: m.get("debut") or ""):
        if not m.get("debut") and not m.get("non_date"):
            continue
        if m.get("chambre") == "AN":
            titre = "Députée" if feminin else "Député"
            dep = m.get("departement")
        else:
            titre = "Sénatrice" if feminin else "Sénateur"
            dep = m.get("departement")
            if not dep and m.get("fonction") and "(" in m["fonction"]:
                dep = m["fonction"].split("(", 1)[1].rstrip(")")
        fin = None if m.get("en_cours") else an(m.get("fin"))
        if groupes and groupes[-1][0] == titre and groupes[-1][1] == dep:
            g = groupes[-1]
            g[3] = None if fin is None or g[3] is None and m.get("en_cours") else max(g[3] or 0, fin or 0)
            g[4] += 1
        else:
            groupes.append([titre, dep, an(m.get("debut")), fin, 1])
    return groupes


def source(c):
    if isinstance(c["id"], int):
        return f"https://www2.assemblee-nationale.fr/sycomore/fiche/{c['id']}"
    return c.get("source")


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    def lire(chemin):
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as f:
                return json.load(f)
        return {}
    gouv = lire(os.path.join("data", "gouvernement", "fonctions.json"))
    pres = lire(os.path.join("data", "gouvernement", "presidences_an.json"))
    for k, v in lire(os.path.join("data", "gouvernement", "presidences_senat.json")).items():
        pres.setdefault(k, []).extend(v)
    portraits = {}
    if os.path.exists(os.path.join("data", "portraits.json")):
        with open(os.path.join("data", "portraits.json"), encoding="utf-8") as f:
            portraits = json.load(f)
    sortie = []
    for c in cartes:
        debut, fin = annees(c)
        texte = re.sub(r"\s+", " ", c.get("texte") or "").strip()
        chambres = "".join(sorted({"A" if m.get("chambre") == "AN" else "S" for m in c.get("mandats", [])}))
        codes = [d["code"] for d in c.get("distinctions", [])]
        if any(x in codes for x in ("chef-etat", "chef-etat-interim", "chef-gouvernement", "ministre", "secretaire-etat")):
            chambres += "G"
        sortie.append([c["id"], nom_affiche(c), RARETES.index(c["rarete"]), c["score"], texte, debut, fin, source(c),
                       portraits.get(str(c["id"])), codes, chambres, c.get("sexe"),
                       fonctions_carte(c["id"], gouv, pres), mandats_carte(c)])
    os.makedirs("site", exist_ok=True)
    with open(os.path.join("site", "jeu.json"), "w", encoding="utf-8") as f:
        json.dump({"raretes": RARETES, "cartes": sortie}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Cartes avec portrait : {sum(1 for x in sortie if x[8])}")
    print(f"Cartes exportées : {len(sortie)} ; taille : {os.path.getsize(os.path.join('site', 'jeu.json')) // 1024} Ko")


if __name__ == "__main__":
    main()
