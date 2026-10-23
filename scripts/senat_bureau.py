#!/usr/bin/env python3
"""Bureau du Sénat (vice-présidents, questeurs, secrétaires) : étape de mesure.

Source officielle : data.senat.fr, export complet de la base « Sénateurs »
(https://data.senat.fr/data/senateurs/export_sens.zip), sauvegarde PostgreSQL au format texte
(CREATE TABLE, COMMENT, COPY ... FROM stdin). Les exports thématiques (ODSEN_*.csv) ne portent pas
l'historique du Bureau. ODSEN_GENERAL.csv n'en donne que la dernière fonction connue de chaque sénateur
(colonne « Fonction au Bureau du Sénat »).

La sauvegarde est lue sans bibliothèque externe. Le script liste toutes les tables (nombre de lignes,
commentaire), détaille celles du Bureau (colonnes, commentaires de colonnes, valeurs les plus fréquentes)
et mesure la couverture de la table senbur fonction par fonction : périodes, dates manquantes, Bureau en
cours, rattachement des matricules aux cartes (data/senat/correspondances.json). Il compare enfin le
Bureau en cours avec la colonne d'ODSEN_GENERAL.csv.
Rien n'est encore écrit dans les listes : la lecture viendra une fois cette mesure lue.
Sortie : data/listes/rapports/senat-bureau-rapport.txt
"""
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter, OrderedDict, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from senateurs import BASE, UA, telecharger  # noqa: E402

ARCHIVE = "export_sens.zip"
RAPPORT = os.path.join("data", "listes", "rapports", "senat-bureau-rapport.txt")
NUL = "\\N"  # valeur nulle du format COPY de PostgreSQL


def telecharger_archive():
    erreur = None
    for attente in (0, 20, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request(BASE + ARCHIVE, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.URLError as e:
            erreur = e
    raise SystemExit(f"Échec du téléchargement de {ARCHIVE} : {erreur}")


def lire_sauvegarde(flux):
    """Tables de la sauvegarde : colonnes (nom, type), commentaires, lignes du COPY."""
    tables, cree, copie = OrderedDict(), None, None
    for ligne in flux:
        if copie:
            if ligne.startswith("\\."):
                copie = None
            else:
                tables[copie]["lignes"].append(ligne.rstrip("\n").split("\t"))
            continue
        m = re.match(r"CREATE TABLE (\w+) \(", ligne)
        if m:
            cree = m.group(1)
            tables[cree] = {"colonnes": [], "commentaire": "", "commentaires": {}, "lignes": [], "copie": []}
            continue
        if cree:
            if ligne.startswith(");"):
                cree = None
            elif (m := re.match(r"\s+(\w+) (.+?),?$", ligne)):
                tables[cree]["colonnes"].append((m.group(1), m.group(2)))
            continue
        if (m := re.match(r"COMMENT ON TABLE (\w+) IS '(.*)';", ligne)) and m.group(1) in tables:
            tables[m.group(1)]["commentaire"] = m.group(2).replace("''", "'")
        elif (m := re.match(r"COMMENT ON COLUMN (\w+)\.(\w+) IS '(.*)';", ligne)) and m.group(1) in tables:
            tables[m.group(1)]["commentaires"][m.group(2)] = m.group(3).replace("''", "'")
        elif (m := re.match(r"COPY (\w+) \((.*)\) FROM stdin;", ligne)) and m.group(1) in tables:
            copie = m.group(1)
            tables[copie]["copie"] = [c.strip() for c in m.group(2).split(",")]
    return tables


def enregistrements(table):
    noms = table["copie"] or [c for c, _ in table["colonnes"]]
    return [dict(zip(noms, l)) for l in table["lignes"]]


def jour(v):
    return None if not v or v == NUL else v[:10]


def detailler(nom, table, r):
    r.append(f"\n## Table {nom} : {table['commentaire']} ({len(table['lignes'])} lignes)")
    lignes = enregistrements(table)
    for col, typ in table["colonnes"]:
        valeurs = Counter(l.get(col) for l in lignes)
        r.append(f"  {col} ({typ}) : {table['commentaires'].get(col, '')}")
        r.append(f"      {len(valeurs)} valeurs distinctes, {valeurs.get(NUL, 0)} nulles ; "
                 + ", ".join(f"{v} ({n})" for v, n in valeurs.most_common(6))[:300])


def main():
    r = []
    brut = telecharger_archive()
    with zipfile.ZipFile(io.BytesIO(brut)) as z:
        membres = z.infolist()
        r.append(f"Archive {BASE}{ARCHIVE} : {len(brut)} octets ; "
                 + ", ".join(f"{m.filename} ({m.file_size} octets, {'-'.join(map(str, m.date_time[:3]))})" for m in membres))
        sql = next(m for m in membres if m.filename.endswith(".sql"))
        with z.open(sql) as f:
            tables = lire_sauvegarde(io.TextIOWrapper(f, encoding="utf-8"))

    r.append(f"\n# {len(tables)} tables")
    r += [f"  {n:26} {len(t['lignes']):>7} lignes  {t['commentaire']}" for n, t in tables.items()]

    du_bureau = [n for n, t in tables.items() if re.search(r"\bbureau\b", t["commentaire"], re.I)]
    r.append("\n# Tables du Bureau (commentaire contenant « bureau ») : " + ", ".join(du_bureau))
    for n in du_bureau:
        detailler(n, tables[n], r)
    if "bur" not in tables or "senbur" not in tables:
        r.append("\nTables bur et senbur absentes : mesure arrêtée.")
        return ecrire(r)

    libelles = {l["burcod"]: l["burlil"] for l in enregistrements(tables["bur"])}
    senbur = enregistrements(tables["senbur"])
    noms = {l["senmat"]: f"{l.get('senprenomuse', '')} {l.get('sennomuse', '')}".strip()
            for l in enregistrements(tables.get("sen", {"colonnes": [], "lignes": [], "copie": []}))}
    with open(os.path.join("data", "senat", "correspondances.json"), encoding="utf-8") as f:
        carte_de = json.load(f)

    r.append("\n# Couverture de senbur par fonction")
    par_code = defaultdict(list)
    for l in senbur:
        par_code[l["burcod"]].append(l)
    for code, ls in sorted(par_code.items(), key=lambda x: -len(x[1])):
        debuts = sorted(d for d in (jour(l["senburdatdeb"]) for l in ls) if d)
        personnes = {l["senmat"] for l in ls}
        r.append(f"  {code} ({libelles.get(code)}) : {len(ls)} lignes, {len(personnes)} personnes, "
                 f"{sum(m in carte_de for m in personnes)} rattachées à une carte ; débuts "
                 f"{debuts[0] if debuts else '-'} -> {debuts[-1] if debuts else '-'} ; "
                 f"sans début {sum(not jour(l['senburdatdeb']) for l in ls)}, "
                 f"sans fin {sum(not jour(l['senburdatfin']) for l in ls)}, "
                 f"code de validité ACTIF {sum(l['temvalcod'] == 'ACTIF' for l in ls)}")

    bureau = [l for l in senbur if l["burcod"] != "AUCUNSEN"]
    r.append("\n# Débuts de fonction au Bureau par décennie : " + ", ".join(
        f"{d}0 ({n})" for d, n in sorted(Counter(jour(l["senburdatdeb"])[:3] for l in bureau if jour(l["senburdatdeb"])).items())))
    anomalies = [l for l in bureau if jour(l["senburdatdeb"]) and jour(l["senburdatfin"])
                 and jour(l["senburdatfin"]) < jour(l["senburdatdeb"])]
    r.append("\n# Fin antérieure au début : " + (", ".join(
        f"{l['burcod']} {noms.get(l['senmat'], l['senmat'])} ({jour(l['senburdatdeb'])} -> {jour(l['senburdatfin'])})"
        for l in anomalies) or "aucune"))
    r.append("# Sans date de début : " + (", ".join(
        f"{l['burcod']} {noms.get(l['senmat'], l['senmat'])} (fin {jour(l['senburdatfin'])})"
        for l in bureau if not jour(l["senburdatdeb"])) or "aucune"))
    r.append("# Observations : " + " | ".join(l["eveobs"] for l in senbur if l.get("eveobs") not in (None, NUL)))

    en_cours = sorted((l for l in bureau if l["temvalcod"] == "ACTIF"),
                      key=lambda l: int(l["senburrngele"]) if l["senburrngele"].isdigit() else 99)
    r.append("\n# Bureau en cours (code de validité ACTIF) : " + ", ".join(
        f"{c} {n}" for c, n in Counter(l["burcod"] for l in en_cours).items()))
    r += [f"  rang {l['senburrngele']:>3}  {libelles.get(l['burcod'])} : {noms.get(l['senmat'], l['senmat'])} "
          f"({l['senmat']}, depuis {jour(l['senburdatdeb'])})" for l in en_cours]

    r.append("\n# Contrôle par ODSEN_GENERAL.csv (« Fonction au Bureau du Sénat », dernière fonction connue)")
    try:
        general = telecharger("ODSEN_GENERAL.csv")
        col = next((k for k in general[0] if "bureau" in k.lower()), None)
        r.append(f"  colonne : {col} ; valeurs : " + ", ".join(
            f"{v or '(vide)'} ({n})" for v, n in Counter((l.get(col) or "").strip() for l in general).most_common()))
        actuels = {l["senmat"] for l in en_cours}
        etat = next((k for k in general[0] if k.strip().lower().startswith("état")), None)
        dans_general = {l["Matricule"] for l in general if (l.get(col) or "").strip()
                        and (not etat or l.get(etat, "").strip().upper() == "ACTIF")}
        r.append(f"  sénateurs actifs portant une fonction au Bureau : {len(dans_general)} ; Bureau en cours de senbur : "
                 f"{len(actuels)} ; dans senbur seulement : {sorted(actuels - dans_general)} ; "
                 f"dans ODSEN_GENERAL seulement : {sorted(dans_general - actuels)}")
    except (SystemExit, StopIteration, IndexError, KeyError) as e:
        r.append(f"  contrôle impossible : {e}")
    ecrire(r)


def ecrire(r):
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(r) + "\n")
    print("\n".join(l for l in r if l.startswith("#") or l.startswith("Archive")))


if __name__ == "__main__":
    main()
