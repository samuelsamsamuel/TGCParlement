#!/usr/bin/env python3
"""Numéros des départements, pour la recherche par numéro dans l'ordre du jour.

Source officielle : Code officiel géographique de l'Insee, par l'API Métadonnées (api.insee.fr/metadonnees/V1,
sans clé), liste des départements en vigueur au 1er janvier de chaque année depuis 1943, date à laquelle commence
l'historique de l'Insee. Les anciens noms d'un département (Côtes-du-Nord, Basses-Pyrénées, Seine-Inférieure…)
gardent ainsi leur numéro, comme les départements disparus de cette période (Seine, Seine-et-Oise, Corse avant 1976).
Les noms antérieurs à 1943 et les circonscriptions qui ne sont pas des départements (anciennes colonies,
départements de l'Empire hors de France) n'ont pas de numéro : la recherche par nom reste la seule pour eux.

Mesure (octobre 2026) : chaque élément porte code, intitule, dateCreation et dateSuppression.
Sorties : site/departements.json ({intitulé: [numéros]}), data/listes/rapports/departements-rapport.txt
"""
import datetime
import json
import os
import re
import time
import unicodedata
import urllib.request

API = "https://api.insee.fr/metadonnees/V1/geo/departements?date={}"
SORTIE = os.path.join("site", "departements.json")
RAPPORT = os.path.join("data", "listes", "rapports", "departements-rapport.txt")
# Graphies abrégées des sources des cartes, rattachées à l'intitulé de l'Insee qu'elles abrègent
ABREVIATIONS = {"Seine-St-Denis": "Seine-Saint-Denis"}
UA = {"User-Agent": "TGCParlement/1.0", "Accept": "application/json"}


def lire(url):
    erreur = None
    for attente in (0, 10, 30):
        time.sleep(attente)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — le rapport dit ce qui a échoué
            erreur = e
    raise RuntimeError(f"{url} ({erreur})")


def normer(t):
    # Même idée que Regles.normer (regles.js) : sans accents ni casse, tirets en espaces ; pour le rapport seulement
    t = "".join(c for c in unicodedata.normalize("NFD", t or "") if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"\s+", " ", re.sub(r"[-‐–—]", " ", t.replace("’", "'"))).strip()


def main():
    rapport = []
    numeros = {}
    try:
        for annee in range(1943, datetime.date.today().year + 1):
            for d in lire(API.format(f"{annee}-01-01")):
                liste = numeros.setdefault(d["intitule"], [])
                if d["code"] not in liste:
                    liste.append(d["code"])
            time.sleep(0.2)
    except RuntimeError as e:
        print(f"API de l'Insee injoignable ({e}) : numéros précédents gardés")
        return
    for abrege, intitule in ABREVIATIONS.items():
        if intitule in numeros:
            numeros[abrege] = numeros[intitule]
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(numeros.items())), f, ensure_ascii=False, separators=(",", ":"))
    # Départements des cartes sans numéro (noms d'avant 1943, circonscriptions hors départements)
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    connus = {normer(n) for n in numeros}
    noms = {m.get("departement") for c in cartes for m in c.get("mandats", []) if m.get("departement")}
    sans = sorted(n for n in noms if normer(n) not in connus)
    plusieurs = sorted(f"{n} : {', '.join(c)}" for n, c in numeros.items() if len(c) > 1)
    lignes = [f"Départements de l'Insee depuis 1943 : {len(numeros)} intitulés ; départements des cartes : {len(noms)}, "
              f"dont {len(sans)} sans numéro", "", "Intitulés à plusieurs numéros :"] + plusieurs + ["", "Sans numéro :"] + sans
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes + rapport) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
