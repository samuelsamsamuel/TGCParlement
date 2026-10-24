#!/usr/bin/env python3
"""Portraits tirés de l'article Wikipédia en français, pour les cartes sans aucun autre portrait.

Décision de l'utilisateur (octobre 2026) : quand ni Wikidata (P18), ni la fiche Sycomore, ni le Sénat ne donnent de
portrait, la carte reprend l'image principale de l'article Wikipédia de la personne. Le rattachement reste fait par
identifiant officiel : l'article est celui que Wikidata relie à l'élément portant l'identifiant Sycomore (P1045) ou
sénateur (P1808) de la carte, jamais une recherche par le nom.

L'image principale d'un article n'est pas toujours un portrait (blason, signature, carte, demeure…) : n'est retenue
qu'une image libre (pilicense=free) hébergée sur Commons, au format photo (JPEG, PNG, WebP), dont le nom de fichier
ne contient aucun des mots de EXCLUS (mots entiers). Les fichiers retenus et écartés sont listés dans le rapport.

Mesure préalable (octobre 2026) : 6 513 cartes sans portrait ont un article Wikipédia rattaché par l'identifiant
Sycomore ; la part de ces articles qui ont une image principale libre reste à mesurer, l'API de Wikipédia
refusant les requêtes du poste de mesure (429) : le rapport de la première exécution la donnera.

Sorties : data/portraits_wikipedia.json ({identifiant de carte: fichier Commons}),
data/listes/rapports/portraits-wikipedia-rapport.txt
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

SPARQL = "https://query.wikidata.org/sparql"
API = "https://fr.wikipedia.org/w/api.php"
UA = "TGCParlement/1.0 (portraits ; https://github.com/samuelsamsamuel/TGCParlement ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
SORTIE = os.path.join("data", "portraits_wikipedia.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-wikipedia-rapport.txt")
REQUETES = {
    "sycomore": "SELECT ?id ?article WHERE { ?p wdt:P1045 ?id . ?article schema:about ?p ; "
                "schema:isPartOf <https://fr.wikipedia.org/> . }",
    "senat": "SELECT ?id ?article WHERE { ?p wdt:P1808 ?id . ?article schema:about ?p ; "
             "schema:isPartOf <https://fr.wikipedia.org/> . }",
}
FORMATS = (".jpg", ".jpeg", ".png", ".webp")
# Mots entiers du nom de fichier (« Descartes » ou « Armstrong » ne sont pas écartés)
EXCLUS = {"signature", "blason", "armoiries", "arms", "coat", "carte", "map", "plan", "logo", "drapeau", "flag", "plaque",
          "tombe", "tomb", "grave", "sépulture", "cimetière", "maison", "house", "château", "église", "church", "mairie",
          "hôtel", "rue", "street", "monument", "médaille", "medal", "timbre", "stamp", "affiche", "poster", "caricature"}


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
    """{identifiant de carte: titre de l'article frwiki}, par identifiant officiel."""
    trouves = {}
    for cle, requete in REQUETES.items():
        url = SPARQL + "?" + urllib.parse.urlencode({"query": requete, "format": "json"})
        for b in obtenir(url, {"Accept": "application/sparql-results+json"})["results"]["bindings"]:
            brut = b["id"]["value"].strip()
            if cle == "sycomore" and not brut.isdigit():
                continue
            ident = brut if cle == "sycomore" else "S" + brut[-6:].upper()
            titre = urllib.parse.unquote(b["article"]["value"].rsplit("/wiki/", 1)[1]).replace("_", " ")
            trouves.setdefault(ident, titre)
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


def retenir(fichier, vignette):
    """Raison d'écarter l'image, ou None si elle est retenue."""
    if "/wikipedia/commons/" not in vignette:
        return "hors de Commons"
    if not fichier.lower().endswith(FORMATS):
        return "format"
    if EXCLUS & set(re.split(r"[^\wÀ-ÿ]+|_", fichier.lower())):
        return "nom de fichier"
    return None


def main():
    cartes = lire(os.path.join("data", "cartes.json"), [])
    deja = set(lire(os.path.join("data", "portraits.json"), {}))
    deja |= {k for k, v in lire(os.path.join("data", "portraits_sycomore.json"), {}).items() if v}
    sans = {str(c["id"]) for c in cartes if not c.get("photo")} - deja
    liens = {k: v for k, v in articles().items() if k in sans}
    trouvees = images(sorted(set(liens.values())))
    retenus, ecartes = {}, []
    for ident, titre in sorted(liens.items()):
        if titre not in trouvees:
            continue
        fichier, vignette = trouvees[titre]
        raison = retenir(fichier, vignette)
        if raison:
            ecartes.append(f"{ident}\t{titre}\t{fichier}\t{raison}")
        else:
            retenus[ident] = fichier.replace("_", " ")
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(retenus, f, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Portraits Wikipédia : {len(retenus)} retenus, {len(ecartes)} écartés, sur {len(liens)} cartes sans portrait "
              f"ayant un article rattaché par identifiant officiel ({len(sans)} cartes sans portrait en tout)",
              "", "Retenus :"] + [f"{k}\t{liens[k]}\t{v}" for k, v in sorted(retenus.items())] + ["", "Écartés :"] + ecartes
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
