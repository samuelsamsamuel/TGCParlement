#!/usr/bin/env python3
"""Mise en forme des fiches Sycomore en cartes, calcul des scores et des raretés.

Entrée  : data/sycomore/fiches.jsonl (texte brut produit par sycomore.py)
          data/listes/*.json (listes fermées, facultatives, voir plus bas)
Sorties : data/cartes.json   (une carte par parlementaire)
          data/controle.txt  (comptages et anomalies, à lire avant toute correction)

Format d'une liste fermée (un fichier par critère) :
  {"code": "pleins-pouvoirs-1940", "libelle": "...", "points": 20,
   "source": "référence officielle", "plancher": null, "ids": [12345, ...]}
"plancher" vaut null ou un niveau de rareté minimal ("rare").

Bibliothèque standard de Python uniquement.
"""
import glob
import json
import os
import re
from collections import Counter, defaultdict
from datetime import date

F_FICHES = os.path.join("data", "sycomore", "fiches.jsonl")
F_SENATEURS = os.path.join("data", "senat", "senateurs.json")
F_CARTES = os.path.join("data", "cartes.json")
F_CONTROLE = os.path.join("data", "controle.txt")
DOSSIER_LISTES = os.path.join("data", "listes")
AN = "Mandats à l'Assemblée nationale ou à la Chambre des députés"
SENAT = "Mandats au Sénat ou à la Chambre des pairs"
AUJOURDHUI = date.today()

# Grille arbitrée : critères calculables directement depuis Sycomore.
PTS_PAR_AN, PLAFOND_ANS = 1, 30
PTS_DEUX_CHAMBRES = 5
PTS_1789 = 10          # États généraux ou Constituante de 1789
PTS_CONVENTION = 10
PTS_FEMMES_1945 = 20
# Niveaux par rang : part cumulée des cartes, de la plus haute à la plus basse.
NIVEAUX = [("legendaire", 0.03), ("epique", 0.10), ("rare", 0.25),
           ("peu-commune", 0.50), ("commune", 1.00)]
ORDRE = [n for n, _ in NIVEAUX]

MOIS = {m: i + 1 for i, m in enumerate(
    ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
     "août", "septembre", "octobre", "novembre", "décembre"])}
RE_DATE = re.compile(r"(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})", re.I)
anomalies = defaultdict(list)


def lire_date(texte):
    m = RE_DATE.search(texte or "")
    if not m or m.group(2).lower() not in MOIS:
        return None
    try:
        return date(int(m.group(3)), MOIS[m.group(2).lower()], int(m.group(1)))
    except ValueError:
        return None


def periode(texte, ident):
    """« Du X au Y », « du X au Y » ou « Depuis le X (mandat en cours) »."""
    t = texte.strip()
    if t.lower().startswith("depuis"):
        debut = lire_date(t)
        return (debut, None) if debut else None
    parties = re.split(r"\s+au\s+", t, maxsplit=1)
    if len(parties) == 2:
        debut, fin = lire_date(parties[0]), lire_date(parties[1])
        if debut and fin:
            return debut, fin
    anomalies["periode illisible"].append(f"{ident} : {t}")
    return None


# --- Lecture d'une fiche ------------------------------------------------------

LIBELLES = {"Régime politique": "regime", "Législature": "legislature",
            "Mandat": "periode", "Département": "departement", "Groupe": "groupe"}


def mandats_an(lignes, ident):
    mandats, courant, champ = [], None, None
    for x in lignes:
        if x == "Régime politique":
            courant = {}
            mandats.append(courant)
        if x in LIBELLES:
            champ = LIBELLES[x]
            continue
        if courant is None or champ is None:
            continue
        courant[champ] = (courant.get(champ, "") + " " + x).strip()
    sortie = []
    for m in mandats:
        if not m.get("regime"):
            anomalies["mandat sans régime"].append(f"{ident} : {m}")
        p = periode(m.get("periode", ""), ident)
        sortie.append({"_declare_en_cours": "en cours" in m.get("periode", "").lower(),
                       "chambre": "AN", "regime": m.get("regime"),
                       "legislature": m.get("legislature"),
                       "departement": m.get("departement"), "groupe": m.get("groupe"),
                       "debut": p[0].isoformat() if p else None,
                       "fin": p[1].isoformat() if p and p[1] else None,
                       "en_cours": bool(p and p[1] is None)})
    return sortie


def mandats_senat(lignes, ident):
    sortie, fonction = [], None
    for x in lignes:
        if re.match(r"(du|depuis)\s", x, re.I):
            p = periode(x, ident)
            sortie.append({"_declare_en_cours": "en cours" in x.lower(),
                           "chambre": "Sénat", "fonction": fonction,
                           "debut": p[0].isoformat() if p else None,
                           "fin": p[1].isoformat() if p and p[1] else None,
                           "en_cours": bool(p and p[1] is None)})
        else:
            fonction = x
    return sortie


def etat_civil(lignes):
    """Sexe, naissance et décès, tels qu'énoncés par la fiche."""
    texte = " | ".join(lignes)
    texte = re.sub(r"(Décédée?) le \| ", r"\1 le ", texte)
    sexe = "F" if re.search(r"\bNée le\b", texte) else ("M" if re.search(r"\bNé le\b", texte) else None)
    naissance = re.search(r"Née? le ([^|]+)", texte)
    deces = re.search(r"Décédée? le ([^|]+)", texte)

    def decoupe(m):
        if not m:
            return None, None
        brut = m.group(1).strip()
        lieu = re.split(r"\s+à\s+", brut, maxsplit=1)
        d = lire_date(lieu[0])
        return (d.isoformat() if d else None), (lieu[1].strip() if len(lieu) == 2 else None)

    n_date, n_lieu = decoupe(naissance)
    d_date, _ = decoupe(deces)
    return sexe, n_date, n_lieu, d_date


def duree_jours(mandats):
    """Jours de mandat, intervalles chevauchants fusionnés."""
    iv = sorted((date.fromisoformat(m["debut"]),
                 date.fromisoformat(m["fin"]) if m["fin"] else AUJOURDHUI)
                for m in mandats if m["debut"] and (m["fin"] or m["en_cours"]))
    total, cour = 0, None
    for d, f in iv:
        if cour and d <= cour[1]:
            cour = (cour[0], max(cour[1], f))
        else:
            if cour:
                total += (cour[1] - cour[0]).days
            cour = (d, f)
    if cour:
        total += (cour[1] - cour[0]).days
    return total


PARTICULES = {"de", "du", "des", "la", "le", "les", "d", "l", "dit", "ou"}


def noms_cles(nom):
    import unicodedata
    t = unicodedata.normalize("NFKD", nom or "").encode("ascii", "ignore").decode().lower()
    return set(w for w in re.findall(r"[a-z]+", t) if w not in PARTICULES)


def cartes_senateurs(cartes, listes):
    """Cartes des sénateurs absents de Sycomore (jamais députés), d'après l'open data du Sénat.
    Un sénateur est réputé déjà présent si une fiche Sycomore porte un nom commun et la même
    date de naissance (ou, à défaut de date identique, la même année, signalée en anomalie)."""
    if not os.path.exists(F_SENATEURS):
        anomalies["base des sénateurs absente"].append(F_SENATEURS)
        return []
    with open(F_SENATEURS, encoding="utf-8") as f:
        senateurs = json.load(f)
    par_date, par_annee = defaultdict(list), defaultdict(list)
    for c in cartes:
        if c["naissance"]:
            par_date[c["naissance"]].append(c)
            par_annee[c["naissance"][:4]].append(c)
    nouvelles = []
    for s in senateurs:
        # Rapprochement sur le nom de famille entier (tous ses mots), jamais sur les prénoms
        cles = noms_cles(s.get("nom_famille") or s["nom"])
        if s["naissance"] and any(cles <= noms_cles(c["nom"]) for c in par_date[s["naissance"]]):
            continue
        proches = [c for c in par_annee[(s["naissance"] or "")[:4]] if cles and cles <= noms_cles(c["nom"])]
        if s["naissance"] and proches:
            anomalies["sénateur rapproché d'une fiche Sycomore par l'année seule"].append(
                f"{s['matricule']} {s['nom']} ({s['naissance']}) -> {proches[0]['id']} {proches[0]['nom']} ({proches[0]['naissance']})")
            continue
        mandats = []
        for m in s["mandats"]:
            if not m["debut"]:
                continue
            fin = m["fin"]
            en_cours = s["etat"] == "ACTIF" and (not fin or fin > AUJOURDHUI.isoformat())
            mandats.append({"chambre": "Sénat",
                            "fonction": ("Sénatrice" if s["sexe"] == "F" else "Sénateur")
                                        + (f" ({s['circonscription']})" if s["circonscription"] else ""),
                            "debut": m["debut"], "fin": None if en_cours else fin, "en_cours": en_cours})
        if not mandats:
            anomalies["sénateur sans mandat daté"].append(f"{s['matricule']} {s['nom']}")
            continue
        ident = "S" + s["matricule"]
        jours = duree_jours(mandats)
        annees = round(jours / 365.25, 1)
        distinctions = [{"code": l["code"], "points": l["points"], "libelle": l["libelle"],
                         "plancher": l.get("plancher")} for l in listes if ident in l["ids"]]
        carte = {"id": ident, "nom": s["nom"], "sexe": s["sexe"], "naissance": s["naissance"],
                 "lieu_naissance": None, "deces": s["deces"], "annees_mandat": annees,
                 "mandats": mandats, "distinctions": distinctions,
                 "score": round(min(annees, PLAFOND_ANS) * PTS_PAR_AN + sum(d["points"] for d in distinctions), 1),
                 "source": f"https://data.senat.fr/les-senateurs/ (matricule {s['matricule']})"}
        carte["texte"] = texte_carte(carte)
        nouvelles.append(carte)
    return nouvelles


# --- Texte de la carte --------------------------------------------------------

def annee(iso):
    return iso[:4] if iso else "?"


def texte_carte(c):
    an = [m for m in c["mandats"] if m["chambre"] == "AN"]
    se = [m for m in c["mandats"] if m["chambre"] == "Sénat"]
    f = c["sexe"] == "F"
    phrases = []
    if an:
        deps = list(dict.fromkeys(m["departement"] for m in an if m["departement"]))
        regimes = list(dict.fromkeys(m["regime"] for m in an if m["regime"]))
        debut = min((m["debut"] for m in an if m["debut"]), default=None)
        fins = [m["fin"] for m in an if m["fin"]]
        fin = "aujourd'hui" if any(m["en_cours"] for m in an) else annee(max(fins) if fins else None)
        n = len(an)
        phrases.append(
            f"{'Députée' if f else 'Député'}{(' (' + ', '.join(deps) + ')') if deps else ''} "
            f"de {annee(debut)} à {fin}, {n} mandat{'s' if n > 1 else ''} "
            f"({' ; '.join(regimes)}).".replace("  ", " "))
    if se:
        debut = min((m["debut"] for m in se if m["debut"]), default=None)
        fins = [m["fin"] for m in se if m["fin"]]
        fin = "aujourd'hui" if any(m["en_cours"] for m in se) else annee(max(fins) if fins else None)
        fonctions = list(dict.fromkeys(m["fonction"] for m in se if m["fonction"]))
        phrases.append(f"{' et '.join(fonctions) or 'Membre de la chambre haute'} de {annee(debut)} à {fin}.")
    for d in c["distinctions"]:
        phrases.append(d["libelle"] + ".")
    return " ".join(phrases)


# --- Programme principal ------------------------------------------------------

def charger_listes():
    listes = []
    for chemin in sorted(glob.glob(os.path.join(DOSSIER_LISTES, "*.json"))):
        with open(chemin, encoding="utf-8") as f:
            l = json.load(f)
        if not isinstance(l, dict) or "ids" not in l or "code" not in l:
            continue  # fichiers de travail du même dossier (décisions...), sans liste d'identifiants
        l["ids"] = set(l["ids"])
        listes.append(l)
        print(f"Liste fermée chargée : {l['code']} ({len(l['ids'])} identifiants)")
    return listes


def main():
    listes = charger_listes()
    cartes, comptes, statuts = [], Counter(), Counter()
    with open(F_FICHES, encoding="utf-8") as f:
        for ligne in f:
            r = json.loads(ligne)
            statuts[r["statut"]] += 1
            if r["statut"] != 200:
                continue
            ident, s = r["id"], r.get("sections", {})
            mandats = mandats_an(s.get(AN, []), ident) + mandats_senat(s.get(SENAT, []), ident)
            if not mandats:
                anomalies["aucun mandat"].append(str(ident))
            sexe, n_date, n_lieu, d_date = etat_civil(s.get("general", []))
            if sexe is None:
                anomalies["sexe non déterminé"].append(str(ident))
            for m in mandats:
                declare = m.pop("_declare_en_cours")
                if m["debut"] and not m["fin"] and (d_date or not declare):
                    # Fin absente : ni mandat déclaré en cours, ni titulaire vivant.
                    m["en_cours"] = False
                    m["fin_inconnue"] = True
                    anomalies["fin de mandat inconnue (exclue de la durée)"].append(
                        f"{ident} : {m.get('regime')} | {m.get('legislature')} | depuis {m['debut']}")
                if m["chambre"] == "AN":
                    comptes[(m["regime"], m["legislature"])] += 1

            # Critères calculés
            jours = duree_jours(mandats)
            annees = round(jours / 365.25, 1)
            distinctions = []
            an = [m for m in mandats if m["chambre"] == "AN"]
            if an and any(m["chambre"] == "Sénat" for m in mandats):
                distinctions.append({"code": "deux-chambres", "points": PTS_DEUX_CHAMBRES,
                                     "libelle": "A siégé dans les deux chambres"})
            if any("constituante" in (m["legislature"] or "").lower() and (m["debut"] or "")[:4] in ("1789", "1790")
                   for m in an) or any("états généraux" in (m["regime"] or "").lower() for m in an):
                distinctions.append({"code": "1789", "points": PTS_1789,
                                     "libelle": "Membre des États généraux ou de la Constituante de 1789"})
            if any("convention" in (m["legislature"] or "").lower() for m in an):
                distinctions.append({"code": "convention", "points": PTS_CONVENTION,
                                     "libelle": "Membre de la Convention nationale"})
            if sexe == "F" and any((m["debut"] or "")[:4] == "1945" for m in an):
                distinctions.append({"code": "femmes-1945", "points": PTS_FEMMES_1945,
                                     "libelle": "Parmi les premières femmes élues députées, en 1945"})
            for l in listes:
                if ident in l["ids"]:
                    distinctions.append({"code": l["code"], "points": l["points"],
                                         "libelle": l["libelle"], "plancher": l.get("plancher")})

            score = min(annees, PLAFOND_ANS) * PTS_PAR_AN + sum(d["points"] for d in distinctions)
            carte = {"id": ident, "nom": r.get("nom"), "sexe": sexe,
                     "naissance": n_date, "lieu_naissance": n_lieu, "deces": d_date,
                     "annees_mandat": annees, "mandats": mandats,
                     "distinctions": distinctions, "score": round(score, 1),
                     "source": f"https://www2.assemblee-nationale.fr/sycomore/fiche/{ident}"}
            carte["texte"] = texte_carte(carte)
            cartes.append(carte)

    senateurs = cartes_senateurs(cartes, listes)
    cartes.extend(senateurs)

    # Rareté par rang, puis planchers éventuels
    cartes.sort(key=lambda c: (-c["score"], str(c["id"])))
    total = len(cartes)
    for rang, c in enumerate(cartes):
        part = (rang + 1) / total if total else 1
        c["rarete"] = next(n for n, seuil in NIVEAUX if part <= seuil)
        for d in c["distinctions"]:
            p = d.get("plancher")
            if p and ORDRE.index(p) < ORDRE.index(c["rarete"]):
                c["rarete"] = p

    os.makedirs("data", exist_ok=True)
    with open(F_CARTES, "w", encoding="utf-8") as f:
        json.dump(cartes, f, ensure_ascii=False, separators=(",", ":"))

    # Contrôle
    dist = Counter(d["code"] for c in cartes for d in c["distinctions"])
    rar = Counter(c["rarete"] for c in cartes)
    with open(F_CONTROLE, "w", encoding="utf-8") as f:
        f.write(f"Fiches lues : {dict(statuts)} ; cartes produites : {total}, "
                f"dont {len(senateurs)} sénateurs absents de Sycomore\n\n")
        f.write("Distinctions calculées :\n")
        for k, v in dist.most_common():
            f.write(f"  {k} : {v}\n")
        f.write("\nRépartition des raretés :\n")
        for n in ORDRE:
            f.write(f"  {n} : {rar[n]}\n")
        f.write("\nMandats de député par régime et législature :\n")
        for (reg, leg), v in sorted(comptes.items(), key=lambda x: (str(x[0][0]), str(x[0][1]))):
            f.write(f"  {reg} | {leg} : {v}\n")
        f.write("\nAnomalies :\n")
        for k, v in anomalies.items():
            f.write(f"  {k} : {len(v)}\n")
            for e in v[:20]:
                f.write(f"    {e}\n")
        f.write("\nDix premières cartes :\n")
        for c in cartes[:10]:
            f.write(f"  {c['score']:6.1f}  {c['rarete']:<11} {c['nom']} : {c['texte']}\n")
    print(open(F_CONTROLE, encoding="utf-8").read())


if __name__ == "__main__":
    main()
