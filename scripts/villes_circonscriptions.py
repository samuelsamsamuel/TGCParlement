#!/usr/bin/env python3
"""Plus grande ville de chaque circonscription législative (découpage en vigueur depuis 2012).

Sources officielles :
  - Ministère de l'Intérieur, « Circonscriptions législatives : table de correspondance des communes
    et des cantons pour les élections législatives de 2012 et sa mise à jour pour 2017 » (data.gouv.fr),
    retrouvée par l'API de data.gouv.fr ;
  - populations municipales de l'Insee, par l'API Découpage administratif (geo.api.gouv.fr).
Une commune partagée entre plusieurs circonscriptions (grandes villes découpées par cantons) est signalée
« en partie ». Le découpage antérieur à 2012 n'est pas couvert : aucune ville n'est affichée pour ces mandats.
Sorties : data/gouvernement/villes_circonscriptions.json, data/listes/rapports/villes-rapport.txt
"""
import csv
import io
import json
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict

UA = {"User-Agent": "TGCParlement/1.0"}
RAPPORT = os.path.join("data", "listes", "rapports", "villes-rapport.txt")


def lire(url, binaire=False):
    for attente in (0, 15, 45):
        time.sleep(attente)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                brut = r.read()
            return brut if binaire else brut.decode("utf-8-sig", errors="replace")
        except Exception as e:  # noqa: BLE001 — le rapport dit ce qui a échoué
            erreur = e
    raise SystemExit(f"Échec : {url} ({erreur})")


def norme(t):
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def table_correspondance(rapport):
    """Ressource CSV la plus récente du jeu de données du ministère de l'Intérieur."""
    q = urllib.parse.quote("Table de correspondance des communes et des cantons pour les élections législatives")
    resultats = json.loads(lire(f"https://www.data.gouv.fr/api/1/datasets/?q={q}&page_size=20"))["data"]
    for d in resultats:
        if "correspondance" in norme(d["title"]) and "legislatives" in norme(d["title"]) \
                and "interieur" in norme((d.get("organization") or {}).get("name")):
            csvs = [r for r in d["resources"] if (r.get("format") or "").lower() in ("csv", "txt") or r["url"].lower().endswith(".csv")]
            csvs.sort(key=lambda r: r.get("last_modified") or "", reverse=True)
            if csvs:
                rapport.append(f"Jeu de données : {d['title']} ({d['page']}) ; ressource : {csvs[0]['title']}")
                return lire(csvs[0]["url"], binaire=True)
    raise SystemExit("Table de correspondance introuvable sur data.gouv.fr")


def main():
    rapport = []
    brut = table_correspondance(rapport)
    texte = None
    for enc in ("utf-8-sig", "cp1252"):
        try:
            texte = brut.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    dialecte = csv.Sniffer().sniff(texte[:4000], delimiters=";,\t")
    lignes = list(csv.reader(io.StringIO(texte), dialecte))
    entete = [norme(x) for x in lignes[0]]
    rapport.append("Colonnes : " + " | ".join(lignes[0]))

    def col(variantes, exclure=("nom", "libelle")):
        for i, h in enumerate(entete):
            if any(v in h for v in variantes) and not any(x in h for x in exclure):
                return i
        raise SystemExit(f"Colonne introuvable ({'/'.join(variantes)}) parmi : {' | '.join(lignes[0])}")
    i_dep = col(("dep", "dpt"))
    i_com = col(("commune", "com"), exclure=("nom", "libelle", "dep", "dpt", "circ", "canton"))
    i_circ = col(("circ",), exclure=("nom", "libelle", "canton"))
    i_nomcom = next((i for i, h in enumerate(entete) if "nom" in h and "commune" in h), None)
    communes_par_circo, circos_par_commune, noms = defaultdict(set), defaultdict(set), {}
    for l in lignes[1:]:
        if len(l) <= max(i_dep, i_com, i_circ):
            continue
        dep = l[i_dep].strip().upper().lstrip("0") or "0"
        dep = dep.zfill(2) if dep.isdigit() else dep
        com = re.sub(r"\D", "", l[i_com]) if l[i_com].strip().isdigit() else l[i_com].strip()
        circ = re.sub(r"\D", "", l[i_circ]).lstrip("0")
        if not circ:
            continue
        code_insee = com if len(com) == 5 else dep + com.zfill(3) if len(dep) == 2 else dep + com.zfill(2)
        # Arrondissements municipaux de Paris, Lyon et Marseille : rapportés à leur commune
        if code_insee.startswith("751") and len(code_insee) == 5 and code_insee != "75056":
            code_insee = "75056"
        elif code_insee.startswith("6938"):
            code_insee = "69123"
        elif code_insee.startswith("132") and code_insee[3:].isdigit() and 1 <= int(code_insee[3:]) <= 16:
            code_insee = "13055"
        communes_par_circo[f"{dep}-{circ}"].add(code_insee)
        circos_par_commune[code_insee].add(f"{dep}-{circ}")
        if i_nomcom is not None:
            noms[code_insee] = l[i_nomcom].strip()
    population = {c["code"]: (c.get("nom"), c.get("population") or 0)
                  for c in json.loads(lire("https://geo.api.gouv.fr/communes?fields=nom,code,population&format=json"))}
    villes = {}
    for circo, communes in communes_par_circo.items():
        connues = [(population[c][1], population[c][0], c) for c in communes if c in population]
        if not connues:
            continue
        pop, nom, code = max(connues)
        villes[circo] = {"ville": nom, "population": pop, "partielle": len(circos_par_commune[code]) > 1}
    os.makedirs(os.path.join("data", "gouvernement"), exist_ok=True)
    with open(os.path.join("data", "gouvernement", "villes_circonscriptions.json"), "w", encoding="utf-8") as f:
        json.dump(villes, f, ensure_ascii=False, indent=0)
    rapport.append(f"Circonscriptions : {len(communes_par_circo)} ; avec une ville identifiée : {len(villes)} ; "
                   f"communes sans population connue : {sum(1 for c in circos_par_commune if c not in population)}")
    rapport += [f"  {k} : {v['ville']}{' (en partie)' if v['partielle'] else ''}"
                for k, v in sorted(villes.items())[:40]]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:4]))


if __name__ == "__main__":
    main()
