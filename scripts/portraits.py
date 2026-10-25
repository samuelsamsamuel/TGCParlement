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
import re
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
# Membres du Gouvernement sans mandat parlementaire : pas d'identifiant officiel commun ; recherche par le libellé
# ou un autre nom de l'élément (variantes de casse des particules et d'apostrophe : « D’Ornano », « De Guiringaud »).
# Les homonymes sont départagés par les dates : n'est gardée que la personne majeure et vivante au début de sa
# première fonction gouvernementale (Charles de Gaulle : ni l'oncle poète, mort en 1880, ni le petit-fils, né en
# 1948). Le portrait n'est retenu que si une seule personne reste.
REQUETE_NOMS = ("SELECT ?nom ?p ?img ?naissance ?deces WHERE { VALUES ?nom { %s } ?p rdfs:label|skos:altLabel ?nom ; "
                "wdt:P31 wd:Q5 ; wdt:P18 ?img . OPTIONAL { ?p wdt:P569 ?naissance } OPTIONAL { ?p wdt:P570 ?deces } }")
# Garde : pendant une panne, le service de requêtes de Wikidata peut répondre à vide ; un résultat très inférieur
# au précédent n'écrase pas les fichiers existants.
SEUIL_GARDE = 0.9


def variantes(nom):
    v = {nom, nom.replace("’", "'")}
    for x in list(v):
        v.add(re.sub(r"\b(De|Du|Des|D')(?=\s|[A-ZÀ-Ý])", lambda m: m.group(1).lower(), x))
        v.add(re.sub(r"\bD['’]", "d'", x))
    return v


def plausible(naissance, deces, debut):
    """Majeur et vivant au début de la fonction (dates ISO ; naissance inconnue : écarté)."""
    if not naissance or not debut:
        return False
    return int(naissance[:4]) + 18 <= int(debut[:4]) and (not deces or deces[:10] >= debut[:10])


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
            hors = json.load(f)
        vers = {}   # variante du nom -> (identifiant de carte, début de la première fonction)
        for h in hors:
            debut = min((f["debut"] for f in h.get("fonctions", []) if f.get("debut")), default="")
            for v in variantes(h["nom"]):
                vers[v] = (h["id"], debut)
        libelles = list(vers)
        candidats = {}   # identifiant de carte -> {élément Wikidata: fichier}
        for i in range(0, len(libelles), 60):
            valeurs = " ".join('"%s"@fr' % n.replace('"', "") for n in libelles[i:i + 60])
            for b in interroger(REQUETE_NOMS % valeurs):
                ident, debut = vers[b["nom"]["value"]]
                if plausible(b.get("naissance", {}).get("value", ""), b.get("deces", {}).get("value", ""), debut):
                    candidats.setdefault(ident, {}).setdefault(b["p"]["value"], fichier(b["img"]["value"]))
        for ident, elements in candidats.items():
            if len(elements) == 1:
                portraits.setdefault(ident, next(iter(elements.values())))
    ancien = os.path.join("data", "portraits.json")
    if os.path.exists(ancien):
        with open(ancien, encoding="utf-8") as f:
            avant = len(json.load(f))
        if len(portraits) < SEUIL_GARDE * avant:
            raise SystemExit(f"Wikidata incomplet ({len(portraits)} portraits contre {avant}) : fichiers conservés")
    with open(os.path.join("data", "noms_usage.json"), "w", encoding="utf-8") as f:
        json.dump(noms, f, ensure_ascii=False, indent=0)
    with open(os.path.join("data", "portraits.json"), "w", encoding="utf-8") as f:
        json.dump(portraits, f, ensure_ascii=False, indent=0)
    print(f"Portraits : {nb_an} par identifiant officiel, {len(portraits) - nb_an} membres du Gouvernement "
          f"par libellé exact ; noms d'usage : {len(noms)}")


if __name__ == "__main__":
    main()
