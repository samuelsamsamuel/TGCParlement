#!/usr/bin/env python3
"""Gouvernements provisoires de la Libération et de la IVe République (1944-1959).

Source : « Composition des gouvernements provisoires suivant la Libération et des gouvernements
de la 4ème République (1944-1959) », producteur : Premier ministre (data.gouv.fr, Licence Ouverte).
Le fichier est publié au format RTF.

Première étape (mesure) : téléchargement, conversion du RTF en texte brut, et rapport sur sa
structure, afin d'écrire ensuite la lecture des lignes sur pièces plutôt qu'à l'aveugle.
Sorties : data/gouvernement/ive.txt et data/listes/rapports/gouvernements-ive-rapport.txt
Bibliothèque standard uniquement.
"""
import os
import re
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
    print("\n".join(rapport[:2]))


if __name__ == "__main__":
    main()
