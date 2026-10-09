#!/usr/bin/env python3
"""Extraction des fiches Sycomore (base des députés français depuis 1789).

Phase 1, au premier lancement : inventaire des identifiants de fiches, tirés
des listes par législature et des identifiants Sycomore connus de Wikidata.
Résultat : data/sycomore/ids.json.

Phase 2 : téléchargement des fiches, une requête par seconde, en reprenant là
où l'exécution précédente s'est arrêtée. Chaque fiche est conservée en texte
brut (informations générales et sections de mandats, sans les biographies)
dans data/sycomore/fiches.jsonl. La mise en forme des mandats se fera ensuite
à partir de ce fichier, sans nouveau téléchargement.

Bibliothèque standard de Python uniquement.
"""
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser

BASE = "https://www2.assemblee-nationale.fr/sycomore"
DOSSIER = os.path.join("data", "sycomore")
F_IDS = os.path.join(DOSSIER, "ids.json")
F_FICHES = os.path.join(DOSSIER, "fiches.jsonl")

DELAI = float(os.environ.get("DELAI", "1.0"))               # secondes entre deux requêtes
BUDGET = float(os.environ.get("BUDGET_MINUTES", "300")) * 60  # durée maximale d'une exécution
LISTE_MAX = int(os.environ.get("LISTE_MAX", "200"))          # numéro de liste le plus élevé essayé
CONTACT = os.environ.get("CONTACT", "contact non renseigne")
UA = "Projet parlementaires, extraction autorisee par l'Assemblee nationale (" + CONTACT + ")"
DEBUT = time.monotonic()
AUJOURDHUI = datetime.now(timezone.utc).strftime("%Y-%m-%d")


def temps_restant():
    return BUDGET - (time.monotonic() - DEBUT)


def telecharger(url):
    """Renvoie (statut HTTP, texte). Statut None en cas d'échec réseau persistant."""
    attentes = [10, 30, 90]
    dernier = None
    for essai in range(len(attentes) + 1):
        time.sleep(DELAI)
        requete = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(requete, timeout=60) as reponse:
                return reponse.status, reponse.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as erreur:
            dernier = erreur.code
            if erreur.code not in (429, 500, 502, 503, 504):
                return erreur.code, ""
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError):
            dernier = None
        if essai < len(attentes):
            time.sleep(attentes[essai])
    return dernier, ""


# --- Lecture du HTML en lignes de texte --------------------------------------

BLOCS = {"p", "div", "li", "br", "tr", "td", "th", "dt", "dd", "ul", "ol", "table",
         "section", "article", "header", "footer", "nav", "h1", "h2", "h3", "h4", "h5", "h6"}
TITRES = {"h1", "h2", "h3"}


class Lignes(HTMLParser):
    """Découpe une page en lignes de texte, chacune associée au titre (h1-h3) qui la porte."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lignes = []
        self.tampon = []
        self.titre = None
        self.ignorer = 0

    def _vider(self):
        texte = " ".join(" ".join(self.tampon).split())
        self.tampon = []
        if texte:
            self.lignes.append((self.titre, texte))

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.ignorer += 1
        elif tag in BLOCS:
            self._vider()
            if tag in TITRES:
                self.titre = tag

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.ignorer = max(0, self.ignorer - 1)
        elif tag in BLOCS:
            self._vider()
            if tag in TITRES:
                self.titre = None

    def handle_data(self, data):
        if not self.ignorer:
            self.tampon.append(data)

    def close(self):
        super().close()
        self._vider()


def lignes_de(html):
    lecteur = Lignes()
    lecteur.feed(html)
    lecteur.close()
    return lecteur.lignes


def analyser_fiche(html):
    """Nom (titre h1) et texte brut des sections utiles : informations générales et mandats."""
    nom, sections, courante = None, {}, None
    for balise, texte in lignes_de(html):
        if balise == "h1":
            nom, sections, courante = texte, {"general": []}, "general"
            continue
        if nom is None:
            continue
        if balise == "h2":
            courante = texte
            if "mandat" in texte.lower():
                sections.setdefault(courante, [])
            continue
        if courante in sections:
            sections[courante].append("### " + texte if balise == "h3" else texte)
    return nom, sections


# --- Phase 1 : inventaire des identifiants -----------------------------------

RE_FICHE = re.compile(r"sycomore/fiche(?:/\(num_dept\))?(?:/|\?num_dept=)(\d+)")
RE_NOMBRE = re.compile(r"Nombre de d.put.s trouv.s\s*:\s*(\d+)")


def ids_wikidata():
    requete = "SELECT ?id WHERE { ?p wdt:P1045 ?id . }"
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode(
        {"query": requete, "format": "json"})
    statut, texte = telecharger(url)
    if statut != 200:
        print(f"Wikidata : échec (statut {statut}), inventaire limité aux listes", flush=True)
        return []
    ids = set()
    for ligne in json.loads(texte)["results"]["bindings"]:
        valeur = ligne["id"]["value"].strip()
        if valeur.isdigit():
            ids.add(int(valeur))
    return sorted(ids)


def inventaire():
    listes, vides = {}, 0
    for n in range(1, LISTE_MAX + 1):
        statut, html = telecharger(f"{BASE}/liste/{n}")
        ids = sorted({int(x) for x in RE_FICHE.findall(html)})
        lignes = lignes_de(html) if html else []
        titre = next((t for b, t in lignes if b == "h1"), None)
        trouve = RE_NOMBRE.search(" ".join(t for _, t in lignes))
        annonce = int(trouve.group(1)) if trouve else None
        listes[str(n)] = {"statut": statut, "titre": titre, "annonce": annonce, "ids": ids}
        print(f"liste {n} : statut {statut}, {len(ids)} fiches (annoncé : {annonce}), {titre}", flush=True)
        vides = vides + 1 if not ids else 0
        if vides >= 25:
            break
    par_listes = {i for l in listes.values() for i in l["ids"]}
    par_wikidata = set(ids_wikidata())
    tous = sorted(par_listes | par_wikidata)
    print(f"Inventaire : {len(par_listes)} par les listes, {len(par_wikidata)} par Wikidata, "
          f"{len(par_listes & par_wikidata)} en commun, {len(tous)} au total", flush=True)
    if tous:
        with open(F_IDS, "w", encoding="utf-8") as f:
            json.dump({"date": AUJOURDHUI, "listes": listes, "wikidata": sorted(par_wikidata),
                       "tous": tous}, f, ensure_ascii=False)
    return tous


# --- Phase 2 : téléchargement des fiches -------------------------------------

def deja_traites():
    faits = set()
    if os.path.exists(F_FICHES):
        with open(F_FICHES, encoding="utf-8") as f:
            for ligne in f:
                try:
                    faits.add(json.loads(ligne)["id"])
                except (ValueError, KeyError):
                    pass
    return faits


def bilan():
    statuts, sans_nom = Counter(), 0
    if os.path.exists(F_FICHES):
        with open(F_FICHES, encoding="utf-8") as f:
            for ligne in f:
                enreg = json.loads(ligne)
                statuts[enreg["statut"]] += 1
                if enreg["statut"] == 200 and not enreg.get("nom"):
                    sans_nom += 1
    print(f"Fichier : {dict(statuts)} ; fiches 200 sans nom lisible : {sans_nom}", flush=True)


def main():
    os.makedirs(DOSSIER, exist_ok=True)
    if os.path.exists(F_IDS):
        with open(F_IDS, encoding="utf-8") as f:
            tous = json.load(f)["tous"]
    else:
        tous = inventaire()
    if not tous:
        print("Aucun identifiant trouvé : arrêt.", flush=True)
        return
    faits = deja_traites()
    a_faire = [i for i in tous if i not in faits]
    print(f"{len(tous)} identifiants, {len(faits)} déjà traités, {len(a_faire)} restants", flush=True)

    traites, echecs_suivis = 0, 0
    with open(F_FICHES, "a", encoding="utf-8") as sortie:
        for i in a_faire:
            if temps_restant() < 120:
                print("Budget de temps atteint : reprise à la prochaine exécution.", flush=True)
                break
            statut, html = telecharger(f"{BASE}/fiche/{i}")
            if statut not in (200, 404, 410):
                echecs_suivis += 1
                if echecs_suivis >= 20:
                    print(f"20 échecs consécutifs (dernier statut : {statut}) : arrêt par précaution.", flush=True)
                    break
                continue
            echecs_suivis = 0
            enreg = {"id": i, "statut": statut, "date": AUJOURDHUI}
            if statut == 200:
                enreg["nom"], enreg["sections"] = analyser_fiche(html)
            sortie.write(json.dumps(enreg, ensure_ascii=False) + "\n")
            sortie.flush()
            traites += 1
            if traites % 250 == 0:
                print(f"{traites} fiches traitées dans cette exécution", flush=True)

    reste = len(a_faire) - traites
    print(f"Exécution terminée : {traites} fiches traitées, {reste} restantes.", flush=True)
    if reste == 0:
        print("EXTRACTION COMPLÈTE.", flush=True)
    bilan()


if __name__ == "__main__":
    main()
