#!/usr/bin/env python3
"""Portraits des parlementaires depuis Wikidata et Wikimedia Commons.

Rattachement par identifiant officiel, jamais par le nom :
  P1045 (identifiant Sycomore de l'Assemblée nationale) -> cartes des députés ;
  P1808 (identifiant sénateur sur le site du Sénat, qui se termine par le matricule) -> cartes des sénateurs.
Seule l'image principale de l'élément (P18) est retenue. Les fichiers de Commons ont chacun leur
licence : l'application renvoie à la page du fichier pour l'auteur et la licence.
Le libellé français de l'élément Wikidata sert de nom d'usage (« Henri Grégoire » plutôt que le premier
prénom de l'état civil), sans risque d'erreur d'identité puisque le rattachement passe par l'identifiant.
Sorties : data/portraits.json ({identifiant de carte: fichier Commons}), data/noms_usage.json.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

POINT = "https://query.wikidata.org/sparql"
UA = "TGCParlement/1.0 (projet personnel ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
REQUETES = {
    "sycomore": "SELECT ?id ?img ?nom WHERE { ?p wdt:P1045 ?id . OPTIONAL { ?p wdt:P18 ?img } "
                "OPTIONAL { ?p rdfs:label ?nom FILTER(LANG(?nom) = 'fr') } }",
    "senat": "SELECT ?id ?img ?nom WHERE { ?p wdt:P1808 ?id . OPTIONAL { ?p wdt:P18 ?img } "
             "OPTIONAL { ?p rdfs:label ?nom FILTER(LANG(?nom) = 'fr') } }",
}
# Membres du Gouvernement sans mandat parlementaire : pas d'identifiant officiel commun ; recherche par le
# libellé exact, limitée aux personnes de nationalité française, et retenue seulement si un seul élément répond.
REQUETE_NOMS = ("SELECT ?nom ?img WHERE { VALUES ?nom { %s } ?p rdfs:label ?nom ; wdt:P27 wd:Q142 ; "
                "wdt:P31 wd:Q5 ; wdt:P18 ?img . }")


def interroger(requete):
    url = POINT + "?" + urllib.parse.urlencode({"query": requete, "format": "json"})
    for attente in (0, 30, 90):
        time.sleep(attente)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["results"]["bindings"]
        except (urllib.error.URLError, TimeoutError) as e:
            erreur = e
    raise SystemExit(f"Wikidata injoignable : {erreur}")


def fichier(url_image):
    return urllib.parse.unquote(url_image.rsplit("/", 1)[-1])


def main():
    portraits, noms = {}, {}
    for cle, requete in REQUETES.items():
        for b in interroger(requete):
            brut = b["id"]["value"].strip()
            ident = brut if cle == "sycomore" else "S" + brut[-6:].upper()
            if cle == "sycomore" and not brut.isdigit():
                continue
            if "img" in b:
                portraits.setdefault(ident, fichier(b["img"]["value"]))
            if "nom" in b:
                noms.setdefault(ident, b["nom"]["value"])
    nb_an = len(portraits)
    f_hors = os.path.join("data", "gouvernement", "hors_parlement.json")
    if os.path.exists(f_hors):
        with open(f_hors, encoding="utf-8") as f:
            hors = {p["nom"]: p["id"] for p in json.load(f)}
        libelles = list(hors)
        for i in range(0, len(libelles), 60):
            valeurs = " ".join('"%s"@fr' % n.replace('"', "") for n in libelles[i:i + 60])
            trouves = {}
            for b in interroger(REQUETE_NOMS % valeurs):
                trouves.setdefault(b["nom"]["value"], set()).add(fichier(b["img"]["value"]))
            for nom, fichiers in trouves.items():
                if len(fichiers) == 1:
                    portraits.setdefault(hors[nom], fichiers.pop())
    with open(os.path.join("data", "noms_usage.json"), "w", encoding="utf-8") as f:
        json.dump(noms, f, ensure_ascii=False, indent=0)
    with open(os.path.join("data", "portraits.json"), "w", encoding="utf-8") as f:
        json.dump(portraits, f, ensure_ascii=False, indent=0)
    print(f"Portraits : {nb_an} par identifiant officiel, {len(portraits) - nb_an} membres du Gouvernement "
          f"par libellé exact ; noms d'usage : {len(noms)}")


if __name__ == "__main__":
    main()
