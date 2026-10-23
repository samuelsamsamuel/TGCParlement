#!/usr/bin/env python3
"""Export des cartes pour l'application : site/jeu.json, format compact.

Chaque carte : [id, nom affiché, rareté, score, époque, en exercice (1/0), première année, dernière année, source,
portrait (fichier Commons ou null), distinctions (codes), chambres ("A" Assemblée, "S" Sénat, "G" Gouvernement), sexe,
fonctions [intitulé, début, fin, rang], mandats regroupés [intitulé, département, [[début, fin], ...], nombre], groupe politique principal, adresse directe du portrait,
assemblées où la carte a siégé (index dans la table « assemblees »)].
Table « assemblees » : [clé stable, intitulé, année d'élection], une ligne par législature ou assemblée de
Sycomore (régime et législature), dans l'ordre chronologique ; elle sert aux objectifs de collection.
Le nom affiché est le nom d'usage : premier prénom et nom de famille pour les fiches Sycomore
(« Jacques, Michel, Pierre Chaban-Delmas » -> « Jacques Chaban-Delmas »).
"""
import json
import os
import re
import urllib.parse
import sys

sys.path.insert(0, os.path.dirname(__file__))
from cartes import nom_famille_sycomore  # noqa: E402

RARETES = ["mythique", "legendaire", "epique", "rare", "peu-commune", "commune", "hors-categorie"]


NOMS_USAGE = {}


def nom_affiche(c):
    if str(c["id"]) in NOMS_USAGE:
        return NOMS_USAGE[str(c["id"])]
    nom = c["nom"] or ""
    if isinstance(c["id"], int) and "," in nom:
        return f"{nom.split(',')[0].strip()} {nom_famille_sycomore(nom)}"
    return nom


def annees(c):
    dates = [m.get("debut") for m in c.get("mandats", []) if m.get("debut")]
    dates += [f.get("debut") for f in c.get("fonctions", []) if f.get("debut")]
    fins = [m.get("fin") for m in c.get("mandats", []) if m.get("fin")]
    en_cours = any(m.get("en_cours") for m in c.get("mandats", []))
    if not dates:
        return None, None
    return int(min(dates)[:4]), (None if en_cours else int(max(fins + dates)[:4]))


RANG = {"chef-etat": 0, "chef-etat-interim": 1, "chef-gouvernement": 1, "presidence": 2, "ministre": 3,
        "secretaire-etat": 4, "presidence-commission": 5, "rapporteur-general": 5, "presidence-groupe": 6,
        "bureau-vp-questeur": 6, "bureau-secretaire": 7}


def an(d):
    return int(d[:4]) if d else None


def fonctions_carte(ident, gouv, pres):
    """[intitulé, année de début, année de fin (None si en cours ou inconnue), rang d'importance]."""
    liste = []
    for f in gouv.get(str(ident), []):
        liste.append([f["fonction"], an(f["debut"]), an(f["fin"]), RANG.get(f["liste"], 5)])
    for f in pres.get(str(ident), []):
        liste.append([f["fonction"], an(f["debut"]), an(f["fin"]), RANG["presidence"]])
    liste.sort(key=lambda x: (x[3], x[1] or 0))
    return liste


CIRCOS = {}
VILLES = {}


def numero_circo(ident, departement, debut):
    """Numéro de circonscription du mandat commençant cette année-là dans ce département, s'il est connu,
    suivi de la plus grande ville de la circonscription pour le découpage en vigueur depuis 2012."""
    for x in CIRCOS.get(str(ident), []):
        if (x.get("debut") or "")[:4] == str(debut) and (x.get("departement") or "").lower()[:6] == (departement or "").lower()[:6]:
            num, ville = x.get("num"), None
            dep = (x.get("code_dep") or "").upper()
            dep = dep.zfill(2) if dep.isdigit() else dep
            v = VILLES.get(f"{dep}-{(num or '').lstrip('0')}") if debut and debut >= 2012 else None
            if v:
                ville = v["ville"] + (" en partie" if v["partielle"] else "")
            return [num, ville] if ville else num
    return None


def table_assemblees(cartes):
    """Législatures et assemblées de Sycomore : clé stable, intitulé, année d'élection (la plus fréquente parmi
    les débuts de mandat, les élections partielles étant minoritaires), et index de chaque carte."""
    import unicodedata
    from collections import Counter
    vus, membres = {}, {}
    for c in cartes:
        for m in c.get("mandats", []):
            if m.get("chambre") != "AN" or not m.get("regime"):
                continue
            k = (m["regime"], m.get("legislature"))
            vus.setdefault(k, Counter())[(m.get("debut") or "")[:4]] += 1
            membres.setdefault(k, set()).add(str(c["id"]))
    table, index = [], {}
    for k, annees_ in sorted(vus.items(), key=lambda x: min(a for a in x[1] if a) if any(x[1]) else "9999"):
        regime, leg = k
        court = regime.split(" - ")[0]
        titre = f"{leg} ({court})" if leg else regime
        cle = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", f"{regime} {leg or ''}")
                     .encode("ascii", "ignore").decode().lower()).strip("-")
        annee = max((a for a in annees_ if a), key=lambda a: annees_[a], default=None)
        index[k] = len(table)
        table.append([cle, titre, int(annee) if annee else None])
    par_carte = {}
    for k, ids in membres.items():
        for i in ids:
            par_carte.setdefault(i, []).append(index[k])
    return table, {i: sorted(v) for i, v in par_carte.items()}


def mandats_carte(c):
    """Mandats regroupés par chambre et département, quelle que soit leur position dans la carrière :
    [intitulé, département, [[début, fin], ...], nombre]. Les périodes contiguës (écart d'un an au plus)
    sont fusionnées ; une interruption donne une seconde période sur la même ligne."""
    feminin = c.get("sexe") == "F"
    groupes = {}
    for m in sorted(c.get("mandats", []), key=lambda m: m.get("debut") or ""):
        if not m.get("debut") and not m.get("non_date"):
            continue
        if m.get("chambre") == "AN":
            titre = "Députée" if feminin else "Député"
        else:
            titre = "Sénatrice" if feminin else "Sénateur"
        dep = m.get("departement")
        if not dep and m.get("fonction") and "(" in m["fonction"]:
            dep = m["fonction"].split("(", 1)[1].rstrip(")")
        dep = (dep or "").strip() or None
        g = groupes.setdefault((titre, (dep or "").lower().replace("-", " ")), [titre, dep, [], 0])
        g[3] += 1
        debut, fin = an(m.get("debut")), (None if m.get("en_cours") else an(m.get("fin")))
        if debut is None:
            continue
        num = numero_circo(c["id"], dep, debut) if titre.startswith("Dépu") else None
        if num:
            g.append(num) if len(g) == 4 else None
            if len(g) == 5:
                g[4] = num  # numéro le plus récent
        periodes = g[2]
        if periodes and periodes[-1][1] is not None and debut <= periodes[-1][1] + 1:
            periodes[-1][1] = None if fin is None else max(periodes[-1][1], fin)
        elif periodes and periodes[-1][1] is None and not m.get("en_cours"):
            periodes[-1][1] = fin
        else:
            periodes.append([debut, fin])
    return sorted(groupes.values(), key=lambda g: (g[2][0][0] if g[2] else 9999))


def vignette(fichier, largeur=320):
    """Adresse directe de la vignette Commons (sans la redirection de Special:FilePath, plus lente)."""
    import hashlib
    nom = fichier.replace(" ", "_")
    h = hashlib.md5(nom.encode("utf-8")).hexdigest()
    ext = nom.rsplit(".", 1)[-1].lower()
    base = f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{urllib.parse.quote(nom)}/{largeur}px-{urllib.parse.quote(nom)}"
    if ext == "svg":
        return base + ".png"
    if ext in ("tif", "tiff", "pdf", "djvu"):
        return f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(nom)}?width={largeur}"
    return base


def source(c):
    if isinstance(c["id"], int):
        return f"https://www2.assemblee-nationale.fr/sycomore/fiche/{c['id']}"
    return c.get("source")


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    def lire(chemin):
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as f:
                return json.load(f)
        return {}
    NOMS_USAGE.update(lire(os.path.join("data", "noms_usage.json")))
    CIRCOS.update(lire(os.path.join("data", "gouvernement", "circonscriptions.json")))
    import unicodedata
    simplifie = lambda t: unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower().strip()
    photos_gouv = {simplifie(k): v for k, v in lire(os.path.join("data", "gouvernement", "photos_gouvernement.json")).items()}
    VILLES.update(lire(os.path.join("data", "gouvernement", "villes_circonscriptions.json")))
    gouv = lire(os.path.join("data", "gouvernement", "fonctions.json"))
    for k, v in lire(os.path.join("data", "gouvernement", "fonctions_assemblee.json")).items():
        gouv.setdefault(k, []).extend(v)
    pres = lire(os.path.join("data", "gouvernement", "presidences_an.json"))
    for k, v in lire(os.path.join("data", "gouvernement", "presidences_senat.json")).items():
        pres.setdefault(k, []).extend(v)
    portraits = {}
    if os.path.exists(os.path.join("data", "portraits.json")):
        with open(os.path.join("data", "portraits.json"), encoding="utf-8") as f:
            portraits = json.load(f)
    assemblees, assemblees_carte = table_assemblees(cartes)
    sortie = []
    for c in cartes:
        debut, fin = annees(c)
        texte = re.sub(r"\s+", " ", c.get("texte") or "").strip()
        chambres = "".join(sorted({"A" if m.get("chambre") == "AN" else "S" for m in c.get("mandats", [])}))
        codes = [d["code"] for d in c.get("distinctions", [])]
        if any(x in codes for x in ("chef-etat", "chef-etat-interim", "chef-gouvernement", "ministre", "secretaire-etat")):
            chambres += "G"
        sortie.append([c["id"], nom_affiche(c), RARETES.index(c["rarete"]), c["score"], c.get("epoque") or "",
                       1 if c.get("en_exercice") else 0, debut, fin, source(c),
                       portraits.get(str(c["id"])), codes, chambres, c.get("sexe"),
                       fonctions_carte(c["id"], gouv, pres), mandats_carte(c), c.get("groupe"),
                       c.get("photo") or (vignette(portraits[str(c["id"])]) if portraits.get(str(c["id"])) else None)
                       or photos_gouv.get(simplifie(nom_affiche(c))), assemblees_carte.get(str(c["id"]), [])])
    os.makedirs("site", exist_ok=True)
    with open(os.path.join("site", "jeu.json"), "w", encoding="utf-8") as f:
        json.dump({"raretes": RARETES, "assemblees": assemblees, "cartes": sortie}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Cartes avec portrait : {sum(1 for x in sortie if x[9])}")
    print(f"Assemblées (législatures) : {len(assemblees)} ; cartes rattachées : {len(assemblees_carte)}")
    print(f"Cartes exportées : {len(sortie)} ; taille : {os.path.getsize(os.path.join('site', 'jeu.json')) // 1024} Ko")


if __name__ == "__main__":
    main()
