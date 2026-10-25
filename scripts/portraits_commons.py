#!/usr/bin/env python3
"""Portraits de Wikimedia Commons dont la fiche dit représenter la personne, pour les cartes sans aucun autre portrait.

Demande de l'utilisateur (octobre 2026) : améliorer la couverture photo, faible avant 1870 (un tiers des cartes de la
Révolution et des monarchies constitutionnelles). Wikidata (P18), Sycomore, le Sénat et l'image principale de
Wikipédia sont déjà lus ; il reste les fichiers de Commons dont les données structurées déclarent représenter
(« dépeint », P180) l'élément Wikidata rattaché à la carte par identifiant officiel (Sycomore P1045, Sénat P1808),
jamais par le nom. C'est le même critère que portraits_wikipedia.py, appliqué à tous les fichiers de Commons.

Ne sont retenus que les fichiers dont la fiche ne dépeint que cette personne (pas de photo de groupe, de tombe ou de
scène portant aussi d'autres éléments), dont le nom contient un mot du nom de famille (premier passage, octobre
2026 : « FRAC069266 1K3 Guignol.jpg » déclaré représenter Lazare Goujon), au format photo (JPEG, PNG, WebP), dont le nom ne contient aucun mot de
EXCLUS (portraits_wikipedia.py). S'il en reste plusieurs, le premier nom de fichier contenant « portrait », sinon
l'ordre alphabétique : le choix est stable d'une exécution à l'autre. Les fichiers retenus et écartés sont listés
dans le rapport, avec la raison. Une recherche Commons qui échoue garde les portraits déjà trouvés.

Reprise : BUDGET_MINUTES (10 par défaut) par exécution, les éléments jamais sondés d'abord, puis les plus anciens
(data/portraits_commons_sondes.json, date du dernier sondage de chaque élément).

Recherche : haswbstatement:P180=Q1|P180=Q2… (CirrusSearch limite une requête à 300 caractères, d'où des lots de 16).

Sorties : data/portraits_commons.json ({identifiant de carte: fichier Commons}),
data/listes/rapports/portraits-commons-rapport.txt
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from cartes import nom_famille_sycomore  # noqa: E402
from portraits_wikipedia import EXCLUS, FORMATS, REQUETES, SPARQL, lire, sans_accents  # noqa: E402

COMMONS = "https://commons.wikimedia.org/w/api.php"
UA = "TGCParlement/1.0 (portraits ; https://github.com/samuelsamsamuel/TGCParlement ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
SORTIE = os.path.join("data", "portraits_commons.json")
SONDES = os.path.join("data", "portraits_commons_sondes.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-commons-rapport.txt")
LOT = 16
BUDGET = float(os.environ.get("BUDGET_MINUTES", "10")) * 60


def obtenir(url, entetes=None, essais=(0, 20, 60)):
    erreur = None
    for attente in essais:
        time.sleep(attente)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(entetes or {})})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            erreur = e
    raise RuntimeError(f"Source injoignable : {erreur}")


def elements():
    """{identifiant de carte: élément Wikidata}, par identifiant officiel (Sycomore, Sénat)."""
    trouves = {}
    for cle in REQUETES:
        propriete = "P1045" if cle == "sycomore" else "P1808"
        url = SPARQL + "?" + urllib.parse.urlencode({"query": f"SELECT ?id ?p WHERE {{ ?p wdt:{propriete} ?id . }}", "format": "json"})
        for b in obtenir(url, {"Accept": "application/sparql-results+json"})["results"]["bindings"]:
            brut = b["id"]["value"].strip()
            if cle == "sycomore" and not brut.isdigit():
                continue
            ident = brut if cle == "sycomore" else "S" + brut[-6:].upper()
            trouves.setdefault(ident, b["p"]["value"].rsplit("/", 1)[1])
    return trouves


def depeints_par_fichier(qids):
    """{fichier: éléments que sa fiche dit représenter (P180)} pour les fichiers qui dépeignent l'un des qids."""
    titres, suite = [], 0
    recherche = "haswbstatement:" + "|".join(f"P180={q}" for q in qids)
    while suite is not None:
        d = obtenir(COMMONS + "?" + urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": recherche,
                                                            "srnamespace": 6, "srlimit": 500, "sroffset": suite,
                                                            "format": "json", "maxlag": 5}))
        titres += [h["title"] for h in d["query"]["search"]]
        suite = d.get("continue", {}).get("sroffset")
    resultat = {}
    for i in range(0, len(titres), 50):
        lot = titres[i:i + 50]
        pages = obtenir(COMMONS + "?" + urllib.parse.urlencode({"action": "query", "titles": "|".join(lot), "format": "json",
                                                                "formatversion": 2, "maxlag": 5}))["query"]["pages"]
        ids = {f"M{p['pageid']}": p["title"].split(":", 1)[1] for p in pages if p.get("pageid")}
        if not ids:
            continue
        for mid, ent in obtenir(COMMONS + "?" + urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(ids),
                                                                        "props": "claims", "format": "json", "maxlag": 5})).get("entities", {}).items():
            valeurs = {c["mainsnak"].get("datavalue", {}).get("value", {}).get("id")
                       for c in (ent.get("statements") or ent.get("claims") or {}).get("P180", [])}
            resultat[ids[mid]] = valeurs - {None}
        time.sleep(1)
    return resultat


def mots_famille(nom):
    """Mots distinctifs du nom de famille : « Christian Lunet de La Malène » -> {lunet, malene}."""
    return {m for m in re.split(r"[^a-z]+", sans_accents(nom_famille_sycomore(nom))) if len(m) > 2} - {"des", "les"}


def raison(fichier, element, representes, famille):
    """Raison d'écarter le fichier, ou None s'il est retenu."""
    if not fichier.lower().endswith(FORMATS):
        return "format"
    if EXCLUS & set(re.split(r"[^a-z0-9]+", sans_accents(fichier))):
        return "nom de fichier"
    if representes != {element}:
        return f"dépeint aussi {len(representes - {element})} autre(s) élément(s)"
    if not famille & set(re.split(r"[^a-z]+", sans_accents(fichier))):
        return "nom de famille absent du nom de fichier"
    return None


def main():
    cartes = lire(os.path.join("data", "cartes.json"), [])
    deja = set(lire(os.path.join("data", "portraits.json"), {}))
    for chemin in ("portraits_sycomore.json", "portraits_senat.json", "portraits_wikipedia.json"):
        deja |= {k for k, v in lire(os.path.join("data", chemin), {}).items() if v}
    sans = {str(c["id"]) for c in cartes if not c.get("photo")} - deja
    precedents = lire(SORTIE, {})
    try:
        liens = {k: v for k, v in elements().items() if k in sans}
    except RuntimeError as e:
        print(f"{e} : portraits précédents gardés")
        return
    noms = {str(c["id"]): c["nom"] for c in cartes}
    par_element = {}
    for ident, q in liens.items():
        par_element.setdefault(q, []).append(ident)
    sondes = lire(SONDES, {})
    # Portraits déjà retenus, gardés tant que la carte n'a pas d'autre portrait ; revus quand l'élément est sondé
    retenus = {k: v for k, v in precedents.items() if k in liens}
    qids = sorted(par_element, key=lambda q: (sondes.get(q, ""), q))
    ecartes, debut, non_sondes, aujourdhui = [], time.monotonic(), 0, time.strftime("%Y-%m-%d")
    for i in range(0, len(qids), LOT):
        lot = qids[i:i + LOT]
        if time.monotonic() - debut > BUDGET:
            non_sondes += len(qids) - i
            break
        try:
            fichiers = depeints_par_fichier(lot)
        except RuntimeError:
            non_sondes += len(lot)
            continue
        for q in lot:
            sondes[q] = aujourdhui
            for ident in par_element[q]:
                retenus.pop(ident, None)
            candidats = []
            for fichier, representes in sorted(fichiers.items()):
                if q not in representes:
                    continue
                famille = set().union(*(mots_famille(noms.get(i, "")) for i in par_element[q]))
                r = raison(fichier, q, representes, famille)
                if r:
                    ecartes.append(f"{q}\t{fichier}\t{r}")
                else:
                    candidats.append(fichier)
            if candidats:
                choix = next((f for f in candidats if "portrait" in sans_accents(f)), candidats[0])
                for ident in par_element[q]:
                    retenus[ident] = choix
        time.sleep(1)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(retenus, f, ensure_ascii=False, indent=0, sort_keys=True)
    with open(SONDES, "w", encoding="utf-8") as f:
        json.dump(sondes, f, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Portraits Commons : {len(retenus)} cartes, sur {len(liens)} cartes sans portrait rattachées à Wikidata par "
              f"identifiant officiel ({len(sans)} cartes sans portrait en tout) ; éléments sondés cette fois : "
              f"{sum(1 for v in sondes.values() if v == aujourdhui)}, restant à sonder ou en erreur : {non_sondes}",
              "", "Retenus :"] + [f"{k}\t{noms.get(k, '')}\t{liens.get(k, '')}\t{v}" for k, v in sorted(retenus.items())] + \
             ["", "Écartés :"] + ecartes
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
