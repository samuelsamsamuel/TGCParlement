#!/usr/bin/env python3
"""Base des sénateurs (open data du Sénat) : téléchargement et mise en forme.

Sources (data.senat.fr, export « Les sénateurs ») :
  ODSEN_GENERAL.csv : état civil et dernier état connu de chaque sénateur
  ODSEN_ELUSEN.csv  : mandats sénatoriaux, actuels et historiques
Fichiers en Windows-1252, précédés de lignes de commentaire commençant par « % ».

Sortie : data/senat/senateurs.json et data/senat/rapport.txt
Le rapprochement avec les fiches Sycomore est fait par cartes.py.
Bibliothèque standard uniquement.
"""
import csv
import io
import json
import os
import time
import urllib.error
import urllib.request
from collections import Counter

BASE = "https://data.senat.fr/data/senateurs/"
SORTIE = os.path.join("data", "senat")
UA = "TGCParlement/1.0 (projet personnel, contact : " + os.environ.get("CONTACT", "non renseigné") + ")"


def telecharger(nom):
    for attente in (0, 20, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request(BASE + nom, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                brut = r.read()
            break
        except urllib.error.URLError as e:
            erreur = e
    else:
        raise SystemExit(f"Échec du téléchargement de {nom} : {erreur}")
    texte = brut.decode("cp1252", errors="replace")
    lignes = [l for l in texte.splitlines() if not l.startswith("%")]
    return list(csv.DictReader(io.StringIO("\n".join(lignes))))


def jour(valeur):
    return (valeur or "").strip()[:10] or None


# Renouvellement par moitié : dernière élection de chaque série (série 1 : septembre 2023 ; série 2 : septembre 2026)
DEBUT_SERIE = {"1": "2023-10-01", "2": "2026-10-01"}


def actifs():
    """Sénateurs en fonction (www.senat.fr/api-senat/senateurs.json) : série, photo officielle, groupe."""
    try:
        req = urllib.request.Request("https://www.senat.fr/api-senat/senateurs.json", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            return {x["matricule"]: x for x in json.load(r)}
    except (urllib.error.URLError, ValueError) as e:
        print(f"Liste des sénateurs actifs indisponible : {e}")
        return {}


def main():
    en_fonction = actifs()
    general = telecharger("ODSEN_GENERAL.csv")
    elusen = telecharger("ODSEN_ELUSEN.csv")
    cle = lambda r, debut: next(v for k, v in r.items() if k and k.startswith(debut))

    senateurs = {}
    for r in general:
        mat = cle(r, "Matricule").strip()
        senateurs[mat] = {
            "matricule": mat,
            "nom": f"{cle(r, 'Pr').strip()} {cle(r, 'Nom usuel').strip()}",
            "nom_famille": cle(r, "Nom usuel").strip(),
            "prenom": cle(r, "Pr").strip(),
            "groupe": cle(r, "Groupe politique").strip() or None,
            "sexe": "F" if cle(r, "Qualit").strip().startswith("Mme") else "M",
            "naissance": jour(cle(r, "Date naissance")),
            "deces": jour(cle(r, "Date de d")),
            "circonscription": cle(r, "Circonscription").strip() or None,
            "etat": cle(r, "\u00c9tat").strip(),
            "mandats": []}
    orphelins = 0
    for r in elusen:
        mat = cle(r, "Matricule").strip()
        if mat not in senateurs:
            orphelins += 1
            continue
        senateurs[mat]["mandats"].append({
            "debut": jour(cle(r, "Date de d\u00e9but")),
            "fin": jour(cle(r, "Date de fin")),
            "motif_fin": cle(r, "Motif fin").strip() or None})

    # Sénateurs en fonction : photo officielle et groupe actuel ; pour ceux dont l'export ne donne aucun
    # mandat, début de mandat déduit de leur série (date du dernier renouvellement), signalé comme tel
    deduits = 0
    for mat, a in en_fonction.items():
        s_ = senateurs.get(mat)
        if not s_:
            continue
        if a.get("urlAvatar"):
            s_["photo"] = "https://www.senat.fr" + a["urlAvatar"]
        if a.get("groupe", {}).get("libelle"):
            s_["groupe_actuel"] = a["groupe"]["libelle"]
        if not any(m["debut"] for m in s_["mandats"]) and a.get("serie") in DEBUT_SERIE:
            s_["mandats"].append({"debut": DEBUT_SERIE[a["serie"]], "fin": None, "motif_fin": None,
                                  "deduit": f"série {a['serie']}"})
            deduits += 1
    liste = sorted(senateurs.values(), key=lambda s: s["matricule"])
    os.makedirs(SORTIE, exist_ok=True)
    with open(os.path.join(SORTIE, "senateurs.json"), "w", encoding="utf-8") as f:
        json.dump(liste, f, ensure_ascii=False, indent=0)

    debuts = Counter()
    for s in liste:
        d = min((m["debut"] for m in s["mandats"] if m["debut"]), default=None)
        debuts[(d[:3] + "0s") if d else "sans mandat daté"] += 1
    rapport = [f"Sénateurs : {len(liste)} ; mandats : {len(elusen)} ; mandats sans fiche générale : {orphelins}",
               f"Sans date de naissance : {sum(1 for s in liste if not s['naissance'])}",
               f"Sans aucun mandat : {sum(1 for s in liste if not s['mandats'])} ; "
               f"début de mandat déduit de la série (sénateurs en fonction) : {deduits}",
               "Décennie du premier mandat :"]
    rapport += [f"  {k} : {v}" for k, v in sorted(debuts.items())]
    texte = "\n".join(rapport)
    with open(os.path.join(SORTIE, "rapport.txt"), "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    print(texte)


if __name__ == "__main__":
    main()
