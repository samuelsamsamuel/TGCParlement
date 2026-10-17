#!/usr/bin/env python3
"""Fonctions gouvernementales récentes, d'après l'open data de l'Assemblée nationale.

Le jeu de données de la Ve République (data.gouv.fr) s'arrête au 13 mars 2025. Pour les nominations
postérieures, on lit le fichier officiel « Députés, sénateurs et ministres de la législature »
(AMO20, data.assemblee-nationale.fr), qui porte les mandats de type GOUVERNEMENT avec leur intitulé
et leurs dates. Seules les fonctions commençant après le 13 mars 2025 sont reprises.
Sorties : data/gouvernement/an_lignes.json et data/listes/rapports/gouvernements-an-rapport.txt
"""
import io
import json
import os
import time
import urllib.error
import urllib.request
import zipfile

ADRESSES = [
    f"https://data.assemblee-nationale.fr/static/openData/repository/{leg}/amo/deputes_senateurs_ministres_legislature/AMO20_dep_sen_min_tous_mandats_et_organes.json.zip"
    for leg in (18, 17)
]
DEPUIS = "2025-03-13"
SORTIE = os.path.join("data", "gouvernement", "an_lignes.json")
RAPPORT = os.path.join("data", "listes", "rapports", "gouvernements-an-rapport.txt")


def telecharger(rapport):
    for url in ADRESSES:
        for attente in (0, 20):
            time.sleep(attente)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "TGCParlement/1.0"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    rapport.append(f"Fichier lu : {url}")
                    return r.read()
            except urllib.error.HTTPError as e:
                rapport.append(f"{url} : {e}")
                break
            except urllib.error.URLError as e:
                rapport.append(f"{url} : {e}")
    return None


def texte(v):
    if isinstance(v, dict):
        return v.get("#text") or ""
    return v or ""


def categorie(code, libelle):
    t = f"{code} {libelle}".lower()
    if "premier ministre" in t:
        return "chef-gouvernement"
    if "secrétaire d'état" in t or "secretaire d'etat" in t:
        return "secretaire-etat"
    if "ministre" in t or "garde des sceaux" in t:
        return "ministre"
    return None


def main():
    rapport = []
    brut = telecharger(rapport)
    lignes = []
    if brut:
        with zipfile.ZipFile(io.BytesIO(brut)) as z:
            for nom in z.namelist():
                if "/acteur/" not in nom or not nom.endswith(".json"):
                    continue
                a = json.load(z.open(nom))["acteur"]
                ident = a["etatCivil"]["ident"]
                mandats = a.get("mandats", {}).get("mandat", [])
                if isinstance(mandats, dict):
                    mandats = [mandats]
                for m in mandats:
                    if m.get("typeOrgane") != "GOUVERNEMENT":
                        continue
                    debut = texte(m.get("dateDebut"))[:10]
                    if not debut or debut <= DEPUIS:
                        continue
                    q = m.get("infosQualite") or {}
                    code, libelle = texte(q.get("codeQualite")), texte(q.get("libQualite"))
                    cat = categorie(code, libelle)
                    if not cat:
                        continue
                    lignes.append({"liste": cat, "prenom": ident.get("prenom"), "nom": ident.get("nom"),
                                   "debut": debut, "fin": (texte(m.get("dateFin"))[:10] or None),
                                   "fonction": libelle or code})
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(lignes, f, ensure_ascii=False, indent=0)
    rapport.append(f"Fonctions gouvernementales postérieures au {DEPUIS} : {len(lignes)}")
    rapport += [f"  {l['prenom']} {l['nom']} : {l['fonction']} ({l['debut']} -> {l['fin'] or 'en cours'})"
                for l in sorted(lignes, key=lambda x: x["debut"])]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:6]))


if __name__ == "__main__":
    main()
