#!/usr/bin/env python3
"""Portraits officiels du Sénat pour les anciens sénateurs (le site du Sénat les garde après le mandat).

Source officielle : www.senat.fr/senimg/<nom>_<prénom><matricule>_carre.jpg, la photo de la fiche du sénateur.
L'API du Sénat ne donne l'adresse (urlAvatar) que pour les sénateurs en fonction (scripts/senateurs.py) ; pour les
anciens, l'adresse est reconstruite à partir du nom de famille, du prénom et du matricule de l'open data
(data/senat/senateurs.json), puis vérifiée par une requête HEAD (statut 200, type image/*). Le matricule figure dans
l'adresse : aucun risque de confusion entre homonymes.

Mesure préalable (octobre 2026) : 939 cartes de sénateurs sans portrait ; sur un échantillon de 60, 59 photos
trouvées avec la règle de nom ci-dessous (une adresse inconnue renvoie 404).

Durée : BUDGET_MINUTES (5 par défaut) ; deux tentatives de 15 secondes par adresse.

Sorties : data/portraits_senat.json ({identifiant de carte: adresse de la photo}),
data/listes/rapports/portraits-senat-rapport.txt
"""
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request

SORTIE = os.path.join("data", "portraits_senat.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-senat-rapport.txt")
UA = "TGCParlement/1.0 (portraits ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
DELAI = float(os.environ.get("DELAI", "0.3"))
# Limite de durée par exécution : le site du Sénat peut répondre lentement aux machines du workflow ; ce qui n'a pas
# été sondé l'est à l'exécution suivante (les photos déjà trouvées sont gardées)
BUDGET = float(os.environ.get("BUDGET_MINUTES", "5")) * 60


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


def segment(texte):
    """« Marc-Philippe » -> « marc_philippe », sans accents."""
    t = "".join(c for c in unicodedata.normalize("NFD", texte.lower()) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "_", t).strip("_")


def adresses(s):
    famille, prenom, matricule = segment(s["nom_famille"]), segment(s["prenom"]), s["matricule"].lower()
    noms = [famille]
    sans_particule = re.sub(r"^(de_la_|de_|d_|du_|des_|le_|la_)", "", famille)
    if sans_particule != famille:
        noms.append(sans_particule)
    return [f"https://www.senat.fr/senimg/{n}_{prenom}{matricule}_carre.jpg" for n in noms]


def existe(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    for attente in (0, 5):
        time.sleep(attente)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status == 200 and r.headers.get("content-type", "").startswith("image/")
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                return False
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
    return None   # injoignable : à refaire à la prochaine exécution


def main():
    senateurs = lire(os.path.join("data", "senat", "senateurs.json"), [])
    cartes = {str(c["id"]) for c in lire(os.path.join("data", "cartes.json"), [])}
    wikidata = lire(os.path.join("data", "portraits.json"), {})
    resultats = lire(SORTIE, {})
    a_sonder = [s for s in senateurs if not s.get("photo")
                and ("S" + s["matricule"].upper()) in cartes and ("S" + s["matricule"].upper()) not in wikidata
                and ("S" + s["matricule"].upper()) not in resultats]
    trouves, absents, erreurs, debut = 0, [], 0, time.monotonic()
    for s in a_sonder:
        if time.monotonic() - debut > BUDGET:
            erreurs += 1
            continue
        ident, reponse = "S" + s["matricule"].upper(), None
        for url in adresses(s):
            r = existe(url)
            time.sleep(DELAI)
            if r:
                reponse = url
                break
            if r is None:
                reponse = False
        if reponse:
            resultats[ident] = reponse
            trouves += 1
        elif reponse is False:
            erreurs += 1
        else:
            absents.append(f"{ident}\t{s['prenom']} {s['nom_famille']}")
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(resultats, f, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Portraits du Sénat : {len(resultats)} en tout ; sondés cette fois : {len(a_sonder)}, trouvés {trouves}, "
              f"sans photo {len(absents)}, erreurs à refaire {erreurs}", "", "Sans photo sur le site du Sénat :"] + absents
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
