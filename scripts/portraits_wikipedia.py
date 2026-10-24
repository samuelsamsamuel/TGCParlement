#!/usr/bin/env python3
"""Portraits tirés de l'article Wikipédia en français, pour les cartes sans aucun autre portrait.

Décision de l'utilisateur (octobre 2026) : quand ni Wikidata (P18), ni la fiche Sycomore, ni le Sénat ne donnent de
portrait, la carte reprend l'image principale de l'article Wikipédia de la personne. Le rattachement reste fait par
identifiant officiel : l'article est celui que Wikidata relie à l'élément portant l'identifiant Sycomore (P1045) ou
sénateur (P1808) de la carte, jamais une recherche par le nom.

L'image principale d'un article n'est pas toujours un portrait (blason, signature, tombe, page de titre…). N'est
retenue qu'une image libre (pilicense=free) hébergée sur Commons, au format photo (JPEG, PNG, WebP), dont la fiche
Commons déclare représenter la personne même (« dépeint », P180, égal à l'élément Wikidata rattaché par l'identifiant
officiel), et dont le nom de fichier ne contient aucun des mots de EXCLUS (mots entiers, sans accents). Les fichiers
retenus et écartés sont listés dans le rapport, avec la raison.

Mesure (première exécution, 24 octobre 2026) : sur 7 430 cartes sans portrait ayant un article rattaché, 550 articles
ont une image principale libre ; le seul filtre de mots en gardait 124, dont une majorité de tombes du Père-Lachaise,
de pages de titre et d'armoiries : d'où l'exigence de « dépeint ».

Sorties : data/portraits_wikipedia.json ({identifiant de carte: fichier Commons}),
data/listes/rapports/portraits-wikipedia-rapport.txt
"""
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

SPARQL = "https://query.wikidata.org/sparql"
API = "https://fr.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
UA = "TGCParlement/1.0 (portraits ; https://github.com/samuelsamsamuel/TGCParlement ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
SORTIE = os.path.join("data", "portraits_wikipedia.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-wikipedia-rapport.txt")
REQUETES = {
    "sycomore": "SELECT ?id ?p ?article WHERE { ?p wdt:P1045 ?id . ?article schema:about ?p ; "
                "schema:isPartOf <https://fr.wikipedia.org/> . }",
    "senat": "SELECT ?id ?p ?article WHERE { ?p wdt:P1808 ?id . ?article schema:about ?p ; "
             "schema:isPartOf <https://fr.wikipedia.org/> . }",
}
FORMATS = (".jpg", ".jpeg", ".png", ".webp")
# Mots entiers du nom de fichier, sans accents (« Descartes » ou « Armstrong » ne sont pas écartés)
EXCLUS = {"signature", "autographe", "blason", "armoiries", "armoirie", "armes", "arms", "wapen", "coat", "marque", "carte",
          "map", "plan", "logo", "drapeau", "flag", "plaque", "tombe", "tombeau", "tomb", "grave", "grab", "caveau", "stele",
          "sepulture", "sepultures", "cimetiere", "cim", "enclos", "funeraire", "carditaphe", "lachaise", "maison", "house",
          "chalet", "chateau", "chapelle", "eglise", "church", "mairie", "hotel", "rue", "place", "street", "monument",
          "medaille", "medal", "timbre", "stamp", "affiche", "poster", "caricature", "recueil", "assassinat", "aerostat"}


def sans_accents(t):
    return "".join(c for c in unicodedata.normalize("NFD", t.lower()) if unicodedata.category(c) != "Mn")


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


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
    raise SystemExit(f"Source injoignable : {erreur}")


def articles():
    """{identifiant de carte: (titre de l'article frwiki, élément Wikidata)}, par identifiant officiel."""
    trouves = {}
    for cle, requete in REQUETES.items():
        url = SPARQL + "?" + urllib.parse.urlencode({"query": requete, "format": "json"})
        for b in obtenir(url, {"Accept": "application/sparql-results+json"})["results"]["bindings"]:
            brut = b["id"]["value"].strip()
            if cle == "sycomore" and not brut.isdigit():
                continue
            ident = brut if cle == "sycomore" else "S" + brut[-6:].upper()
            titre = urllib.parse.unquote(b["article"]["value"].rsplit("/wiki/", 1)[1]).replace("_", " ")
            trouves.setdefault(ident, (titre, b["p"]["value"].rsplit("/", 1)[1]))
    return trouves


def images(titres):
    """{titre demandé: (fichier, adresse de la vignette)} pour les images principales libres."""
    resultat = {}
    for i in range(0, len(titres), 50):
        lot = titres[i:i + 50]
        url = API + "?" + urllib.parse.urlencode({"action": "query", "prop": "pageimages", "piprop": "name|thumbnail",
                                                  "pithumbsize": 330, "pilicense": "free", "titles": "|".join(lot),
                                                  "redirects": 1, "format": "json", "formatversion": 2, "maxlag": 5})
        d = obtenir(url)["query"]
        # Titres normalisés et redirections : retour au titre demandé
        vers = {t: t for t in lot}
        for n in d.get("normalized", []):
            vers[n["to"]] = vers.get(n["from"], n["from"])
        for r in d.get("redirects", []):
            vers[r["to"]] = vers.get(r["from"], r["from"])
        for p in d.get("pages", []):
            if p.get("pageimage") and p.get("thumbnail"):
                resultat[vers.get(p["title"], p["title"])] = (p["pageimage"], p["thumbnail"]["source"])
        time.sleep(1)
    return resultat


def depeints(fichiers):
    """{fichier: éléments Wikidata que sa fiche Commons dit représenter (P180)}."""
    resultat = {}
    for i in range(0, len(fichiers), 50):
        lot = fichiers[i:i + 50]
        url = COMMONS + "?" + urllib.parse.urlencode({"action": "query", "titles": "|".join("File:" + f for f in lot),
                                                      "format": "json", "formatversion": 2, "maxlag": 5})
        pages = {p["title"].split(":", 1)[1].replace(" ", "_"): p.get("pageid") for p in obtenir(url)["query"]["pages"]}
        ids = {f"M{v}": k for k, v in pages.items() if v}
        if ids:
            url = COMMONS + "?" + urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(ids), "props": "claims",
                                                          "format": "json", "maxlag": 5})
            for mid, ent in obtenir(url).get("entities", {}).items():
                valeurs = {c["mainsnak"].get("datavalue", {}).get("value", {}).get("id")
                           for c in (ent.get("statements") or ent.get("claims") or {}).get("P180", [])}
                resultat[ids[mid]] = valeurs - {None}
        time.sleep(1)
    return resultat


def retenir(fichier, vignette, element, representes):
    """Raison d'écarter l'image, ou None si elle est retenue."""
    if "/wikipedia/commons/" not in vignette:
        return "hors de Commons"
    if not fichier.lower().endswith(FORMATS):
        return "format"
    if EXCLUS & set(re.split(r"[^a-z0-9]+", sans_accents(fichier))):
        return "nom de fichier"
    if element not in representes:
        return "la fiche Commons ne dit pas représenter la personne"
    return None


def main():
    cartes = lire(os.path.join("data", "cartes.json"), [])
    deja = set(lire(os.path.join("data", "portraits.json"), {}))
    deja |= {k for k, v in lire(os.path.join("data", "portraits_sycomore.json"), {}).items() if v}
    sans = {str(c["id"]) for c in cartes if not c.get("photo")} - deja
    liens = {k: v for k, v in articles().items() if k in sans}
    trouvees = images(sorted({t for t, _ in liens.values()}))
    representes = depeints(sorted({f.replace(" ", "_") for f, _ in trouvees.values()}))
    retenus, ecartes = {}, []
    for ident, (titre, element) in sorted(liens.items()):
        if titre not in trouvees:
            continue
        fichier, vignette = trouvees[titre]
        raison = retenir(fichier, vignette, element, representes.get(fichier.replace(" ", "_"), set()))
        if raison:
            ecartes.append(f"{ident}\t{titre}\t{fichier}\t{raison}")
        else:
            retenus[ident] = fichier.replace("_", " ")
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(retenus, f, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Portraits Wikipédia : {len(retenus)} retenus, {len(ecartes)} écartés, sur {len(liens)} cartes sans portrait "
              f"ayant un article rattaché par identifiant officiel ({len(sans)} cartes sans portrait en tout)",
              "", "Retenus :"] + [f"{k}\t{liens[k][0]}\t{v}" for k, v in sorted(retenus.items())] + ["", "Écartés :"] + ecartes
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
