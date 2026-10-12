#!/usr/bin/env python3
"""Doyens d'âge de l'Assemblée — étape de mesure.

Source officielle : Assemblée nationale, « Doyens d'âge » (https://www.assemblee-nationale.fr/histoire/doyens.pdf),
tableau donnant pour chaque doyen son nom, ses dates et lieux de naissance et de décès, son département
d'élection et l'année où il a présidé comme doyen.

Le PDF est lu sans bibliothèque externe (flux compressés décodés par zlib, texte des opérateurs Tj/TJ).
Cette première étape écrit le texte obtenu et un rapport, pour vérifier que la lecture est fidèle
avant de constituer la liste. Sorties : data/sources/doyens.txt, data/listes/rapports/doyens-rapport.txt
"""
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
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:2]))


if __name__ == "__main__":
    main()
