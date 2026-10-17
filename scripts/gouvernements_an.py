#!/usr/bin/env python3
"""Fonctions gouvernementales récentes, d'après l'open data de l'Assemblée nationale.

Le jeu de données de la Ve République (data.gouv.fr) s'arrête au 13 mars 2025. Pour les nominations
postérieures, on lit le fichier officiel « Députés, sénateurs et ministres de la législature »
(AMO20, data.assemblee-nationale.fr), qui porte les mandats de type GOUVERNEMENT avec leur intitulé
et leurs dates. Seules les fonctions commençant après le 13 mars 2025 sont reprises.
Le même fichier sert aussi aux fonctions au sein de l'Assemblée (présidences de groupe et de commission,
rapporteur général, vice-présidence, questure et secrétariat du Bureau), rattachées aux cartes par le nom
et la date de naissance. L'historique officiel est privilégié (AMO30, depuis 1997) ; à défaut, le fichier
de la législature (AMO20) ne couvre que les députés en fonction et leurs mandats antérieurs.
Sorties : data/gouvernement/an_lignes.json, data/gouvernement/fonctions_assemblee.json,
data/listes/{presidence-groupe,presidence-commission,rapporteur-general,bureau-vp-questeur,bureau-secretaire}.json
et data/listes/rapports/gouvernements-an-rapport.txt
"""
import http.client
import io
import json
import os
import time
import urllib.error
import urllib.request
import zipfile

ADRESSES = [
    "https://data.assemblee-nationale.fr/static/openData/repository/17/amo/tous_acteurs_mandats_organes_xi_legislature/AMO30_tous_acteurs_tous_mandats_tous_organes_historique.json.zip",
] + [
    f"https://data.assemblee-nationale.fr/static/openData/repository/{leg}/amo/deputes_senateurs_ministres_legislature/AMO20_dep_sen_min_tous_mandats_et_organes.json.zip"
    for leg in (18, 17)
]
DEPUIS = "2025-03-13"
SORTIE = os.path.join("data", "gouvernement", "an_lignes.json")
RAPPORT = os.path.join("data", "listes", "rapports", "gouvernements-an-rapport.txt")


def telecharger(rapport):
    """Téléchargement par blocs, repris jusqu'à cinq fois si la connexion se coupe en cours de route."""
    for url in ADRESSES:
        for essai, attente in enumerate((0, 10, 30, 60, 120), 1):
            time.sleep(attente)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "TGCParlement/1.0"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    attendu = int(r.headers.get("Content-Length") or 0)
                    morceaux = []
                    while True:
                        bloc = r.read(65536)
                        if not bloc:
                            break
                        morceaux.append(bloc)
                    brut = b"".join(morceaux)
                if attendu and len(brut) < attendu:
                    raise http.client.IncompleteRead(brut, attendu - len(brut))
                zipfile.ZipFile(io.BytesIO(brut)).testzip()  # archive complète et lisible
                rapport.append(f"Fichier lu : {url} ({len(brut)} octets, essai {essai})")
                return brut
            except urllib.error.HTTPError as e:
                rapport.append(f"{url} : {e}")
                break
            except (urllib.error.URLError, http.client.HTTPException, zipfile.BadZipFile, OSError) as e:
                rapport.append(f"{url} : essai {essai} interrompu ({type(e).__name__})")
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


LISTES_ASSEMBLEE = {
    "presidence-commission": (10, "A présidé une commission permanente"),
    "rapporteur-general": (10, "A été rapporteur général du budget"),
    "presidence-groupe": (8, "A présidé un groupe politique"),
    "bureau-vp-questeur": (8, "A été vice-président ou questeur de l'Assemblée"),
    "bureau-secretaire": (3, "A été secrétaire de l'Assemblée"),
}


def norme(t):
    import unicodedata
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def fonction_assemblee(type_organe, qualite, libelle_organe):
    q, o = norme(qualite), norme(libelle_organe)
    if "rapporteur general" in q:
        return "rapporteur-general", f"Rapporteur général ({libelle_organe})"
    if type_organe == "GP" and q.startswith("president"):
        return "presidence-groupe", f"Président du groupe {libelle_organe}"
    if type_organe == "COMPER" and q.startswith("president"):
        return "presidence-commission", f"Président de la {libelle_organe[:1].lower() + libelle_organe[1:]}"
    if "bureau" in o or type_organe == "BUREAU":
        if q.startswith("vice-president") or q.startswith("questeur"):
            return "bureau-vp-questeur", f"{qualite} de l'Assemblée nationale"
        if q.startswith("secretaire"):
            return "bureau-secretaire", "Secrétaire de l'Assemblée nationale"
    return None, None


def main():
    rapport = []
    brut = telecharger(rapport)
    lignes, assemblee = [], []
    if brut:
        with zipfile.ZipFile(io.BytesIO(brut)) as z:
            organes = {}
            for nom in z.namelist():
                if "/organe/" in nom and nom.endswith(".json"):
                    o = json.load(z.open(nom))["organe"]
                    organes[texte(o.get("uid"))] = (texte(o.get("codeType")), texte(o.get("libelle")))
            for nom in z.namelist():
                if "/acteur/" not in nom or not nom.endswith(".json"):
                    continue
                a = json.load(z.open(nom))["acteur"]
                ident = a["etatCivil"]["ident"]
                naissance = texte((a["etatCivil"].get("infoNaissance") or {}).get("dateNais"))[:10]
                mandats = a.get("mandats", {}).get("mandat", [])
                if isinstance(mandats, dict):
                    mandats = [mandats]
                for m in mandats:
                    if True:
                        q = m.get("infosQualite") or {}
                        ref = (m.get("organes") or {}).get("organeRef")
                        ref = ref[0] if isinstance(ref, list) else ref
                        type_o, lib_o = organes.get(texte(ref), (texte(m.get("typeOrgane")), ""))
                        code, libelle = fonction_assemblee(texte(m.get("typeOrgane")) or type_o, texte(q.get("codeQualite")), lib_o)
                        if code:
                            assemblee.append({"code": code, "fonction": libelle, "prenom": ident.get("prenom"),
                                              "nom": ident.get("nom"), "naissance": naissance,
                                              "debut": texte(m.get("dateDebut"))[:10] or None,
                                              "fin": texte(m.get("dateFin"))[:10] or None})
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
    rattacher_assemblee(assemblee, rapport)
    rapport.append(f"Fonctions gouvernementales postérieures au {DEPUIS} : {len(lignes)}")
    rapport += [f"  {l['prenom']} {l['nom']} : {l['fonction']} ({l['debut']} -> {l['fin'] or 'en cours'})"
                for l in sorted(lignes, key=lambda x: x["debut"])]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:6]))


def rattacher_assemblee(assemblee, rapport):
    """Rattachement aux cartes : même date de naissance et même nom de famille (tous ses mots)."""
    if not assemblee or not os.path.exists(os.path.join("data", "cartes.json")):
        rapport.append("Fonctions au sein de l'Assemblée : aucune lue")
        return
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    import re
    from collections import defaultdict
    mots = lambda t: set(re.findall(r"[a-z]+", norme(t))) - {"de", "du", "des", "la", "le", "d", "l"}
    par_date = defaultdict(list)
    for c in cartes:
        if c.get("naissance"):
            par_date[c["naissance"]].append(c)
    membres, detail, orphelins = defaultdict(set), defaultdict(list), set()
    for x in assemblee:
        candidats = [c for c in par_date.get(x["naissance"], []) if mots(x["nom"]) and mots(x["nom"]) <= mots(c["nom"])]
        if len(candidats) != 1:
            orphelins.add(f"{x['prenom']} {x['nom']} ({x['naissance']})")
            continue
        ident = candidats[0]["id"]
        membres[x["code"]].add(ident)
        detail[str(ident)].append({"fonction": x["fonction"], "liste": x["code"], "debut": x["debut"], "fin": x["fin"]})
    for code, (points, libelle) in LISTES_ASSEMBLEE.items():
        with open(os.path.join("data", "listes", code + ".json"), "w", encoding="utf-8") as f:
            json.dump({"code": code, "points": points, "plancher": None, "libelle": libelle,
                       "source": "Assemblée nationale, open data (mandats au sein des organes), depuis 1997",
                       "ids": sorted(membres[code], key=str)}, f, ensure_ascii=False, indent=1)
    fusion = {}
    for ident, fs in detail.items():
        uniques = {}
        for x in sorted(fs, key=lambda x: x["debut"] or ""):
            u = uniques.setdefault(x["fonction"], dict(x))
            u["fin"] = None if not (u["fin"] and x["fin"]) else max(u["fin"], x["fin"])
        fusion[ident] = list(uniques.values())
    with open(os.path.join("data", "gouvernement", "fonctions_assemblee.json"), "w", encoding="utf-8") as f:
        json.dump(fusion, f, ensure_ascii=False, indent=0)
    rapport.insert(1, "Fonctions au sein de l'Assemblée : " + ", ".join(f"{k} {len(v)}" for k, v in membres.items())
                   + f" ; non rattachées : {len(orphelins)}")


if __name__ == "__main__":
    main()
