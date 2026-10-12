#!/usr/bin/env python3
"""Gouvernements provisoires de la Libération et de la IVe République (1944-1959).

Source : « Composition des gouvernements provisoires suivant la Libération et des gouvernements
de la 4ème République (1944-1959) », producteur : Premier ministre (data.gouv.fr, Licence Ouverte).
Le fichier est publié au format RTF.

Étapes : téléchargement, conversion du RTF en texte brut, puis lecture des fonctions. Le document
alterne un intitulé de fonction et un nom (« Prénom NOM », nom de famille en capitales), parfois sur
la même ligne ; chaque gouvernement s'ouvre par le nom de son chef suivi de ses dates entre
parenthèses. Les lignes « puis à compter du… », « jusqu'au… » précisent la date de la nomination
suivante.
Sorties : data/gouvernement/ive.txt (texte brut), data/gouvernement/ive_lignes.json (fonctions lues,
reprises par gouvernements.py pour le rattachement) et data/listes/rapports/gouvernements-ive-rapport.txt
Bibliothèque standard uniquement.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter

URL = "https://www.data.gouv.fr/api/1/datasets/r/cff9dcb5-41bf-4456-8af7-aa4a472e1c0c"
SORTIE = os.path.join("data", "gouvernement", "ive.txt")
RAPPORT = os.path.join("data", "listes", "rapports", "gouvernements-ive-rapport.txt")


def telecharger():
    for attente in (0, 20, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "TGCParlement/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.URLError as e:
            erreur = e
    raise SystemExit(f"Échec du téléchargement : {erreur}")


def rtf_en_texte(rtf):
    """Conversion RTF -> texte : groupes de métadonnées ignorés, \\'xx en Windows-1252,
    \\uN en Unicode, \\par et \\row en fin de ligne, \\cell en tabulation."""
    ignores = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer",
               "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable",
               "rsidtbl", "xmlnstbl", "generator", "themedata", "colorschememapping",
               "datastore", "latentstyles", "pgdsctbl", "object", "fldinst"}
    pile, ignorer, sortie, i, n, sauter = [], False, [], 0, len(rtf), 0
    jeton = re.compile(r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)")
    for m in jeton.finditer(rtf):
        mot, arg, hexa, sym, accolade, texte = m.groups()
        if accolade == "{":
            pile.append(ignorer)
        elif accolade == "}":
            ignorer = pile.pop() if pile else False
        elif mot:
            if mot in ignores or (mot == "*"):
                ignorer = True
            elif ignorer:
                continue
            elif mot in ("par", "line", "row", "sect", "page"):
                sortie.append("\n")
            elif mot == "cell":
                sortie.append("\t")
            elif mot == "tab":
                sortie.append(" ")
            elif mot == "u" and arg:
                code = int(arg)
                sortie.append(chr(code + 65536 if code < 0 else code))
                sauter = 1
        elif sym:
            if sym == "*":
                ignorer = True
            elif not ignorer and sym in "\\{}":
                sortie.append(sym)
            elif not ignorer and sym == "~":
                sortie.append(" ")
        elif hexa and not ignorer:
            if sauter:
                sauter = 0
                continue
            sortie.append(bytes([int(hexa, 16)]).decode("cp1252", errors="replace"))
        elif texte and not ignorer:
            if sauter:
                texte, sauter = texte[1:], 0
            sortie.append(texte)
    lignes = ["\t".join(c.strip() for c in l.split("\t")).strip("\t ") for l in "".join(sortie).split("\n")]
    return "\n".join(l for l in lignes if l.strip())


sys.path.insert(0, os.path.dirname(__file__))
from cartes import lire_date  # noqa: E402

F_LIGNES = os.path.join("data", "gouvernement", "ive_lignes.json")
TITRES = {"général", "amiral", "maréchal", "colonel", "docteur", "professeur"}
PARTICULES = {"de", "du", "des", "la", "le", "d'", "l'"}
DEBUTS_FONCTION = ("ministre", "garde des sceaux", "vice-président", "président", "se", "sous-se",
                   "secrétaire", "sous-secrétaire", "haut-commissaire", "haut commissaire")
QUALIFICATIFS = ("puis", "jusqu", "à compter", "a compter", "du ", "en rouge", "en marron", "en vert",
                 "également", "(")
RE_ENTETE = re.compile(r"^\((\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")


def est_nom(cellule):
    """« Prénom NOM » : au moins un mot en capitales (le nom), précédé d'au moins un prénom."""
    c = re.sub(r"\s+\d+$", "", cellule.strip())
    bas = c.lower()
    if not c or bas.startswith(DEBUTS_FONCTION) or bas.startswith(QUALIFICATIFS):
        return None
    mots = c.split()
    if mots and mots[0].lower().strip(".") in TITRES:
        mots = mots[1:]
    i = next((k for k, w in enumerate(mots)
              if len(re.sub(r"[^A-Za-zÀ-ÿ]", "", w)) >= 2 and w == w.upper() and re.search(r"[A-ZÀ-Ý]", w)), None)
    if i is None or i == 0:
        return None
    debut = i
    while debut > 1 and mots[debut - 1].lower() in PARTICULES:
        debut -= 1
    prenom, nom = " ".join(mots[:debut]), " ".join(mots[debut:])
    if not prenom[:1].isupper():
        return None
    return prenom, nom


def casse(nom):
    """« COUVE de MURVILLE » -> « Couve de Murville », « TANGUY-PRIGENT » -> « Tanguy-Prigent »."""
    return " ".join("-".join(x[:1] + x[1:].lower() for x in w.split("-")) if w.isupper() else w
                    for w in nom.split())


def categorie(fonction):
    f = fonction.lower()
    if f.startswith("président"):
        return "chef-gouvernement"
    if f.startswith(("se", "sous-se", "secrétaire", "sous-secrétaire")):
        return "secretaire-etat"
    if f.startswith(("ministre", "garde des sceaux", "vice-président")):
        return "ministre"
    return None


def lire_fonctions(texte):
    lignes = texte.split("\n")
    resultat, fonction, debut_gvt, date_suivante = [], None, None, None
    for k, ligne in enumerate(lignes):
        ligne = re.sub(r"(?i)\bsous-\s+se\b", "Sous-SE", ligne)  # « Sous- SE » dans la source
        cellules = [c for c in ligne.split("\t") if c.strip()]
        suivante = lignes[k + 1].strip() if k + 1 < len(lignes) else ""
        m = RE_ENTETE.match(suivante)
        if m and len(cellules) == 1 and est_nom(cellules[0]):
            # En-tête de gouvernement : « Charles de GAULLE 1 » suivi de « (10/09/44 21/11/45) »
            j, mo, a = int(m.group(1)), int(m.group(2)), int(m.group(3))
            debut_gvt = f"{(1900 + a) if a < 100 else a}-{mo:02d}-{j:02d}"
            fonction, date_suivante = None, None
            continue
        for cellule in cellules:
            nom = est_nom(cellule)
            if nom:
                cat = categorie(fonction or "")
                if cat:
                    resultat.append({"liste": cat, "prenom": nom[0], "nom": casse(nom[1]),
                                     "debut": date_suivante or debut_gvt, "fonction": fonction})
                date_suivante = None
                continue
            bas = cellule.lower()
            d = re.search(r"(?:à|a) compter du (\d{1,2}(?:er)? [a-zéû]+ \d{4})", bas)
            if d and lire_date(d.group(1)):
                date_suivante = lire_date(d.group(1)).isoformat()
            if categorie(cellule):
                fonction = cellule.strip()
    return resultat


def main():
    brut = telecharger()
    rtf = brut.decode("latin-1")
    texte = rtf_en_texte(rtf)
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    lignes = texte.split("\n")
    cellules = Counter(l.count("\t") + 1 for l in lignes)
    dates = sum(1 for l in lignes if re.search(r"\b\d{1,2}(er)? [a-zéû]+ 19[45]\d\b", l))
    rapport = [f"Octets téléchargés : {len(brut)} ; lignes de texte : {len(lignes)} ; lignes avec une date 194x/195x : {dates}",
               "Nombre de cellules par ligne : " + ", ".join(f"{k} : {v}" for k, v in sorted(cellules.items())),
               "\n--- 120 premières lignes ---"] + lignes[:120] + ["\n--- 60 lignes au milieu ---"] \
              + lignes[len(lignes) // 2: len(lignes) // 2 + 60] + ["\n--- 40 dernières lignes ---"] + lignes[-40:]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    fonctions = lire_fonctions(texte)
    with open(F_LIGNES, "w", encoding="utf-8") as f:
        json.dump(fonctions, f, ensure_ascii=False, indent=0)
    par_liste = Counter(f["liste"] for f in fonctions)
    rapport.insert(2, "Fonctions lues : " + ", ".join(f"{k} {v}" for k, v in par_liste.items())
                   + f" ; personnes distinctes : {len({(f['prenom'], f['nom']) for f in fonctions})}")
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:3]))


if __name__ == "__main__":
    main()
