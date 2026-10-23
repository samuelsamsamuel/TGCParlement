#!/usr/bin/env python3
"""Distinctions complémentaires : Compagnons de la Libération, Académie française, prix Nobel, Panthéon.

Ces quatre listes officielles (Ordre de la Libération, Académie française, Fondation Nobel, Centre des
monuments nationaux) sont reprises dans Wikidata. On les interroge là, mais le rattachement aux cartes
passe uniquement par les identifiants officiels portés par Wikidata (Sycomore P1045, Sénat P1808) ;
les membres du Gouvernement hors catégorie sont rattachés par leur nom exact s'il ne désigne qu'une
personne de nationalité française. Le rapport liste chaque personne retenue, pour contrôle nominatif.
Sorties : data/listes/{compagnon-liberation,academie-francaise,prix-nobel,pantheon}.json
          data/listes/rapports/distinctions-rapport.txt
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from portraits import interroger  # noqa: E402

IDENTIFIANTS = ("OPTIONAL { ?p wdt:P1045 ?syc } OPTIONAL { ?p wdt:P1808 ?sen } "
                "OPTIONAL { ?p rdfs:label ?libelle FILTER(LANG(?libelle) = 'fr') }")
CRITERES = {
    "compagnon-liberation": (15, "Compagnon de la Libération",
        "VALUES ?dl { 'compagnon de la Libération'@fr 'Compagnon de la Libération'@fr } ?d rdfs:label ?dl . ?p wdt:P166 ?d ."),
    "academie-francaise": (10, "Membre de l'Académie française",
        "?d rdfs:label 'Académie française'@fr . ?p wdt:P463 ?d ."),
    "prix-nobel": (20, "Lauréat du prix Nobel",
        "?p wdt:P166 ?d . ?d wdt:P31|wdt:P279 wd:Q7191 ."),
    "pantheon": (20, "Inhumé au Panthéon",
        "?p wdt:P119 ?d . ?d rdfs:label ?dl . FILTER(STR(?dl) = 'Panthéon' && LANG(?dl) = 'fr') ?d wdt:P131* wd:Q90 ."),
}


# Inhumés puis retirés du Panthéon sous la Révolution : Wikidata garde le lieu d'inhumation initial
RETIRES_DU_PANTHEON = {
    11765: "Mirabeau, retiré du Panthéon en 1794",
    12321: "Marat, retiré du Panthéon en 1795",
    12352: "Le Peletier de Saint-Fargeau, retiré du Panthéon en 1795",
}


def main():
    hors = {}
    f_hors = os.path.join("data", "gouvernement", "hors_parlement.json")
    if os.path.exists(f_hors):
        with open(f_hors, encoding="utf-8") as f:
            hors = {p["nom"]: p["id"] for p in json.load(f)}
    correspondances = {}
    f_corr = os.path.join("data", "senat", "correspondances.json")
    if os.path.exists(f_corr):
        with open(f_corr, encoding="utf-8") as f:
            correspondances = json.load(f)
    rapport = []
    for code, (points, libelle, condition) in CRITERES.items():
        # Trois requêtes courtes plutôt qu'une longue : députés (Sycomore), sénateurs (Sénat), autres personnes
        ids, noms, entites, par_libelle = set(), [], set(), {}
        resultats, echec = [], None
        for filtre in ("?p wdt:P1045 ?syc .", "?p wdt:P1808 ?sen .",
                       "FILTER NOT EXISTS { ?p wdt:P1045 ?x } FILTER NOT EXISTS { ?p wdt:P1808 ?y } ?p wdt:P27 wd:Q142 . "
                       "?p wdt:P39 ?pos . ?pos rdfs:label ?posl . FILTER(LANG(?posl) = 'fr' && (CONTAINS(LCASE(?posl), 'ministre') "
                       "|| CONTAINS(LCASE(?posl), \"secrétaire d'état\") || CONTAINS(LCASE(?posl), 'président de la république')))"):
            requete = ("SELECT DISTINCT ?p ?syc ?sen ?libelle ?d WHERE { %s %s "
                       "OPTIONAL { ?p rdfs:label ?libelle FILTER(LANG(?libelle) = 'fr') } }" % (condition, filtre))
            try:
                resultats += interroger(requete)
            except SystemExit as e:
                echec = e
        if echec and not resultats:
            rapport.append(f"\n{libelle} : NON MISE À JOUR ({echec}) ; la liste précédente est conservée")
            continue
        precedente = set()
        if echec and os.path.exists(os.path.join("data", "listes", code + ".json")):
            with open(os.path.join("data", "listes", code + ".json"), encoding="utf-8") as f:
                precedente = set(json.load(f)["ids"])
        for b in resultats:
            entites.add(b["d"]["value"].rsplit("/", 1)[-1])
            nom = b.get("libelle", {}).get("value", "?")
            if "syc" in b and b["syc"]["value"].isdigit():
                ids.add(int(b["syc"]["value"])); noms.append(f"{nom} (Sycomore {b['syc']['value']})")
            elif "sen" in b:
                mat = b["sen"]["value"][-6:].upper()
                ids.add(correspondances.get(mat, "S" + mat)); noms.append(f"{nom} (Sénat {b['sen']['value']})")
            if "libelle" in b and b["libelle"]["value"] in hors and "syc" not in b and "sen" not in b:
                par_libelle.setdefault(b["libelle"]["value"], set()).add(b["p"]["value"])
        for nom, personnes in par_libelle.items():
            if len(personnes) == 1:  # un seul élément de ce nom : même personne que la carte hors catégorie
                ids.add(hors[nom]); noms.append(f"{nom} (membre du Gouvernement, par le nom)")
        if precedente:
            ids |= precedente  # une requête a échoué : les rattachements précédents sont conservés
            noms.append(f"(requête partielle : {len(precedente)} rattachements précédents conservés)")
        if code == "pantheon":
            for ident, motif in RETIRES_DU_PANTHEON.items():
                if ident in ids:
                    ids.discard(ident)
                    noms.append(f"retiré : {motif}")
        with open(os.path.join("data", "listes", code + ".json"), "w", encoding="utf-8") as f:
            json.dump({"code": code, "points": points, "plancher": None, "libelle": libelle,
                       "source": "Wikidata, reprenant la liste officielle ; rattachement par identifiant Sycomore ou Sénat",
                       "ids": sorted(ids, key=str)}, f, ensure_ascii=False, indent=1)
        rapport.append(f"\n{libelle} : {len(ids)} cartes (éléments Wikidata de la distinction : {', '.join(sorted(entites)[:8])}"
                       + (" …" if len(entites) > 8 else "") + ")")
        rapport += ["  " + n for n in sorted(set(noms))]
    os.makedirs(os.path.join("data", "listes", "rapports"), exist_ok=True)
    with open(os.path.join("data", "listes", "rapports", "distinctions-rapport.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(rapport).strip() + "\n")
    print("\n".join(l for l in rapport if not l.startswith("  ")))


if __name__ == "__main__":
    main()
