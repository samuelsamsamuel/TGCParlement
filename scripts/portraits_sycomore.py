#!/usr/bin/env python3
"""Portraits officiels de l'Assemblée nationale (Sycomore), pour les députés sans portrait Wikidata.

Source officielle : la fiche Sycomore d'un député affiche son portrait, quand l'Assemblée en a un, à l'adresse
fixe https://www2.assemblee-nationale.fr/static/sycomore/jpg/<identifiant Sycomore>.jpg ; sinon elle affiche
une silhouette par défaut. Le script vérifie, carte par carte, que cette adresse renvoie bien une image
(requête HEAD, statut 200, type image/*). Rattachement par l'identifiant Sycomore de la carte : aucun risque
d'erreur d'identité.

Mesure préalable (échantillon de 60 députés sans portrait, octobre 2026) : 26 portraits présents, soit 43 %.

Reprise : les résultats déjà obtenus sont conservés dans data/portraits_sycomore.json ; chaque exécution
reprend où la précédente s'est arrêtée, dans la limite de BUDGET_MINUTES (20 par défaut), avec quatre
requêtes en parallèle et trois requêtes par seconde au plus.
Sortie : data/portraits_sycomore.json ({identifiant: 1 si portrait, 0 sinon}),
data/listes/rapports/portraits-sycomore-rapport.txt
"""
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request

ADRESSE = "https://www2.assemblee-nationale.fr/static/sycomore/jpg/{}.jpg"
SORTIE = os.path.join("data", "portraits_sycomore.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-sycomore-rapport.txt")
BUDGET = float(os.environ.get("BUDGET_MINUTES", "20")) * 60
DELAI = float(os.environ.get("DELAI", "0.34"))   # secondes entre deux départs de requête, tous fils confondus
PARALLELE = int(os.environ.get("PARALLELE", "4"))
UA = "TGCParlement/1.0 (portraits ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


def sonder(ident):
    req = urllib.request.Request(ADRESSE.format(ident), method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 1 if r.status == 200 and r.headers.get("content-type", "").startswith("image/") else 0
    except urllib.error.HTTPError as e:
        return 0 if e.code in (403, 404, 410) else None   # autre erreur : à refaire
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def main():
    debut = time.monotonic()
    cartes = lire(os.path.join("data", "cartes.json"), [])
    wikidata = lire(os.path.join("data", "portraits.json"), {})
    resultats = lire(SORTIE, {})
    a_sonder = [c["id"] for c in cartes if isinstance(c["id"], int) and str(c["id"]) not in wikidata
                and str(c["id"]) not in resultats]
    compte = {"sondes": 0, "erreurs": 0}
    verrou, cadence = threading.Lock(), threading.Lock()
    prochain = [time.monotonic()]

    def tache(ident):
        if time.monotonic() - debut > BUDGET:
            return
        with cadence:  # trois départs par seconde au plus
            attente = prochain[0] - time.monotonic()
            if attente > 0:
                time.sleep(attente)
            prochain[0] = max(prochain[0], time.monotonic()) + DELAI
        r = sonder(ident)
        with verrou:
            if r is None:
                compte["erreurs"] += 1
                return
            resultats[str(ident)] = r
            compte["sondes"] += 1
            if compte["sondes"] % 200 == 0:
                with open(SORTIE, "w", encoding="utf-8") as f:
                    json.dump(resultats, f, separators=(",", ":"), sort_keys=True)

    with ThreadPoolExecutor(PARALLELE) as pool:
        list(pool.map(tache, a_sonder))
    sondes, erreurs = compte["sondes"], compte["erreurs"]
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(resultats, f, separators=(",", ":"), sort_keys=True)
    reste = sum(1 for c in cartes if isinstance(c["id"], int) and str(c["id"]) not in wikidata and str(c["id"]) not in resultats)
    presents = sum(resultats.values())
    rapport = [f"Portraits Sycomore : {presents} présents sur {len(resultats)} députés sondés "
               f"({100 * presents // max(1, len(resultats))} %) ; sondés cette fois : {sondes} ; erreurs à refaire : {erreurs} ; "
               f"restant à sonder : {reste}"]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print(rapport[0])


if __name__ == "__main__":
    main()
