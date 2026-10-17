#!/usr/bin/env python3
"""Export des cartes pour l'application : site/jeu.json, format compact.

Chaque carte : [id, nom affiché, rareté, score, texte, première année, dernière année, source,
portrait (fichier Commons ou null), distinctions (codes), chambres ("A" Assemblée, "S" Sénat, "G" Gouvernement), sexe].
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


def source(c):
    if isinstance(c["id"], int):
        return f"https://www2.assemblee-nationale.fr/sycomore/fiche/{c['id']}"
    return c.get("source")


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
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
                       portraits.get(str(c["id"])), codes, chambres, c.get("sexe")])
    os.makedirs("site", exist_ok=True)
    with open(os.path.join("site", "jeu.json"), "w", encoding="utf-8") as f:
        json.dump({"raretes": RARETES, "cartes": sortie}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Cartes avec portrait : {sum(1 for x in sortie if x[8])}")
    print(f"Cartes exportées : {len(sortie)} ; taille : {os.path.getsize(os.path.join('site', 'jeu.json')) // 1024} Ko")


if __name__ == "__main__":
    main()
