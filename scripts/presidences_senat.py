#!/usr/bin/env python3
"""Liste fermée des présidences de la seconde chambre (Chambre des pairs, Sénat, Conseil de la République).

Source : liste officielle du Sénat, transcrite avec ses dates dans data/sources/presidents-senat.json.
Rattachement : nom concordant ET années de naissance et de décès identiques à celles de la fiche Sycomore.
Seuls les présidents ayant aussi été députés ont une fiche Sycomore ; les autres sont listés à part,
en attente de l'intégration de la base des sénateurs.

Sorties (propositions, à valider avant usage) :
  data/listes/proposees/presidence-senat-longue.json
  data/listes/proposees/presidence-senat-courte.json
  data/listes/proposees/presidences-senat-rapport.txt
Bibliothèque standard uniquement.
"""
import json
import os
import sys
from collections import defaultdict
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from cartes import lire_date  # noqa: E402
from presidences import jetons, nom_coupe  # noqa: E402

F_SOURCE = os.path.join("data", "sources", "presidents-senat.json")
F_DECISIONS = os.path.join("data", "listes", "decisions-presidences-senat.json")
SORTIE = os.path.join("data", "listes", "proposees")


def main():
    with open(F_SOURCE, encoding="utf-8") as f:
        source = json.load(f)
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    par_id = {c["id"]: c for c in cartes}
    index = defaultdict(list)
    for c in cartes:
        for j in set(jetons(c["nom"] or "")):
            index[j].append(c)
    decisions = {}
    if os.path.exists(F_DECISIONS):
        with open(F_DECISIONS, encoding="utf-8") as f:
            decisions = {d["ligne"]: d for d in json.load(f)["decisions"] if not d.get("a_decider")}

    rapport, sans_fiche = [], []
    periodes, noms, alertes = defaultdict(list), {}, defaultdict(set)
    for l in source["lignes"]:
        nom, cle = l["nom"], f"{l['du']} | {l['nom']}"
        annuel = l["du"].isdigit()
        if annuel:
            d, f = date(int(l["du"]), 1, 1), date(int(l["au"]), 12, 31)
        else:
            d = lire_date(l["du"])
            f = date.today() if l["au"] == "en cours" else lire_date(l["au"])
        if not d or not f:
            rapport.append(f"DATE ILLISIBLE : {cle}")
            continue

        if cle in decisions:
            dec = decisions[cle]
            if dec.get("id") is None:
                rapport.append(f"EXCLU PAR DÉCISION ({dec.get('motif', '')}) : {cle}")
                continue
            carte = par_id.get(dec["id"])
            alertes[dec["id"]].add("DÉCISION : " + dec.get("motif", ""))
        else:
            cles = set(jetons(nom)[-1:]) | set(jetons(nom_coupe(nom) or "")[-1:])
            candidats = {c["id"]: c for k in cles for c in index.get(k, [])}
            retenus = [c for c in candidats.values()
                       if (c.get("naissance") or "")[:4] == str(l["naissance"])
                       and (l["deces"] is None or (c.get("deces") or "")[:4] == str(l["deces"]))]
            if len(retenus) > 1:
                rapport.append(f"AMBIGU : {cle} : " + " / ".join(f"{c['id']} {c['nom']}" for c in retenus))
                continue
            if not retenus:
                sans_fiche.append(f"{cle} ({l['naissance']}-{l['deces'] or ''}, {l['chambre']})")
                continue
            carte = retenus[0]
        periodes[carte["id"]].append((d, f, annuel))
        noms[carte["id"]] = (nom, carte["nom"])

    longue, courte = [], []
    rapport.append("\nRattachements (nom et années de naissance et de décès concordants) :")
    for ident, ps in sorted(periodes.items()):
        jours = sum((f - d).days for d, f, a in ps if not a)
        annees_pleines = any(a and f.year - d.year >= 2 for d, f, a in ps)
        (longue if jours >= 365 or annees_pleines else courte).append(ident)
        officiel, fiche = noms[ident]
        rapport.append(f"  {ident:6d}  {jours:6d} j  {officiel}  ->  {fiche}"
                       + "".join(f"  [{a}]" for a in sorted(alertes[ident])))
    rapport.append(f"\nSans fiche Sycomore (jamais députés), en attente de la base des sénateurs : {len(sans_fiche)}")
    rapport.extend("  " + s for s in sans_fiche)
    rapport.insert(0, f"Présidents rattachés : {len(periodes)} ({len(longue)} au moins un an, "
                      f"{len(courte)} moins d'un an) ; sans fiche : {len(sans_fiche)}")

    os.makedirs(SORTIE, exist_ok=True)
    for code, pts, plancher, libelle, ids in (
            ("presidence-senat-longue", 40, "rare", "A présidé la seconde chambre au moins un an", longue),
            ("presidence-senat-courte", 15, None, "A présidé la seconde chambre", courte)):
        with open(os.path.join(SORTIE, code + ".json"), "w", encoding="utf-8") as f:
            json.dump({"code": code, "points": pts, "plancher": plancher, "libelle": libelle,
                       "source": source["url"], "ids": ids}, f, ensure_ascii=False, indent=1)
    texte = "\n".join(rapport)
    with open(os.path.join(SORTIE, "presidences-senat-rapport.txt"), "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    print(texte)


if __name__ == "__main__":
    main()
