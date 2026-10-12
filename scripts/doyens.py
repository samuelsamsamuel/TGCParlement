#!/usr/bin/env python3
"""Doyens d'âge de l'Assemblée — étape de mesure.

Source officielle : Assemblée nationale, « Doyens d'âge » (https://www.assemblee-nationale.fr/histoire/doyens.pdf),
tableau donnant pour chaque doyen son nom, ses dates et lieux de naissance et de décès, son département
d'élection et l'année où il a présidé comme doyen.

Le PDF est lu sans bibliothèque externe (flux compressés décodés par zlib, texte des opérateurs Tj/TJ).
Ce tableau s'arrête en 1857 et aucune liste officielle des benjamins n'a été trouvée. Doyens et
benjamins sont donc établis à partir des fiches Sycomore elles-mêmes : pour chaque législature, parmi
les députés dont le mandat commence dans les 30 jours suivant l'ouverture, le plus âgé (doyen) et le
plus jeune (benjamin) à la date d'ouverture. Le tableau officiel sert de contrôle sur 1789-1857 : le
rapport indique, doyen par doyen, si le calcul retrouve le même nom.
Sorties : data/listes/doyen-benjamin.json, data/sources/doyens.txt, data/listes/rapports/doyens-rapport.txt
"""
import json
import unicodedata
from collections import defaultdict
from datetime import date
import os
import re
import time
import urllib.error
import urllib.request
import zlib

URL = "https://www.assemblee-nationale.fr/histoire/doyens.pdf"
SORTIE = os.path.join("data", "sources", "doyens.txt")
RAPPORT = os.path.join("data", "listes", "rapports", "doyens-rapport.txt")


def telecharger():
    for attente in (0, 20, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "TGCParlement/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.URLError as e:
            erreur = e
    raise SystemExit(f"Échec du téléchargement : {erreur}")


def chaine_pdf(s):
    """Décode une chaîne littérale PDF (échappements \\n, \\(, \\ooo)."""
    sortie, i = bytearray(), 0
    while i < len(s):
        c = s[i]
        if c == 0x5C and i + 1 < len(s):
            n = s[i + 1]
            if 0x30 <= n <= 0x37:
                j = i + 1
                while j < len(s) and j < i + 4 and 0x30 <= s[j] <= 0x37:
                    j += 1
                sortie.append(int(s[i + 1:j], 8) & 0xFF)
                i = j
                continue
            sortie.append({0x6E: 10, 0x72: 13, 0x74: 9}.get(n, n))
            i += 2
            continue
        sortie.append(c)
        i += 1
    return sortie.decode("cp1252", errors="replace")


def texte_flux(flux):
    lignes, courante = [], []
    for m in re.finditer(rb"\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD|ET|'", flux):
        jeton = m.group(0)
        if jeton.endswith(b"Tj"):
            courante.append(chaine_pdf(jeton[1:jeton.rindex(b")")]))
        elif jeton.endswith(b"TJ"):
            for p in re.finditer(rb"\((?:\\.|[^\\)])*\)|(-?\d+(?:\.\d+)?)", jeton):
                if p.group(0).startswith(b"("):
                    courante.append(chaine_pdf(p.group(0)[1:-1]))
                elif p.group(1) and float(p.group(1)) < -200:
                    courante.append(" ")
        else:
            if courante:
                lignes.append("".join(courante).strip())
                courante = []
    if courante:
        lignes.append("".join(courante).strip())
    return [l for l in lignes if l]


def norme(t):
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def calculer(cartes):
    """Doyen et benjamin de chaque législature, d'après les mandats et dates de naissance des fiches."""
    groupes = defaultdict(list)
    for c in cartes:
        if not c.get("naissance") or str(c["id"]).startswith(("S", "G-")):
            continue
        for m in c["mandats"]:
            if m.get("chambre") == "AN" and m.get("debut") and m.get("regime"):
                groupes[(m["regime"], m.get("legislature"))].append((m["debut"], c))
    resultat = []
    for (regime, leg), membres in groupes.items():
        ouverture = min(d for d, _ in membres)
        o = date.fromisoformat(ouverture)
        presents = {c["id"]: c for d, c in membres if (date.fromisoformat(d) - o).days <= 30}
        if len(presents) < 50:
            continue  # assemblée trop peu renseignée pour désigner sûrement doyen et benjamin
        # Âge à l'ouverture vraisemblable (18 ans minimum depuis 2011, 21 auparavant ; 105 au plus) :
        # une date de naissance ou de mandat erronée dans une fiche ne doit pas désigner le doyen ou le benjamin
        minimum = 18 if ouverture >= "2011" else 21

        def age(c):
            n = date.fromisoformat(c["naissance"])
            return o.year - n.year - ((o.month, o.day) < (n.month, n.day))
        valides = [c for c in presents.values() if minimum <= age(c) <= 105]
        ecartes = [f"{c['id']} {c['nom']} ({age(c)} ans)" for c in presents.values() if c not in valides]
        par_age = sorted(valides, key=lambda c: c["naissance"])
        resultat.append({"regime": regime, "legislature": leg, "ouverture": ouverture, "presents": len(presents),
                         "doyen": par_age[0], "benjamin": par_age[-1], "ecartes": ecartes,
                         "ages": (age(par_age[0]), age(par_age[-1]))})
    return sorted(resultat, key=lambda r: r["ouverture"])


def main():
    pdf = telecharger()
    lignes, flux_lus, flux_illisibles = [], 0, 0
    for m in re.finditer(rb"<<(.*?)>>\s*stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        entete, donnees = m.group(1), m.group(2)
        if b"/Image" in entete or b"/XObject" in entete and b"/Form" not in entete:
            continue
        if b"FlateDecode" in entete:
            try:
                donnees = zlib.decompress(donnees)
            except zlib.error:
                flux_illisibles += 1
                continue
        if b"Tj" in donnees or b"TJ" in donnees:
            flux_lus += 1
            lignes += texte_flux(donnees)
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    annees = re.findall(r"\b(1[789]\d\d|20\d\d)\b", " ".join(lignes))
    rapport = [f"Octets : {len(pdf)} ; pages annoncées : {pdf.count(b'/Type /Page') + pdf.count(b'/Type/Page')} ; "
               f"flux de texte lus : {flux_lus} ; flux illisibles : {flux_illisibles} ; lignes : {len(lignes)}",
               f"Années citées : de {min(annees) if annees else '?'} à {max(annees) if annees else '?'}",
               "\n--- 60 premières lignes ---"] + lignes[:60] + ["\n--- 80 dernières lignes ---"] + lignes[-80:]
    # Calcul sur les fiches, puis contrôle par le tableau officiel (1789-1857)
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    calcul = calculer(cartes)
    officiels = norme(" ".join(lignes))
    concordants = 0
    rapport.append("\n--- Doyens et benjamins calculés (contrôle : nom présent dans le tableau officiel, années ≤ 1863) ---")
    for r in calcul:
        nom_doyen = r["doyen"]["nom"]
        nom_famille = norme(nom_doyen.split(",")[-1].split()[-1])
        controle = ""
        if r["ouverture"] <= "1863":
            trouve = nom_famille in officiels
            concordants += trouve
            controle = "  [CONFORME au tableau]" if trouve else "  [ABSENT du tableau officiel]"
        rapport.append(f"{r['ouverture']} {r['regime']} | {r['legislature']} ({r['presents']} présents) : "
                       f"doyen {r['doyen']['id']} {nom_doyen} ({r['doyen']['naissance'][:4]}) ; "
                       f"benjamin {r['benjamin']['id']} {r['benjamin']['nom']} ({r['benjamin']['naissance'][:4]}) ; "
                       f"âges {r['ages'][0]} et {r['ages'][1]} ans{controle}"
                       + (f"\n    âge invraisemblable, écarté : {' ; '.join(r['ecartes'])}" if r["ecartes"] else ""))
    avant = sum(1 for r in calcul if r["ouverture"] <= "1863")
    rapport.insert(2, f"Législatures retenues : {len(calcul)} ; contrôle 1789-1863 : {concordants} doyens conformes sur {avant}")
    ids = sorted({r[k]["id"] for r in calcul for k in ("doyen", "benjamin")}, key=str)
    with open(os.path.join("data", "listes", "doyen-benjamin.json"), "w", encoding="utf-8") as f:
        json.dump({"code": "doyen-benjamin", "points": 5, "plancher": None,
                   "libelle": "Doyen d'âge ou benjamin d'une législature",
                   "source": "Calcul sur les fiches Sycomore (dates de naissance et de début de mandat), "
                             "contrôlé par le tableau officiel des doyens d'âge " + URL,
                   "ids": ids}, f, ensure_ascii=False, indent=1)
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:3]))


if __name__ == "__main__":
    main()
