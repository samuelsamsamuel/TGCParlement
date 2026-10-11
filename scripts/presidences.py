#!/usr/bin/env python3
"""Liste fermée des présidences de l'Assemblée, depuis la liste officielle publiée par l'Assemblée.

1. Lit la page « Les Présidents de l'Assemblée nationale depuis 1789 » et ses onglets par régime.
2. Relève chaque ligne (Du, au, nom) ; écarte les présidences refusées.
3. Rattache chaque nom à une fiche Sycomore : nom concordant ET mandat de député en cours
   à la date de prise de fonction (data/cartes.json).
4. Écrit deux listes PROPOSÉES, à valider avant usage, et un rapport :
     data/listes/proposees/presidence-an-longue.json  (au moins un an cumulé)
     data/listes/proposees/presidence-an-courte.json  (moins d'un an)
     data/listes/proposees/presidences-rapport.txt
   Rien n'est corrigé en silence : dates incohérentes, noms introuvables ou ambigus
   sont listés dans le rapport.

Une liste validée se déplace dans data/listes/ ; cartes.py ne lit que ce dossier.
Bibliothèque standard uniquement.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urljoin

sys.path.insert(0, os.path.dirname(__file__))
from cartes import lire_date  # noqa: E402

PAGE = ("https://www2.assemblee-nationale.fr/decouvrir-l-assemblee/histoire/"
        "les-presidents-de-l-assemblee-nationale-depuis-17893")
CONTACT = os.environ.get("CONTACT", "contact non renseigne")
UA = "Projet parlementaires, extraction autorisee par l'Assemblee nationale (" + CONTACT + ")"
SORTIE = os.path.join("data", "listes", "proposees")
rapport = []


def telecharger(url):
    time.sleep(1)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as e:  # le rapport dira quelle page a échoué
        rapport.append(f"ÉCHEC {url} : {e}")
        return ""


class Tables(HTMLParser):
    """Relève les lignes de tableaux, les liens et les attributs évoquant des onglets."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lignes, self.liens, self.attributs = [], [], []
        self.ligne, self.cellule, self.titre, self.dans_titre = None, None, None, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.liens.append(a["href"])
        for k, v in attrs:
            if v and ("node" in v or "presidents" in v) and k not in ("href", "class"):
                self.attributs.append(f"{tag}[{k}]={v}")
        if tag in ("h2", "h3"):
            self.dans_titre, self.titre = True, ""
        if tag == "tr":
            self.ligne = []
        if tag in ("td", "th") and self.ligne is not None:
            self.cellule = ""

    def handle_endtag(self, tag):
        if tag in ("h2", "h3"):
            self.dans_titre = False
        if tag in ("td", "th") and self.cellule is not None:
            self.ligne.append(" ".join(self.cellule.split()))
            self.cellule = None
        if tag == "tr" and self.ligne is not None:
            if len(self.ligne) >= 3:
                self.lignes.append((self.titre, self.ligne[:3]))
            self.ligne = None

    def handle_data(self, data):
        if self.cellule is not None:
            self.cellule += data
        if self.dans_titre:
            self.titre += data


def lire(url):
    t = Tables()
    t.feed(telecharger(url))
    return t


# --- Rattachement aux fiches -------------------------------------------------

PARTICULES = {"de", "la", "le", "du", "des", "d", "l", "dit", "dite", "ne", "nee"}


def jetons(nom):
    n = unicodedata.normalize("NFKD", nom).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\(.*?\)", " ", n)
    return [j for j in re.split(r"[^a-z]+", n) if j and j not in PARTICULES]


def siege_le(carte, jour):
    for m in carte["mandats"]:
        if m["chambre"] != "AN" or not m["debut"]:
            continue
        fin = date.fromisoformat(m["fin"]) if m["fin"] else date.today()
        if date.fromisoformat(m["debut"]) <= jour <= fin:
            return True
    return False


def rattacher(nom, jour, cartes, index):
    js = jetons(nom)
    if not js:
        return None, "nom vide"
    candidats = [c for c in index.get(js[-1], []) if siege_le(c, jour)]
    if not candidats:
        return None, "aucun député de ce nom en fonction à cette date"
    notes = sorted(((len(set(js) & set(jetons(c["nom"] or ""))), c) for c in candidats),
                   key=lambda x: -x[0])
    if len(notes) > 1 and notes[0][0] == notes[1][0]:
        return None, "ambigu : " + " / ".join(f"{c['id']} {c['nom']}" for _, c in notes[:4])
    return notes[0][1], None


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    index = defaultdict(list)
    for c in cartes:
        for j in set(jetons(c["nom"] or "")):
            index[j].append(c)

    # Page principale, puis toute page liée relevant de la même rubrique
    principale = lire(PAGE)
    pages = {PAGE: principale}
    for h in principale.liens:
        u = urljoin(PAGE, h).split("#")[0]
        if u.startswith(PAGE + "/") and u not in pages:
            pages[u] = lire(u)
    rapport.append(f"Pages lues : {len(pages)}")
    for u, t in pages.items():
        rapport.append(f"  {len(t.lignes):4d} lignes  {u}")
    if len(pages) == 1:
        rapport.append("Aucun onglet trouvé par les liens ; attributs relevés :")
        rapport.extend("  " + a for a in principale.attributs[:60])

    vues, periodes, noms = set(), defaultdict(list), {}
    for u, t in pages.items():
        for titre, (du, au, nom) in t.lignes:
            if du.lower().startswith("du"):
                continue  # ligne d'en-tête
            cle = (du, au, nom)
            if cle in vues:
                continue
            vues.add(cle)
            if "refus" in nom.lower():
                rapport.append(f"ÉCARTÉ (présidence refusée) : {du} | {nom}")
                continue
            d, f = lire_date(du), lire_date(au)
            if not d:
                rapport.append(f"DATE ILLISIBLE : {du} | {au} | {nom}")
                continue
            if f and f < d:
                rapport.append(f"INCOHÉRENCE (fin avant début) : {du} | {au} | {nom}")
            carte, motif = rattacher(nom, d, cartes, index)
            if not carte:
                rapport.append(f"NON RATTACHÉ ({motif}) : {du} | {au} | {nom}")
                continue
            periodes[carte["id"]].append((d, f))
            noms[carte["id"]] = (nom, carte["nom"])

    longue, courte = [], []
    rapport.append("\nRattachements (vérifier chaque ligne) :")
    for ident, ps in sorted(periodes.items()):
        jours = sum(((f or d) - d).days for d, f in ps if not f or f >= d)
        (longue if jours >= 365 else courte).append(ident)
        officiel, fiche = noms[ident]
        sans_fin = sum(1 for _, f in ps if not f)
        rapport.append(f"  {ident:6d}  {jours:6d} j  {officiel}  ->  {fiche}"
                       + (f"  ({sans_fin} période(s) sans date de fin, comptée(s) 0 jour)" if sans_fin else ""))

    os.makedirs(SORTIE, exist_ok=True)
    commun = {"source": PAGE, "ids_officiels_verifies": False}
    with open(os.path.join(SORTIE, "presidence-an-longue.json"), "w", encoding="utf-8") as f:
        json.dump({"code": "presidence-an-longue", "points": 40, "plancher": "rare",
                   "libelle": "A présidé l'Assemblée au moins un an", **commun,
                   "ids": longue}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(SORTIE, "presidence-an-courte.json"), "w", encoding="utf-8") as f:
        json.dump({"code": "presidence-an-courte", "points": 15, "plancher": None,
                   "libelle": "A présidé l'Assemblée", **commun,
                   "ids": courte}, f, ensure_ascii=False, indent=1)
    rapport.insert(1, f"Présidents rattachés : {len(periodes)} "
                      f"({len(longue)} au moins un an, {len(courte)} moins d'un an)")
    texte = "\n".join(rapport)
    with open(os.path.join(SORTIE, "presidences-rapport.txt"), "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    print(texte)


if __name__ == "__main__":
    main()
