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
F_HORS_PARLEMENT = os.path.join("data", "gouvernement", "hors_parlement.json")
F_CARTES = os.path.join("data", "cartes.json")
F_CONTROLE = os.path.join("data", "controle.txt")
DOSSIER_LISTES = os.path.join("data", "listes")
AN = "Mandats à l'Assemblée nationale ou à la Chambre des députés"
SENAT = "Mandats au Sénat ou à la Chambre des pairs"
AUJOURDHUI = date.today()

# Grille arbitrée : critères calculables directement depuis Sycomore.
PTS_PAR_AN, PLAFOND_ANS = 1, 30

# --- Grille équilibrée -------------------------------------------------------------------------
# Durée : 1 point par année jusqu'à 20 ans, puis 0,5 point par année jusqu'à 40 ans (30 points au
# plus) : les très longues carrières restent distinguées sans écraser le reste du classement.
# Familles de fonctions : dans chacune, la fonction la plus haute compte en entier et les autres
# pour un quart seulement, afin qu'un même parcours ne soit pas payé plusieurs fois.
# Présidences : la meilleure compte en entier ; avoir présidé les deux chambres ajoute 10 points.
FAMILLES = {
    "executif": ["chef-etat", "chef-gouvernement", "chef-etat-interim", "ministre", "secretaire-etat"],
    "assemblee": ["presidence-commission", "rapporteur-general", "presidence-groupe", "bureau-vp-questeur", "bureau-secretaire"],
    "presidence": ["presidence-an-longue", "presidence-senat-longue", "presidence-an-courte", "presidence-senat-courte"],
}
PART_SECONDAIRE = 0.25
BONUS_DEUX_PRESIDENCES = 10


def points_duree(annees):
    return min(annees, 20) + 0.5 * max(0, min(annees, 40) - 20)


def score_carte(annees, distinctions):
    """Score selon la grille équilibrée ; chaque distinction reçoit ses points effectifs."""
    famille_de = {code: f for f, codes in FAMILLES.items() for code in codes}
    par_famille = defaultdict(list)
    total = points_duree(annees)
    for d in distinctions:
        f = famille_de.get(d["code"])
        if f:
            par_famille[f].append(d)
        else:
            d["points_effectifs"] = d["points"]
            total += d["points"]
    for f, ds in par_famille.items():
        ds.sort(key=lambda d: -d["points"])
        for i, d in enumerate(ds):
            d["points_effectifs"] = d["points"] if i == 0 else round(d["points"] * PART_SECONDAIRE, 2)
            if f == "presidence" and i > 0:
                d["points_effectifs"] = 0
            total += d["points_effectifs"]
        if f == "presidence":
            chambres = {("an" if "-an-" in d["code"] else "senat") for d in ds}
            if len(chambres) == 2:
                total += BONUS_DEUX_PRESIDENCES
    return round(total, 1)
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


EPOQUES = [(1814, "Révolution et Empire"), (1848, "Monarchies constitutionnelles"), (1870, "IIe République et Second Empire"),
           (1940, "IIIe République"), (1958, "Libération et IVe République"), (9999, "Ve République")]


def epoque(c):
    debuts = [m["debut"] for m in c.get("mandats", []) if m.get("debut")]
    if not debuts:
        return EPOQUES[-1][1]
    annee = int(min(debuts)[:4])
    return next(nom for borne, nom in EPOQUES if annee < borne)


def elus_en_exercice(cartes):
    """Parlementaires dont un mandat est en cours, et membres du Gouvernement en fonction."""
    actuels = {c["id"] for c in cartes if any(m.get("en_cours") for m in c.get("mandats", []))}
    f = os.path.join("data", "gouvernement", "fonctions.json")
    if os.path.exists(f):
        with open(f, encoding="utf-8") as fh:
            for ident, fonctions in json.load(fh).items():
                if any(x.get("fin") is None and (x.get("debut") or "") >= "2017" for x in fonctions):
                    actuels.add(int(ident) if ident.isdigit() else ident)
    return actuels


def nom_famille_sycomore(nom):
    """« Jean, Pierre Bel » -> « Bel » ; « Jean-Louis Tinaud » -> « Tinaud » :
    dernier segment après la virgule, privé de son premier mot (le dernier prénom)."""
    segment = (nom or "").split(",")[-1].strip()
    mots = segment.split(" ", 1)
    return mots[1] if len(mots) == 2 else segment


def cartes_senateurs(cartes, listes):
    """Cartes des sénateurs absents de Sycomore (jamais députés), d'après l'open data du Sénat.
    Un sénateur est réputé déjà présent si une fiche Sycomore porte un nom commun et la même
    date de naissance (ou, à défaut de date identique, la même année, signalée en anomalie)."""
    if not os.path.exists(F_SENATEURS):
        anomalies["base des sénateurs absente"].append(F_SENATEURS)
        return []
    with open(F_SENATEURS, encoding="utf-8") as f:
        senateurs = json.load(f)
    # Doublons établis par décision motivée (complétés, le cas échéant, par data/listes/decisions-senateurs.json)
    doublons = {"000086": {"sycomore": 4246, "motif": "Bernard Lafay : même personne que la fiche Sycomore 4246 "
                                                   "(né en 1903 selon Sycomore, en 1905 selon l'open data du Sénat)."}}
    f_doublons = os.path.join("data", "listes", "decisions-senateurs.json")
    if os.path.exists(f_doublons):
        with open(f_doublons, encoding="utf-8") as f:
            doublons.update({d["matricule"]: d for d in json.load(f)["doublons"]})
    par_date, par_annee = defaultdict(list), defaultdict(list)
    for c in cartes:
        if c["naissance"]:
            par_date[c["naissance"]].append(c)
            par_annee[c["naissance"][:4]].append(c)
    nouvelles = []
    for s in senateurs:
        if s["matricule"] in doublons:
            continue  # même personne qu'une fiche Sycomore, établie par décision motivée
        # Rapprochement sur le nom de famille entier (tous ses mots), jamais sur les prénoms
        cles = noms_cles(s.get("nom_famille") or s["nom"])
        meme_nom = lambda c: bool(cles) and cles <= noms_cles(nom_famille_sycomore(c["nom"]))
        if s["naissance"] and any(meme_nom(c) for c in par_date[s["naissance"]]):
            continue
        # Même année seulement : il faut aussi le même premier prénom, et une date qui ne diffère
        # que par le jour ou que par le mois (erreur de saisie plausible dans l'une des sources)
        prenom = noms_cles((s.get("prenom") or s["nom"].split(" ")[0]).split(" ")[0].split("-")[0])

        def date_voisine(c):
            a, b = s["naissance"], c["naissance"]
            return a[5:7] == b[5:7] or a[8:10] == b[8:10]
        proches = [c for c in par_annee[(s["naissance"] or "")[:4]]
                   if meme_nom(c) and prenom and prenom <= noms_cles(c["nom"]) and date_voisine(c)]
        if s["naissance"] and proches:
            anomalies["sénateur rapproché d'une fiche Sycomore par l'année seule"].append(
                f"{s['matricule']} {s['nom']} ({s['naissance']}) -> {proches[0]['id']} {proches[0]['nom']} ({proches[0]['naissance']})")
            continue
        mandats = []
        fonction = (("Sénatrice" if s["sexe"] == "F" else "Sénateur")
                    + (f" ({s['circonscription']})" if s["circonscription"] else ""))
        if not any(m["debut"] for m in s["mandats"]):
            # Mandat absent ou non daté dans l'open data : carte créée, durée non comptée
            anomalies["sénateur sans mandat daté (carte créée, durée non comptée)"].append(
                f"{s['matricule']} {s['nom']} ({s['etat']})")
            mandats.append({"chambre": "Sénat", "fonction": fonction, "debut": None, "fin": None,
                            "en_cours": s["etat"] == "ACTIF", "non_date": True})
        for m in s["mandats"]:
            if not m["debut"]:
                continue
            fin = m["fin"]
            en_cours = s["etat"] == "ACTIF" and (not fin or fin > AUJOURDHUI.isoformat())
            mandats.append({"chambre": "Sénat", "fonction": fonction,
                            "debut": m["debut"], "fin": None if en_cours else fin, "en_cours": en_cours})
        ident = "S" + s["matricule"]
        jours = duree_jours(mandats)
        annees = round(jours / 365.25, 1)
        distinctions = [{"code": l["code"], "points": l["points"], "libelle": l["libelle"],
                         "plancher": l.get("plancher")} for l in listes if ident in l["ids"]]
        carte = {"id": ident, "nom": s["nom"], "sexe": s["sexe"], "naissance": s["naissance"],
                 "lieu_naissance": None, "deces": s["deces"], "annees_mandat": annees,
                 "mandats": mandats, "distinctions": distinctions,
                 "score": score_carte(annees, distinctions),
                 "source": f"https://data.senat.fr/les-senateurs/ (matricule {s['matricule']})"}
        carte["texte"] = texte_carte(carte)
        nouvelles.append(carte)
    return nouvelles


def cartes_hors_categorie(listes):
    """Membres du Gouvernement n'ayant jamais siégé au Parlement : cartes « hors catégorie »,
    sans durée de mandat, notées sur leurs seules fonctions et exclues du classement par rang."""
    if not os.path.exists(F_HORS_PARLEMENT):
        return []
    with open(F_HORS_PARLEMENT, encoding="utf-8") as f:
        personnes = json.load(f)
    cartes = []
    for p in personnes:
        distinctions = [{"code": l["code"], "points": l["points"], "libelle": l["libelle"],
                         "plancher": None} for l in listes if p["id"] in l["ids"]]
        # Une même fonction exercée dans plusieurs gouvernements successifs : une seule période
        fusion = {}
        for f in p["fonctions"]:
            g = fusion.setdefault(f["fonction"], dict(f))
            g["debut"] = min(x for x in (g["debut"], f["debut"]) if x) if (g["debut"] or f["debut"]) else None
            g["fin"] = None if not (g["fin"] and f["fin"]) else max(g["fin"], f["fin"])
        fonctions = []
        for f in fusion.values():
            if not f["fin"] and (f["debut"] or "") >= "1959":
                periode = f"depuis {annee(f['debut'])}"
            elif not f["fin"]:
                periode = annee(f["debut"])  # source 1944-1959 : date de fin non relevée
            else:
                periode = annee(f["debut"]) + (f"-{annee(f['fin'])}" if annee(f["fin"]) != annee(f["debut"]) else "")
            libelle = f"{f['fonction']} ({periode})"
            if libelle not in fonctions:
                fonctions.append(libelle)
        texte = "Sans mandat parlementaire. " + " ; ".join(fonctions[:3])
        if len(fonctions) > 3:
            texte += f", et {len(fonctions) - 3} autre(s) fonction(s)"
        cartes.append({"id": p["id"], "nom": p["nom"], "sexe": None, "naissance": None, "lieu_naissance": None,
                       "deces": None, "annees_mandat": 0, "mandats": [], "fonctions": p["fonctions"],
                       "distinctions": distinctions,
                       "score": score_carte(0, distinctions),
                       "rarete": "hors-categorie", "texte": texte + ".",
                       "source": "https://www.data.gouv.fr/datasets/historique-des-gouvernements-de-la-veme-republique"})
    return cartes


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
        libelle = ' et '.join(fonctions) or 'Membre de la chambre haute'
        if debut:
            phrases.append(f"{libelle} de {annee(debut)} à {fin}.")
        else:
            phrases.append(f"{libelle}{', en fonction' if any(m['en_cours'] for m in se) else ''}.")
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

            if d_date and n_date and d_date < n_date:
                # Décès antérieur à la naissance : date incohérente dans la fiche, non retenue
                anomalies["date de décès antérieure à la naissance (ignorée)"].append(
                    f"{ident} {r.get('nom')} : né le {n_date}, décès lu {d_date}")
                d_date = None
            score = score_carte(annees, distinctions)
            carte = {"id": ident, "nom": r.get("nom"), "sexe": sexe,
                     "naissance": n_date, "lieu_naissance": n_lieu, "deces": d_date,
                     "annees_mandat": annees, "mandats": mandats,
                     "distinctions": distinctions, "score": round(score, 1),
                     "source": f"https://www2.assemblee-nationale.fr/sycomore/fiche/{ident}"}
            carte["texte"] = texte_carte(carte)
            cartes.append(carte)

    senateurs = cartes_senateurs(cartes, listes)
    cartes.extend(senateurs)

    # Rareté par rang à l'intérieur de chaque époque (les assemblées révolutionnaires et la IIIe République,
    # très nombreuses, n'écrasent plus les autres périodes), puis planchers, puis bonus des élus en exercice
    actuels = elus_en_exercice(cartes)
    par_epoque = defaultdict(list)
    for c in cartes:
        c["epoque"] = epoque(c)
        c["en_exercice"] = c["id"] in actuels
        par_epoque[c["epoque"]].append(c)
    for groupe in par_epoque.values():
        groupe.sort(key=lambda c: (-c["score"], str(c["id"])))
        for rang, c in enumerate(groupe):
            part = (rang + 1) / len(groupe)
            c["rarete"] = next(n for n, seuil in NIVEAUX if part <= seuil)
    for c in cartes:
        for d in c["distinctions"]:
            p = d.get("plancher")
            if p and ORDRE.index(p) < ORDRE.index(c["rarete"]):
                c["rarete"] = p
        if c["en_exercice"] and c["rarete"] != ORDRE[0]:
            c["rarete"] = ORDRE[ORDRE.index(c["rarete"]) - 1]  # un niveau de plus pour les élus en exercice
    cartes.sort(key=lambda c: (-c["score"], str(c["id"])))
    total = len(cartes)

    # Membres du Gouvernement sans mandat parlementaire : hors classement
    hors_categorie = cartes_hors_categorie(listes)
    hors_categorie.sort(key=lambda c: (-c["score"], c["id"]))
    cartes.extend(hors_categorie)

    os.makedirs("data", exist_ok=True)
    with open(F_CARTES, "w", encoding="utf-8") as f:
        json.dump(cartes, f, ensure_ascii=False, separators=(",", ":"))

    # Contrôle
    dist = Counter(d["code"] for c in cartes for d in c["distinctions"])
    rar = Counter(c["rarete"] for c in cartes)
    with open(F_CONTROLE, "w", encoding="utf-8") as f:
        f.write(f"Fiches lues : {dict(statuts)} ; cartes produites : {total}, "
                f"dont {len(senateurs)} sénateurs absents de Sycomore ; "
                f"plus {len(hors_categorie)} cartes hors catégorie (Gouvernement sans mandat parlementaire)\n\n")
        f.write("Distinctions calculées :\n")
        for k, v in dist.most_common():
            f.write(f"  {k} : {v}\n")
        scores = sorted((c["score"] for c in cartes if c["rarete"] != "hors-categorie"), reverse=True)
        f.write("\nScores (grille équilibrée) : maximum %.1f ; 10e %.1f ; 100e %.1f ; 1000e %.1f ; médiane %.1f\n"
                % (scores[0], scores[9], scores[99], scores[999], scores[len(scores) // 2]))
        egalite = sum(1 for x in scores if x == scores[0])
        f.write(f"Cartes à égalité au score maximal : {egalite} ; scores distincts parmi les 100 premières : "
                f"{len(set(scores[:100]))}\n")
        f.write(f"\nCartes en exercice : {sum(1 for c in cartes if c.get('en_exercice'))}\n")
        f.write("Cartes par époque : " + ", ".join(f"{e} {n}" for e, n in Counter(c.get("epoque") for c in cartes).items()) + "\n")
        f.write("\nRépartition des raretés :\n")
        for n in ORDRE + ["hors-categorie"]:
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
