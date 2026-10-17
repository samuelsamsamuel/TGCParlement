#!/usr/bin/env python3
"""Listes fermées des fonctions exécutives sous la Ve République.

Source : jeu de données « Historique des Gouvernements de la Vème République » (data.gouv.fr,
Licence Ouverte 2.0), dont chaque ligne renvoie aux décrets de nomination et de cessation de
fonctions publiés sur Légifrance. Trois fichiers : Présidents de la République, Premiers ministres,
membres des Gouvernements.

Rattachement aux cartes : même nom de famille et même premier prénom, carte d'un parlementaire
vivant à la date d'entrée en fonction. Les homonymes sont signalés et tranchés dans
data/listes/decisions-gouvernements.json ({"cle": "nom|prénom", "id": ... ou null, "motif": ...}).

Sorties : data/listes/chef-etat.json, chef-gouvernement.json, ministre.json, secretaire-etat.json
          data/listes/rapports/gouvernements-rapport.txt
Bibliothèque standard uniquement.
"""
import csv
from datetime import date
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from difflib import SequenceMatcher

sys.path.insert(0, os.path.dirname(__file__))
from cartes import lire_date, nom_famille_sycomore  # noqa: E402

SOURCE = "https://www.data.gouv.fr/datasets/historique-des-gouvernements-de-la-veme-republique"
FICHIERS = {  # identifiants des ressources publiés sur la page du jeu de données
    "membres": "https://www.data.gouv.fr/api/1/datasets/r/0ac23b31-0dfb-47f5-8b65-e21103f4be8c",
    "premiers": "https://www.data.gouv.fr/api/1/datasets/r/5e8c4460-11a6-433b-b48a-694ab7a0357d",
    "presidents": "https://www.data.gouv.fr/api/1/datasets/r/0492fc8f-da9f-4c43-a899-66583a626b24",
}
SORTIE = os.path.join("data", "listes")
RAPPORTS = os.path.join(SORTIE, "rapports")
F_DECISIONS = os.path.join(SORTIE, "decisions-gouvernements.json")
LISTES = {
    "chef-etat": (50, "A été chef de l'État"),
    "chef-etat-interim": (15, "A assuré l'intérim de la présidence de la République"),
    "chef-gouvernement": (40, "A dirigé le Gouvernement"),
    "ministre": (15, "A été ministre"),
    "secretaire-etat": (6, "A été secrétaire d'État"),
}


# Décisions motivées sur les homonymes, intégrées au script (un fichier
# data/listes/decisions-gouvernements.json, s'il existe, les complète ou les remplace).
DECISIONS_INTEGREES = [
 {"cle": "TANGUY-PRIGENT|François", "id": 6948, "motif": "La liste officielle des Quatre-vingts publiée par l'Assemblée nationale renvoie, pour François Tanguy-Prigent, à la fiche Sycomore 6948."},
 {"cle": "RIBEYRE|Paul", "id": 6722, "motif": "Deux fiches Paul Ribeyre (nés en 1885 et en 1906) ; le membre des gouvernements de la IVe République est le député né en 1906."},
 {
  "cle": "Dumas|Pierre",
  "departement": "Savoie",
  "motif": "Deux Pierre Dumas députés, nés en 1891 et en 1924 ; le membre des gouvernements Pompidou est le député de la Savoie."
 },
 {"cle": "De Chambrun|Charles", "id": 1621, "motif": "Deux Pineton de Chambrun élus de la Lozère en 1966 : Charles (fiche 1621, né en 1930), dont c'est le premier prénom, et Gilbert (fiche 1622, né en 1909), qui ne porte Charles qu'en troisième prénom. Le secrétaire d'État au commerce extérieur est Charles."},
 {
  "cle": "Mondon|Raymond",
  "departement": "Moselle",
  "motif": "Deux fiches Raymond Mondon (1914 et 1917) ; le ministre des transports de 1969 est le député de la Moselle, maire de Metz."
 },
 {
  "cle": "Lafay|Bernard",
  "id": 4246,
  "motif": "Bernard Lafay, député de Paris (fiche Sycomore 4246) ; la fiche sénatoriale S000086 décrit la même personne avec une autre année de naissance (voir decisions-senateurs.json)."
 },
 {
  "cle": "Boucheron|Jean-Michel",
  "departement": "Charente",
  "motif": "Deux députés Jean-Michel Boucheron en 1988 (Charente et Ille-et-Vilaine) ; le secrétaire d'État aux collectivités territoriales est le député de la Charente, maire d'Angoulême."
 },
 {
  "cle": "Martin|Philippe",
  "departement": "Gers",
  "motif": "Deux députés Philippe Martin en 2013 (Marne et Gers) ; le ministre de l'Écologie est le député du Gers."
 }
]


def telecharger(url):
    for attente in (0, 20, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "TGCParlement/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                brut = r.read()
            break
        except urllib.error.URLError as e:
            erreur = e
    else:
        raise SystemExit(f"Échec du téléchargement de {url} : {erreur}")
    try:
        texte = brut.decode("utf-8-sig")
    except UnicodeDecodeError:
        texte = brut.decode("cp1252")
    dialecte = csv.Sniffer().sniff(texte[:5000], delimiters=",;\t")
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()}
            for r in csv.DictReader(io.StringIO(texte), dialect=dialecte)]


def mots(texte):
    t = unicodedata.normalize("NFKD", texte or "").encode("ascii", "ignore").decode().lower()
    return set(w for w in re.findall(r"[a-z]+", t) if w not in {"de", "du", "des", "la", "le", "d", "l"})


def norme(t):
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower().strip()


def prenoms_carte(nom):
    """« Michel, Jean-Pierre Debré » -> {michel, jean-pierre} ; « Jean-Louis Debré » -> {jean-louis}."""
    segments = [x.strip() for x in (nom or "").split(",")]
    dernier = segments[-1].split(" ", 1)
    prenoms = segments[:-1] + ([dernier[0]] if len(dernier) == 2 else [])
    return {norme(x) for x in prenoms if x}


DATES_ILLISIBLES = []


def premier_prenom(nom):
    return norme((nom or "").split(",")[0].split(" ")[0])


def rapprochement_souple(nf, pr, debut, index_large):
    """Dernier recours, une seule fiche admise et signalée : nom écrit autrement (« Fily-Dabo Sissoko »,
    « Hubert, Coutoucou Maga »), prénom composé (« Jules-Emile ») ou voisin (« Edward »/« Édouard »)."""
    parts = set(pr.split("-"))
    vus, retenus = set(), []
    for w in nf:
        for c in index_large.get(w, []):
            if c["id"] in vus or not age_plausible(c, debut):
                continue
            vus.add(c["id"])
            segment = mots((c["nom"] or "").split(",")[-1])
            prenoms = prenoms_carte(c["nom"])
            tous_prenoms = set(x for p in prenoms for x in p.split("-"))
            # Le nom cherché doit se lire dans le nom de la fiche, jamais dans son premier prénom
            # (« Michel Guy » n'est pas « Guy-Michel Chauveau »)
            premier = set(premier_prenom(c["nom"]).split("-"))
            nom_ok = nf <= segment and not nf <= premier
            prenom_ok = (pr in prenoms or parts <= tous_prenoms
                         or any(SequenceMatcher(None, pr, p).ratio() >= 0.75 for p in prenoms))
            if nom_ok and prenom_ok:
                retenus.append(c)
    if len(retenus) == 1:
        return retenus[0], "rapprochement souple"
    return None


def iso(valeur):
    """Accepte AAAA-MM-JJ, AAAA/MM/JJ, JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA (heure éventuelle ignorée)."""
    v = (valeur or "").strip()
    m = re.search(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", v)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    # Date en toutes lettres, jour de la semaine éventuel : « jeudi 8 janvier 1959 »
    d = lire_date(re.sub(r"^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+", "", v, flags=re.I))
    if d:
        return d.isoformat()
    if v and len(DATES_ILLISIBLES) < 5:
        DATES_ILLISIBLES.append(v)
    return None


def nom_usage(nom_carte):
    """Nom de famille de la carte ; s'il comporte « dit », le nom d'usage qui suit."""
    nf = nom_famille_sycomore(nom_carte)
    return nf.split(" dit ", 1)[1] if " dit " in nf else nf


def age_plausible(c, debut):
    """Vivant à la date de nomination et âgé de 21 à 90 ans (exclut les homonymes d'autres siècles)."""
    if not debut:
        return True
    incoherent = c["deces"] and c["naissance"] and c["deces"] < c["naissance"]
    if c["deces"] and not incoherent and c["deces"] < debut:
        return False
    if c["naissance"]:
        age = int(debut[:4]) - int(c["naissance"][:4])
        return 21 <= age <= 90
    return True


def categorie(fonction):
    f = unicodedata.normalize("NFKD", fonction or "").encode("ascii", "ignore").decode().lower()
    if f.startswith("premier ministre"):
        return None  # traité par la liste des Premiers ministres
    if "secretaire d'etat" in f or "sous-secretaire" in f:
        return "secretaire-etat"
    if "ministre" in f or "garde des sceaux" in f:
        return "ministre"
    return None  # autres fonctions (haut-commissaire...) : non comptées


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    index = defaultdict(list)
    cartes = [c for c in cartes if not str(c["id"]).startswith("G-")]  # cartes hors catégorie : recréées ici
    for c in cartes:
        for w in mots(nom_usage(c["nom"])):
            index[w].append(c)
    decisions = {norme(d["cle"]): d for d in DECISIONS_INTEGREES}
    if os.path.exists(F_DECISIONS):
        with open(F_DECISIONS, encoding="utf-8") as f:
            decisions.update({norme(d["cle"]): d for d in json.load(f)["decisions"]})

    lignes = []  # (liste, prénom, nom, début, fonction)
    for r in telecharger(FICHIERS["presidents"]):
        debut, fin = iso(r.get("date_debut_mandat")), iso(r.get("date_fin_mandat"))
        # Un exercice de moins de six mois est un intérim (article 7 de la Constitution) : distinction propre
        interim = bool(debut and fin and (date.fromisoformat(fin) - date.fromisoformat(debut)).days < 180)
        lignes.append(("chef-etat-interim" if interim else "chef-etat", r.get("prenom"), r.get("nom"), debut,
                       "Président de la République par intérim" if interim else "Président de la République", fin))
    for r in telecharger(FICHIERS["premiers"]):
        lignes.append(("chef-gouvernement", r.get("prenom"), r.get("nom"), iso(r.get("date_debut_fonction")), "Premier ministre", iso(r.get("date_fin_fonction"))))
    non_comptees = defaultdict(int)
    for r in telecharger(FICHIERS["membres"]):
        cat = categorie(r.get("fonction"))
        if cat:
            lignes.append((cat, r.get("prenom"), r.get("nom"), iso(r.get("date_debut_fonction")), r.get("fonction"), iso(r.get("date_fin_fonction"))))
        elif not (r.get("fonction") or "").lower().startswith("premier ministre"):
            non_comptees[r.get("fonction")] += 1

    # Gouvernements récents d'après l'open data de l'Assemblée (gouvernements_an.py), qui complète
    # le jeu de données de la Ve République, arrêté en mars 2025
    f_an = os.path.join("data", "gouvernement", "an_lignes.json")
    nb_an = 0
    if os.path.exists(f_an):
        with open(f_an, encoding="utf-8") as f:
            for r in json.load(f):
                lignes.append((r["liste"], r["prenom"], r["nom"], r["debut"], r["fonction"], r["fin"]))
                nb_an += 1

    # Gouvernements de la Libération et de la IVe République (lus par gouvernements_ive.py)
    f_ive = os.path.join("data", "gouvernement", "ive_lignes.json")
    nb_ive = 0
    if os.path.exists(f_ive):
        with open(f_ive, encoding="utf-8") as f:
            for r in json.load(f):
                lignes.append((r["liste"], r["prenom"], r["nom"], r["debut"], r["fonction"], None))
                nb_ive += 1

    rapport, membres, vus, ecartes, souples = [], defaultdict(set), {}, [], []
    detail = defaultdict(list)
    index_large = defaultdict(list)  # tous les mots du dernier segment du nom (prénom compris)
    for c in cartes:
        for w in mots((c["nom"] or "").split(",")[-1]):
            index_large[w].append(c)
    for liste, prenom, nom, debut, fonction, fin in lignes:
        cle = f"{nom}|{prenom}"
        nf, pr = mots(nom), norme((prenom or "").split(" ")[0])
        homonymes = {c["id"]: c for w in nf for c in index.get(w, [])
                     if nf <= mots(nom_usage(c["nom"])) and pr and pr in prenoms_carte(c["nom"])}
        candidats = {i: c for i, c in homonymes.items() if age_plausible(c, debut)}
        if len(candidats) > 1:
            # Plusieurs fiches portent ce prénom : on retient celle dont c'est le premier prénom
            premiers = {i: c for i, c in candidats.items() if premier_prenom(c["nom"]) == pr}
            if len(premiers) == 1:
                candidats = premiers
        souple = None
        if not homonymes and pr:
            souple = rapprochement_souple(nf, pr, debut, index_large)
            if souple:
                candidats = {souple[0]["id"]: souple[0]}
                ligne_souple = f"{prenom} {nom} -> {souple[0]['id']} {souple[0]['nom']}"
                if ligne_souple not in souples:
                    souples.append(ligne_souple)
        if norme(cle) in decisions:
            dec = decisions[norme(cle)]
            if dec.get("departement"):
                # Désignation par le département d'élection, lu dans les mandats de la carte
                retenus = [c for c in candidats.values()
                           if any(norme(dec["departement"]) == norme(m.get("departement"))
                                  for m in c["mandats"])]
                if len(retenus) == 1:
                    membres[liste].add(retenus[0]["id"])
                    detail[retenus[0]["id"]].append((fonction, debut, fin, liste))
                    vus[cle] = (retenus[0]["id"], retenus[0]["nom"] + " [décision]")
                else:
                    rapport.append(f"DÉCISION NON APPLICABLE ({len(retenus)} fiche(s) pour {dec['departement']}) : {cle}")
            elif dec.get("id") is not None:
                membres[liste].add(dec["id"])
                detail[dec["id"]].append((fonction, debut, fin, liste))
                vus[cle] = (dec["id"], "[décision]")
            continue
        if homonymes and not candidats and cle not in vus:
            ecartes.append(f"{prenom} {nom} ({fonction}, {debut}) : " + " / ".join(
                f"{c['id']} {c['nom']} ({c['naissance'] or '?'} - {c['deces'] or ''})" for c in homonymes.values()))
        if len(candidats) == 1:
            c = next(iter(candidats.values()))
            membres[liste].add(c["id"])
            detail[c["id"]].append((fonction, debut, fin, liste))
            vus[cle] = (c["id"], c["nom"])
        elif len(candidats) > 1 and cle not in vus:
            vus[cle] = None
            rapport.append(f"HOMONYMES : {prenom} {nom} ({fonction}, {debut}) : "
                           + " / ".join(f"{c['id']} {c['nom']} ({(c['naissance'] or '?')[:4]})" for c in candidats.values()))
        elif cle not in vus:
            vus[cle] = False  # jamais parlementaire, ou absent des bases

    # Membres du Gouvernement sans mandat parlementaire : cartes « hors catégorie ».
    # Une ligne dont le nom n'est qu'une coquille d'un membre déjà rattaché (« Edgard » Faure,
    # nom et prénom inversés...) ne crée pas de seconde personne.
    rattaches = [(norme(k.split("|")[1]), norme(k.split("|")[0])) for k, v in vus.items() if v]
    personnes, coquilles = {}, []
    for liste, prenom, nom, debut, fonction, fin in lignes:
        cle = f"{nom}|{prenom}"
        if vus.get(cle) is not False:
            continue
        p, n = norme(prenom), norme(nom)
        jeu = mots(f"{prenom} {nom}")
        proche = next((f"{rp} {rn}" for rp, rn in rattaches
                       if mots(f"{rp} {rn}") == jeu
                       or (rp == p and SequenceMatcher(None, rn, n).ratio() >= 0.85)
                       or (rn == n and SequenceMatcher(None, rp, p).ratio() >= 0.8)), None)
        if proche:
            coquilles.append(f"{prenom} {nom} = {proche}")
            continue
        ident = "G-" + re.sub(r"[^a-z0-9]+", "-", f"{n} {p}").strip("-")
        # Même nom et prénom voisin d'une carte hors catégorie déjà créée : même personne (« Francis »/« François »)
        for autre, fiche_autre in personnes.items():
            np_autre = fiche_autre["cle"]
            if np_autre[1] == n and SequenceMatcher(None, np_autre[0], p).ratio() >= 0.8 and autre != ident:
                coquilles.append(f"{prenom} {nom} = {fiche_autre['nom']}")
                ident = autre
                break
        fiche = personnes.setdefault(ident, {"id": ident, "nom": f"{prenom} {nom}", "fonctions": [], "cle": (p, n)})
        fiche["fonctions"].append({"liste": liste, "fonction": fonction, "debut": debut, "fin": fin})
        membres[liste].add(ident)
    for fiche in personnes.values():
        fiche["fonctions"].sort(key=lambda f: f["debut"] or "")
    for ident, fiche in personnes.items():
        for x in fiche["fonctions"]:
            detail[ident].append((x["fonction"], x["debut"], x["fin"], x["liste"]))
    os.makedirs(os.path.join("data", "gouvernement"), exist_ok=True)
    fusion = {}
    for ident, fs in detail.items():
        uniques = {}
        for fonction, debut, fin, liste in fs:
            cle = (fonction or "").strip().rstrip(".")
            u = uniques.setdefault(cle, {"fonction": cle, "liste": liste, "debut": debut, "fin": fin})
            u["debut"] = min(x for x in (u["debut"], debut) if x) if (u["debut"] or debut) else None
            u["fin"] = None if not (u["fin"] and fin) else max(u["fin"], fin)
        fusion[str(ident)] = sorted(uniques.values(), key=lambda x: x["debut"] or "")
    with open(os.path.join("data", "gouvernement", "fonctions.json"), "w", encoding="utf-8") as f:
        json.dump(fusion, f, ensure_ascii=False, indent=0)
    with open(os.path.join("data", "gouvernement", "hors_parlement.json"), "w", encoding="utf-8") as f:
        json.dump([{k: v for k, v in x.items() if k != "cle"} for x in sorted(personnes.values(), key=lambda x: x["id"])],
                  f, ensure_ascii=False, indent=1)

    sans_carte = sorted(personnes[i]["nom"] for i in personnes)
    rapport.insert(0, f"Fonctions 1944-1959 reprises : {nb_ive} ; fonctions récentes (open data de l'Assemblée) : {nb_an}")
    rapport.insert(0, "Rattachés : " + ", ".join(f"{k} {len(v)}" for k, v in membres.items())
                   + f" ; hors catégorie : {len(sans_carte)}")
    if DATES_ILLISIBLES:
        rapport.insert(1, "DATES ILLISIBLES (exemples) : " + " | ".join(DATES_ILLISIBLES))
    rapport.append("\nFonctions non comptées : " + "; ".join(f"{k} ({v})" for k, v in sorted(non_comptees.items())))
    rapport.append("\nCartes « hors catégorie » (membres du Gouvernement sans mandat parlementaire) : "
                   + "; ".join(sans_carte))
    rapport.append("\nRapprochements souples (graphie ou prénom différents, à vérifier) : " + " ; ".join(souples))
    rapport.append("\nHomonymes écartés par le contrôle d'âge (vérifier les dates) : " + " ; ".join(ecartes))
    rapport.append("\nCoquilles de la source rapportées à un membre déjà rattaché : " + "; ".join(coquilles))
    rapport.append("\nRattachements :")
    rapport += [f"  {k.replace('|', ', ')} -> {v[0]} {v[1]}" for k, v in sorted(vus.items()) if v]

    os.makedirs(RAPPORTS, exist_ok=True)
    for code, (pts, libelle) in LISTES.items():
        with open(os.path.join(SORTIE, code + ".json"), "w", encoding="utf-8") as f:
            json.dump({"code": code, "points": pts, "plancher": None, "libelle": libelle,
                       "source": SOURCE, "perimetre": "Ve République",
                       "ids": sorted(membres[code], key=str)}, f, ensure_ascii=False, indent=1)
    texte = "\n".join(rapport)
    with open(os.path.join(RAPPORTS, "gouvernements-rapport.txt"), "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    print(texte[:6000])


if __name__ == "__main__":
    main()
