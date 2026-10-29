#!/usr/bin/env python3
"""Appartenances aux commissions permanentes, pour le détail des cartes et le futur jeu du Gouvernement.

Sources officielles, déjà lues par la chaîne pour les présidences :
- Sénat (data.senat.fr) : ODSEN_COMS.csv, appartenances courantes et historiques aux commissions, depuis 1959
  (« Début d'appartenance », « Fin d'appartenance ») ; seules les commissions permanentes sont retenues.
- Assemblée nationale (data.assemblee-nationale.fr) : historique AMO30, mandats d'organe de type COMPER (commission
  permanente), depuis la XIIe législature (juin 2002), toutes qualités (membre, secrétaire, président…).
Mesure (octobre 2026) : 6 549 appartenances du Sénat (2 011 sénateurs), 26 031 mandats COMPER de l'Assemblée (2 100 députés).

Rattachement aux cartes : matricule du Sénat -> carte par data/senat/correspondances.json (écrit par cartes.py) ;
Assemblée : même date de naissance et même nom de famille (tous ses mots), comme gouvernements_an.py.
Les périodes d'une même commission qui se suivent (moins de 31 jours d'écart, renouvellements annuels) sont fusionnées.

Familles (`FAMILLES`) : chaque commission est rattachée au domaine qu'elle suit, d'après son intitulé officiel, pour
les thèmes du jeu. Une commission aux attributions mixtes appartient à plusieurs familles (décision intégrée,
`DECISION_FAMILLES`).

Sortie : data/gouvernement/commissions.json ({carte: [{commission, familles, chambre, debut, fin}]}),
data/listes/rapports/commissions-rapport.txt
"""
import datetime
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from senateurs import telecharger as telecharger_senat  # noqa: E402
from gouvernements_an import ADRESSES, norme, telecharger as telecharger_an, texte  # noqa: E402

SORTIE = os.path.join("data", "gouvernement", "commissions.json")
RAPPORT = os.path.join("data", "listes", "rapports", "commissions-rapport.txt")
ECART_FUSION = 31  # jours : renouvellements successifs d'une même appartenance

# Mots de l'intitulé officiel -> familles. Ordre sans importance : une commission reçoit toutes les familles dont un
# motif figure dans son intitulé.
FAMILLES = [
    ("lois", r"\blois\b"),
    ("finances", r"\bfinances\b"),
    ("affaires-etrangeres", r"affaires etrangeres"),
    ("defense", r"defense|forces armees"),
    ("affaires-sociales", r"affaires sociales|familiales et sociales"),
    ("culture-education", r"\bculture\b|affaires culturelles|education"),
    ("economie", r"affaires economiques|\beconomie\b|production et (des )?echanges"),
    ("territoires", r"developpement durable|amenagement du territoire|\benvironnement\b"),
]
DECISION_FAMILLES = (
    "Les commissions aux attributions mixtes reçoivent chaque famille nommée dans leur intitulé officiel : la commission "
    "des affaires étrangères du Sénat, qui suit aussi la défense (« affaires étrangères, défense et forces armées »), "
    "n'a dans l'export du Sénat que l'intitulé court « commission des affaires étrangères » et reçoit donc aussi la "
    "famille défense ; à l'Assemblée, la commission des affaires culturelles, familiales et sociales (2002-2009) relève "
    "de la culture et des affaires sociales, celle des affaires économiques, de l'environnement et du territoire "
    "(2002-2009) de l'économie et des territoires.")


def familles(intitule, chambre):
    n = norme(intitule)
    f = [code for code, motif in FAMILLES if re.search(motif, n)]
    if chambre == "Sénat" and "affaires-etrangeres" in f and "defense" not in f:
        f.append("defense")
    return f


def iso(v):
    v = (v or "").strip()[:10]
    return v if re.match(r"\d{4}-\d{2}-\d{2}$", v) else None


def fusionner(periodes):
    """Périodes d'une même commission : fusion de celles qui se suivent ou se chevauchent."""
    jour = lambda d: datetime.date.fromisoformat(d)
    sortie = []
    for p in sorted(periodes, key=lambda x: x["debut"] or ""):
        if sortie and sortie[-1]["fin"] is not None and p["debut"] and \
                (jour(p["debut"]) - jour(sortie[-1]["fin"])).days <= ECART_FUSION:
            s = sortie[-1]
            s["fin"] = None if p["fin"] is None else max(s["fin"], p["fin"])
        elif sortie and sortie[-1]["fin"] is None:
            continue  # déjà en cours : la période suivante y est contenue
        else:
            sortie.append(dict(p))
    return sortie


def senat(rapport, carte_de):
    lignes = telecharger_senat("ODSEN_COMS.csv")
    if not lignes:
        rapport.append("Sénat : ODSEN_COMS.csv vide")
        return []
    l0 = lignes[0]
    attendues = ("Matricule", "Nom commission", "Type commission", "Début d'appartenance", "Fin d'appartenance")
    manquantes = [c for c in attendues if c not in l0]
    rapport.append(f"Sénat : ODSEN_COMS.csv, {len(lignes)} lignes ; colonnes : {' | '.join(l0.keys())}")
    if manquantes:
        rapport.append(f"  colonnes absentes : {manquantes} ; rien n'est lu")
        return []
    trouvees, vues, sans_carte = [], set(), set()
    for l in lignes:
        if "permanente" not in norme(l.get("Type commission")):
            continue
        intitule = (l.get("Nom commission") or "").strip()
        if not intitule or norme(intitule) == "aucune":
            continue
        cle = (l["Matricule"], intitule, l.get("Début d'appartenance"), l.get("Fin d'appartenance"))
        if cle in vues:
            continue  # une ligne par fonction occupée dans la même appartenance
        vues.add(cle)
        carte = carte_de.get(l["Matricule"].strip())
        if not carte:
            sans_carte.add(l["Matricule"])
            continue
        trouvees.append((str(carte), intitule[:1].upper() + intitule[1:], "Sénat",
                         iso(l.get("Début d'appartenance")), iso(l.get("Fin d'appartenance"))))
    rapport.append(f"  appartenances retenues : {len(trouvees)} ; matricules sans carte : {len(sans_carte)}")
    return trouvees


def assemblee(rapport, cartes):
    brut = telecharger_an(rapport, ADRESSES[:1])
    if not brut:
        rapport.append("Assemblée : historique AMO30 indisponible")
        return []
    mots = lambda t: set(re.findall(r"[a-z]+", norme(t))) - {"de", "du", "des", "la", "le", "d", "l"}
    par_date = defaultdict(list)
    for c in cartes:
        if c.get("naissance"):
            par_date[c["naissance"]].append(c)
    trouvees, orphelins, qualites = [], set(), Counter()
    with zipfile.ZipFile(io.BytesIO(brut)) as z:
        organes = {}
        for nom in z.namelist():
            if "/organe/" in nom and nom.endswith(".json"):
                o = json.load(z.open(nom))["organe"]
                organes[texte(o.get("uid"))] = texte(o.get("libelle"))
        for nom in z.namelist():
            if "/acteur/" not in nom or not nom.endswith(".json"):
                continue
            a = json.load(z.open(nom))["acteur"]
            ident = a["etatCivil"]["ident"]
            naissance = texte((a["etatCivil"].get("infoNaissance") or {}).get("dateNais"))[:10]
            mandats = a.get("mandats", {}).get("mandat", [])
            mandats = [mandats] if isinstance(mandats, dict) else mandats
            comper = [m for m in mandats if m.get("typeOrgane") == "COMPER"]
            if not comper:
                continue
            candidats = [c for c in par_date.get(naissance, []) if mots(ident.get("nom")) and mots(ident.get("nom")) <= mots(c["nom"])]
            if len(candidats) != 1:
                orphelins.add(f"{ident.get('prenom')} {ident.get('nom')} ({naissance})")
                continue
            for m in comper:
                ref = (m.get("organes") or {}).get("organeRef")
                ref = ref[0] if isinstance(ref, list) else ref
                intitule = organes.get(texte(ref), "").strip()
                if not intitule:
                    continue
                qualites[texte((m.get("infosQualite") or {}).get("codeQualite"))] += 1
                trouvees.append((str(candidats[0]["id"]), intitule, "Assemblée",
                                 texte(m.get("dateDebut"))[:10] or None, texte(m.get("dateFin"))[:10] or None))
    rapport.append(f"Assemblée : mandats COMPER retenus {len(trouvees)} ; qualités : "
                   + ", ".join(f"{q or '—'} ({n})" for q, n in qualites.most_common()))
    rapport.append(f"  députés non rattachés à une carte : {len(orphelins)}")
    rapport += ["    " + o for o in sorted(orphelins)[:40]]
    return trouvees


def main():
    rapport = [DECISION_FAMILLES, ""]
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    with open(os.path.join("data", "senat", "correspondances.json"), encoding="utf-8") as f:
        carte_de = json.load(f)
    lues = senat(rapport, carte_de) + assemblee(rapport, cartes)
    if not lues:
        rapport.append("Aucune appartenance lue : fichier précédent gardé")
        ecrire_rapport(rapport)
        return
    par_carte = defaultdict(lambda: defaultdict(list))
    for carte, intitule, chambre, debut, fin in lues:
        if debut:
            par_carte[carte][(intitule, chambre)].append({"debut": debut, "fin": fin})
    sortie, intitules, sans_famille = {}, Counter(), set()
    for carte, groupes in par_carte.items():
        liste = []
        for (intitule, chambre), periodes in groupes.items():
            f = familles(intitule, chambre)
            if not f:
                sans_famille.add(intitule)
            intitules[(chambre, intitule, tuple(f))] += 1
            for p in fusionner(periodes):
                liste.append({"commission": intitule, "familles": f, "chambre": chambre, "debut": p["debut"], "fin": p["fin"]})
        sortie[carte] = sorted(liste, key=lambda x: x["debut"])
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(sortie, f, ensure_ascii=False, indent=0)
    rapport.insert(0, f"Cartes avec au moins une commission : {len(sortie)} ; périodes après fusion : "
                      f"{sum(len(v) for v in sortie.values())}")
    rapport += ["", "Intitulés (chambre, cartes, familles) :"]
    rapport += [f"  {ch} : {i} ({n}) -> {', '.join(f) or 'aucune famille'}" for (ch, i, f), n in sorted(intitules.items())]
    if sans_famille:
        rapport += ["", "Sans famille : " + " ; ".join(sorted(sans_famille))]
    ecrire_rapport(rapport)
    print(rapport[0])


def ecrire_rapport(rapport):
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")


if __name__ == "__main__":
    main()
