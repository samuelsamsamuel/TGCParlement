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
from cartes import nom_famille_sycomore  # noqa: E402

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
    "chef-gouvernement": (40, "A dirigé le Gouvernement"),
    "ministre": (15, "A été ministre"),
    "secretaire-etat": (6, "A été secrétaire d'État"),
}


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


def iso(valeur):
    """Accepte AAAA-MM-JJ, AAAA/MM/JJ, JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA (heure éventuelle ignorée)."""
    v = (valeur or "").strip()
    m = re.search(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", v)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
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
    if c["deces"] and c["deces"] < debut:
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
    decisions = {}
    if os.path.exists(F_DECISIONS):
        with open(F_DECISIONS, encoding="utf-8") as f:
            decisions = {d["cle"]: d for d in json.load(f)["decisions"]}

    lignes = []  # (liste, prénom, nom, début, fonction)
    for r in telecharger(FICHIERS["presidents"]):
        lignes.append(("chef-etat", r.get("prenom"), r.get("nom"), iso(r.get("date_debut_mandat")), "Président de la République", iso(r.get("date_fin_mandat"))))
    for r in telecharger(FICHIERS["premiers"]):
        lignes.append(("chef-gouvernement", r.get("prenom"), r.get("nom"), iso(r.get("date_debut_fonction")), "Premier ministre", iso(r.get("date_fin_fonction"))))
    non_comptees = defaultdict(int)
    for r in telecharger(FICHIERS["membres"]):
        cat = categorie(r.get("fonction"))
        if cat:
            lignes.append((cat, r.get("prenom"), r.get("nom"), iso(r.get("date_debut_fonction")), r.get("fonction"), iso(r.get("date_fin_fonction"))))
        elif not (r.get("fonction") or "").lower().startswith("premier ministre"):
            non_comptees[r.get("fonction")] += 1

    rapport, membres, vus = [], defaultdict(set), {}
    for liste, prenom, nom, debut, fonction, fin in lignes:
        cle = f"{nom}|{prenom}"
        if cle in decisions:
            ident = decisions[cle]["id"]
            if ident is not None:
                membres[liste].add(ident)
            continue
        nf, pr = mots(nom), norme((prenom or "").split(" ")[0])
        candidats = {c["id"]: c for w in nf for c in index.get(w, [])
                     if nf <= mots(nom_usage(c["nom"])) and pr and pr in prenoms_carte(c["nom"])
                     and age_plausible(c, debut)}
        if len(candidats) == 1:
            c = next(iter(candidats.values()))
            membres[liste].add(c["id"])
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
        fiche = personnes.setdefault(ident, {"id": ident, "nom": f"{prenom} {nom}", "fonctions": []})
        fiche["fonctions"].append({"liste": liste, "fonction": fonction, "debut": debut, "fin": fin})
        membres[liste].add(ident)
    for fiche in personnes.values():
        fiche["fonctions"].sort(key=lambda f: f["debut"] or "")
    os.makedirs(os.path.join("data", "gouvernement"), exist_ok=True)
    with open(os.path.join("data", "gouvernement", "hors_parlement.json"), "w", encoding="utf-8") as f:
        json.dump(sorted(personnes.values(), key=lambda x: x["id"]), f, ensure_ascii=False, indent=1)

    sans_carte = sorted(personnes[i]["nom"] for i in personnes)
    rapport.insert(0, "Rattachés : " + ", ".join(f"{k} {len(v)}" for k, v in membres.items())
                   + f" ; hors catégorie : {len(sans_carte)}")
    if DATES_ILLISIBLES:
        rapport.insert(1, "DATES ILLISIBLES (exemples) : " + " | ".join(DATES_ILLISIBLES))
    rapport.append("\nFonctions non comptées : " + "; ".join(f"{k} ({v})" for k, v in sorted(non_comptees.items())))
    rapport.append("\nCartes « hors catégorie » (membres du Gouvernement sans mandat parlementaire) : "
                   + "; ".join(sans_carte))
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
