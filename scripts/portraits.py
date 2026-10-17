#!/usr/bin/env python3
"""Portraits des parlementaires depuis Wikidata et Wikimedia Commons.

Rattachement par identifiant officiel, jamais par le nom :
  P1045 (identifiant Sycomore de l'Assemblée nationale) -> cartes des députés ;
  P1808 (identifiant sénateur sur le site du Sénat, qui se termine par le matricule) -> cartes des sénateurs.
Seule l'image principale de l'élément (P18) est retenue. Les fichiers de Commons ont chacun leur
licence : l'application renvoie à la page du fichier pour l'auteur et la licence.
Sortie : data/portraits.json ({identifiant de carte: nom du fichier Commons}).
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
    "sycomore": "SELECT ?id ?img WHERE { ?p wdt:P1045 ?id ; wdt:P18 ?img . }",
    "senat": "SELECT ?id ?img WHERE { ?p wdt:P1808 ?id ; wdt:P18 ?img . }",
}


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
    portraits = {}
    for b in interroger(REQUETES["sycomore"]):
        ident = b["id"]["value"].strip()
        if ident.isdigit():
            portraits.setdefault(ident, fichier(b["img"]["value"]))
    nb_an = len(portraits)
    for b in interroger(REQUETES["senat"]):
        ident = b["id"]["value"].strip()
        matricule = ident[-6:].upper()
        portraits.setdefault("S" + matricule, fichier(b["img"]["value"]))
    with open(os.path.join("data", "portraits.json"), "w", encoding="utf-8") as f:
        json.dump(portraits, f, ensure_ascii=False, indent=0)
    print(f"Portraits : {nb_an} par l'identifiant Sycomore, {len(portraits) - nb_an} par l'identifiant Sénat")


if __name__ == "__main__":
    main()
