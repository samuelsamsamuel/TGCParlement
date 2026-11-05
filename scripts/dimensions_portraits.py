#!/usr/bin/env python3
"""Dimensions des portraits venus de Wikimedia Commons, pour repérer ceux que le cadrage commun coupe mal.

Le site cadre chaque portrait dans un bandeau plus large que haut (centré en largeur, calé à 20 % du haut). Les portraits
d'identité y tiennent bien ; les photos en pied, les tableaux et les photos de groupe moins. Ce script relève la largeur
et la hauteur de chaque fichier Commons des cartes (API de Commons, `prop=imageinfo`, 50 fichiers par requête), avec
reprise : un fichier déjà mesuré ne l'est plus. Les fichiers en largeur ou très hauts sont listés dans le rapport,
pour une revue à l'œil ; les cadrages retenus vont dans `data/cadrages.json` (fichier -> position, repris par
`export_jeu.py`). Demande de l'utilisateur, novembre 2026 (recadrer les photos).

Sortie : data/portraits_dimensions.json ({fichier: [largeur, hauteur]}), rapport data/listes/rapports/dimensions_portraits.txt.
Bibliothèque standard uniquement.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

SORTIE = os.path.join("data", "portraits_dimensions.json")
RAPPORT = os.path.join("data", "listes", "rapports", "dimensions_portraits.txt")
UA = "TGCParlement/1.0 (projet personnel, contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
MINUTES = float(os.environ.get("MINUTES_DIMENSIONS", "10"))


def interroger(lot):
    q = urllib.parse.urlencode({"action": "query", "format": "json", "prop": "imageinfo", "iiprop": "size",
                                "titles": "|".join("File:" + f for f in lot)})
    for attente in (0, 10, 30, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request("https://commons.wikimedia.org/w/api.php?" + q, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError):
            continue
    return None


def main():
    debut = time.time()
    with open(os.path.join("site", "jeu.json"), encoding="utf-8") as f:
        fichiers = sorted({c[9] for c in json.load(f)["cartes"] if c[9]})
    tailles = {}
    if os.path.exists(SORTIE):
        with open(SORTIE, encoding="utf-8") as f:
            tailles = json.load(f)
    restants = [f for f in fichiers if f not in tailles]
    echecs = 0
    for i in range(0, len(restants), 50):
        if time.time() - debut > MINUTES * 60:
            break
        lot = restants[i:i + 50]
        r = interroger(lot)
        if r is None:
            echecs += 1
            continue
        norm = {n["to"]: n["from"] for n in r.get("query", {}).get("normalized", [])}
        for p in r.get("query", {}).get("pages", {}).values():
            ii = p.get("imageinfo")
            if ii:
                tailles[norm.get(p["title"], p["title"])[5:]] = [ii[0]["width"], ii[0]["height"]]
        time.sleep(1)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(tailles, f, ensure_ascii=False, indent=0, sort_keys=True)
    mesures = {f: tailles[f] for f in fichiers if f in tailles}
    larges = sorted(f for f, (l, h) in mesures.items() if l > 1.15 * h)
    hauts = sorted(f for f, (l, h) in mesures.items() if h > 1.6 * l)
    lignes = [f"Portraits Commons des cartes : {len(fichiers)} ; mesurés : {len(mesures)} ; restant à mesurer : "
              f"{len(fichiers) - len(mesures)} ; lots en échec : {echecs}.",
              f"En largeur (plus larges que hauts de 15 %) : {len(larges)}", *("  " + f for f in larges),
              f"Très hauts (hauteur plus de 1,6 fois la largeur) : {len(hauts)}", *("  " + f for f in hauts)]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print("\n".join(lignes[:1] + [lignes[1], f"Très hauts : {len(hauts)}"]))


if __name__ == "__main__":
    main()
