#!/usr/bin/env python3
"""Bureau du Sénat (vice-présidents, questeurs, secrétaires) : mesure puis lecture.

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

Lecture : les vice-présidences et questures rejoignent la liste bureau-vp-questeur (8 points), les
secrétariats la liste bureau-secretaire (3 points), établies pour l'Assemblée par gouvernements_an.py
(mêmes codes, mêmes points). La présidence du Sénat, déjà couverte par presidences_senat.py, et le code
AUCUNSEN (simple sénateur) ne sont pas retenus. Les intitulés sont ceux de la table bur, au féminin pour
les sénatrices. Les lignes successives d'une même fonction (un renouvellement du Bureau ouvre une nouvelle
ligne) sont fusionnées quand l'écart ne dépasse pas 31 jours. Les dates incohérentes sont tranchées par
DECISIONS_INTEGREES.
Sorties : data/listes/{bureau-vp-questeur,bureau-secretaire}.json (complétées),
data/gouvernement/fonctions_assemblee.json (complété), data/listes/rapports/senat-bureau-rapport.txt
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
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from senateurs import BASE, UA, telecharger  # noqa: E402

ARCHIVE = "export_sens.zip"
RAPPORT = os.path.join("data", "listes", "rapports", "senat-bureau-rapport.txt")
NUL = "\\N"  # valeur nulle du format COPY de PostgreSQL

LISTES = {"VICPDTSEN": "bureau-vp-questeur", "QUESTESEN": "bureau-vp-questeur", "SECRETSEN": "bureau-secretaire"}
LIBELLES = {"bureau-vp-questeur": (8, "A été vice-président ou questeur de l'Assemblée ou du Sénat"),
            "bureau-secretaire": (3, "A été secrétaire de l'Assemblée ou du Sénat")}
ECART_FUSION = 31  # jours entre la fin d'une ligne et le début de la suivante pour une même fonction
SOURCE = "Sénat, open data (export complet de la base Sénateurs, Bureau), depuis 1959"
# Décisions motivées sur les lignes de senbur aux dates incohérentes : (matricule, code, début lu, fin lue)
DECISIONS_INTEGREES = {
    "fin antérieure au début": (
        "La fonction est retenue (la ligne l'atteste) mais ses deux dates sont omises : la source ne permet "
        "pas de dire laquelle est fausse. Cas relevés : François Monsarrat, secrétaire (1955-10-06 -> "
        "1955-10-04), Catherine Lagatu, secrétaire (1974-10-03 -> 1972-10-02)."),
    "sans date de début": (
        "La fonction est retenue avec sa seule date de fin ; la date de début n'est pas reconstituée."),
}


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

    lecture(tables, bureau, carte_de, noms, r)
    ecrire(r)


def ecart(fin, debut):
    return (date.fromisoformat(debut) - date.fromisoformat(fin)).days


def lecture(tables, bureau, carte_de, noms, r):
    r.append("\n# Lecture")
    for motif, texte in DECISIONS_INTEGREES.items():
        r.append(f"  DÉCISION ({motif}) : {texte}")
    fem = {l["burcod"]: l["burlilfem"] for l in enregistrements(tables["bur"])}
    masc = {l["burcod"]: l["burlil"] for l in enregistrements(tables["bur"])}
    femmes = {l["senmat"] for l in enregistrements(tables["sen"]) if l.get("quacod") in ("Mme", "Mlle")}

    periodes = defaultdict(list)  # (matricule, code) -> [(début, fin)]
    for l in bureau:
        if l["burcod"] not in LISTES:
            continue
        debut, fin = jour(l["senburdatdeb"]), jour(l["senburdatfin"])
        if debut and fin and fin < debut:
            debut = fin = None  # DECISIONS_INTEGREES, « fin antérieure au début »
        periodes[(l["senmat"], l["burcod"])].append((debut, fin))

    ajouts, orphelins, lignes = defaultdict(set), set(), defaultdict(list)
    for (matricule, code), ps in periodes.items():
        ident = carte_de.get(matricule)
        if ident is None:
            orphelins.add(matricule)
            continue
        liste = LISTES[code]
        ajouts[liste].add(ident)
        titre = (fem if matricule in femmes else masc)[code]
        datees = sorted((p for p in ps if p[0]), key=lambda p: p[0])
        fusion = []
        for debut, fin in datees:
            if fusion and fusion[-1][1] and ecart(fusion[-1][1], debut) <= ECART_FUSION:
                fusion[-1][1] = None if fin is None else max(fin, fusion[-1][1])
            elif fusion and fusion[-1][1] is None:
                continue  # fonction encore ouverte : la ligne suivante est englobée
            else:
                fusion.append([debut, fin])
        fusion += [[None, fin] for debut, fin in ps if not debut]
        for debut, fin in fusion:
            lignes[str(ident)].append({"fonction": titre, "liste": liste, "debut": debut, "fin": fin})

    # Listes : ajout aux membres établis pour l'Assemblée
    for liste, (points, libelle) in LIBELLES.items():
        chemin = os.path.join("data", "listes", liste + ".json")
        contenu = {"code": liste, "points": points, "plancher": None, "libelle": libelle, "source": "", "ids": []}
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as f:
                contenu = json.load(f)
        avant = len(contenu["ids"])
        contenu["ids"] = sorted(set(contenu["ids"]) | ajouts[liste], key=str)
        contenu["libelle"], contenu["points"] = libelle, points
        if SOURCE not in (contenu.get("source") or ""):
            contenu["source"] = " ; ".join(x for x in (contenu.get("source"), SOURCE) if x)
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(contenu, f, ensure_ascii=False, indent=1)
        r.append(f"  {liste} : {len(ajouts[liste])} sénateurs ; liste {avant} -> {len(contenu['ids'])} cartes")

    # Détail des fonctions : les lignes du Bureau du Sénat sont remplacées à chaque exécution
    f_detail = os.path.join("data", "gouvernement", "fonctions_assemblee.json")
    detail = {}
    if os.path.exists(f_detail):
        with open(f_detail, encoding="utf-8") as f:
            detail = json.load(f)
    titres = set(masc.values()) | set(fem.values())
    for ident in list(detail):
        detail[ident] = [x for x in detail[ident] if x["fonction"] not in titres]
    for ident, ls in lignes.items():
        detail.setdefault(ident, []).extend(sorted(ls, key=lambda x: x["debut"] or x["fin"] or ""))
    detail = {k: v for k, v in detail.items() if v}
    with open(f_detail, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=0)
    r.append(f"  détail des fonctions : {sum(map(len, lignes.values()))} périodes pour {len(lignes)} cartes ; "
             f"matricules sans carte : {len(orphelins)} {sorted(orphelins)[:10]}")
    r.append("  exemples :")
    for ident in sorted(lignes, key=lambda i: -len(lignes[i]))[:8]:
        r.append(f"    carte {ident} : " + " ; ".join(
            f"{x['fonction']} ({x['debut'] or '?'} -> {x['fin'] or ''})" for x in lignes[ident]))


def ecrire(r):
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(r) + "\n")
    print("\n".join(l for l in r if l.startswith("#") or l.startswith("Archive")))


if __name__ == "__main__":
    main()
