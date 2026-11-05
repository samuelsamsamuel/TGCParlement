#!/usr/bin/env python3
"""Anciens sénateurs de la IIIe République (1876-1940), d'après les fiches officielles de senat.fr.

Aucune source structurée ne les couvre : Sycomore ne porte que les sénateurs qui ont aussi été députés, et l'open
data du Sénat commence en 1958. Le Sénat publie en revanche la liste alphabétique des anciens sénateurs de la IIIe
République (www.senat.fr/senateurs-3eme-republique/senatl.html, 1 747 noms en novembre 2026) et une fiche par sénateur,
au gabarit constant (mesuré sur vingt fiches tirées au hasard, puis sur toutes, voir le rapport) :
  « État civil » : « Né le 31 mars 1888 » (ou « Née le »), « Décédé le 10 juin 1953 » ;
  « Département » : département d'élection, ou « Inamovible » (sénateurs élus à vie par l'Assemblée nationale, 1875) ;
  « Election » : « Elu le … » à chaque élection, puis « Fin de mandat le … ( motif ) ».
Seuls ces champs sont lus. La biographie (extraits du « Jean Jolly ») n'est pas lue : ses dates s'écartent parfois des
champs (Amaury de La Grange, réélu le 16 octobre 1932 selon elle, le 10 janvier 1933 selon le champ).
Les fiches n'ont ni groupe politique ni portrait propre.

Liste close : chaque fiche n'est lue qu'une fois (reprise, MINUTES par exécution, une requête par seconde) ;
une fiche déjà lue n'est plus demandée. Le rapprochement avec Sycomore (sénateurs qui ont été députés, déjà
présents) est fait par cartes.py.

Sortie : data/senat/senateurs_iiie.json, rapport data/listes/rapports/senateurs_iiie.txt.
Demande de l'utilisateur, novembre 2026 (Amaury de La Grange, sénateur du Nord, absent du jeu).
Bibliothèque standard uniquement.
"""
import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter

LISTE = "https://www.senat.fr/senateurs-3eme-republique/senatl.html"
BASE = "https://www.senat.fr"
SORTIE = os.path.join("data", "senat", "senateurs_iiie.json")
RAPPORT = os.path.join("data", "listes", "rapports", "senateurs_iiie.txt")
UA = "TGCParlement/1.0 (projet personnel, contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
MINUTES = float(os.environ.get("MINUTES_SENATEURS_IIIE", "40"))
MOTIFS = {"Décédé", "Décédée", "Non réélu", "Non réélue", "Ne se représente pas", "Démissionnaire", "Fin de mandat",
          "Invalidé", "Invalidée", "Déchu", "Déchue"}
MOIS = {m: i + 1 for i, m in enumerate(["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
                                         "septembre", "octobre", "novembre", "décembre"])}


def lire(url):
    for attente in (0, 10, 30):
        time.sleep(attente)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            erreur = e
        except (urllib.error.URLError, TimeoutError) as e:
            erreur = e
    raise RuntimeError(f"{url} : {erreur}")


def date_fr(texte):
    """« 1er avril 1885 » -> « 1885-04-01 » ; None si la date n'est pas complète."""
    m = re.search(r"(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})", texte or "")
    if not m or m.group(2) not in MOIS:
        return None
    return f"{m.group(3)}-{MOIS[m.group(2)]:02d}-{int(m.group(1)):02d}"


def propre(x):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x or ""))).strip()


def nom_lisible(brut):
    """« de LA GRANGE Amaury » -> nom de famille « de La Grange », prénom « Amaury ».
    Le nom de famille est écrit en capitales (particules exceptées) ; les prénoms suivent.
    Les capitales sont ramenées en minuscules sans rien ajouter : un accent absent de la source le reste."""
    # « ALFRED-BRARD (Mathurin BRARD dit) », « Jules SIMON (Jules SUISSE dit) » : nom d'usage, celui de la liste,
    # avant la parenthèse ; « AUXAIS (d') Jules », « CASABIANCA (de) Paul » : particule placée devant le nom
    p = re.match(r"^(\S+) \((d'|de|du|des)\) (.*)$", brut)
    if p:
        brut = (p.group(2) + ("" if p.group(2).endswith("'") else " ") + p.group(1) + " " + p.group(3))
    brut = re.sub(r"\s*\([^)]*\bdit\)\s*$", "", brut).replace("d' ", "d'")
    mots = brut.split()
    capitale = lambda w: bool(re.search(r"[A-ZÀ-Ý]{2}", w))
    particule = lambda w: w in ("de", "du", "des", "d'", "la", "le") or w.startswith("d'")
    # le nom de famille : mots en capitales et particules qui les précèdent ; les autres mots sont les prénoms
    idx = [i for i, w in enumerate(mots) if capitale(w)]
    if not idx:
        return brut, ""
    a, b = idx[0], idx[-1]
    while a > 0 and particule(mots[a - 1]):
        a -= 1
    famille, prenoms = mots[a:b + 1], mots[:a] + mots[b + 1:]
    # « de CISSEY Ernest COURTOT » : nom en capitales après le prénom, placé en tête (Ernest Courtot de Cissey)
    milieu = [w for w in famille if not capitale(w) and not particule(w)]
    if milieu:
        k = famille.index(milieu[0])
        fin = [w for w in famille[k:] if capitale(w) or particule(w)]
        famille, prenoms = fin + famille[:k], prenoms + milieu

    def casse(w):
        if w.startswith("d'") and capitale(w):
            return "d'" + casse(w[2:])
        if not re.search(r"[A-ZÀ-Ý]{2}", w):
            return w  # particule (de, du, d'…) ou mot déjà en minuscules
        return re.sub(r"[A-Za-zÀ-ÿ]+", lambda m: m.group(0)[0] + m.group(0)[1:].lower(), w)
    return " ".join(casse(w) for w in famille), " ".join(prenoms)


def fiche(url, brut_nom):
    p = lire(BASE + url)
    if p is None:
        return {"url": url, "statut": 404}
    civil = re.search(r"État civil :</dt>\s*<dd[^>]*>(.*?)</dd>", p, re.S)
    dep = re.search(r"Département\s*:</dt>\s*<dd[^>]*>(.*?)</dd>", p, re.S)
    elec = re.search(r"Election\s*</button>.*?<p>(.*?)</p>", p, re.S)
    lignes = [propre(x) for x in re.split(r"<br\s*/?>", civil.group(1))] if civil else []
    evenements = [propre(x) for x in re.split(r"<br\s*/?>", elec.group(1))] if elec else []
    return {"url": url, "statut": 200, "nom_brut": brut_nom, "etat_civil": [l for l in lignes if l],
            "departement": propre(dep.group(1)) if dep else None, "elections": [e for e in evenements if e]}


def mettre_en_forme(f):
    """Fiche lue -> sénateur au format de data/senat/senateurs.json (mandats de l'élection à la fin de mandat)."""
    famille, prenom = nom_lisible(f["nom_brut"])
    dit = re.search(r"\(([^)]*) dit\)", f["nom_brut"])
    civil = nom_lisible(dit.group(1)) if dit else None
    ne = next((l for l in f["etat_civil"] if re.match(r"Née? le", l)), None)
    mort = next((l for l in f["etat_civil"] if re.match(r"Décédée? le", l)), None)
    # Lignes d'élection (mesure sur les 1 747 fiches) : « Elu le … » (2 935), « Réélu le … » (50), « Devenu Sénateur le … »
    # (3, élu à un siège laissé vacant), « Elu du … au … » (43) et « Réélu du … au … » (8), période close sur la ligne même,
    # puis « Fin de mandat le … ». Entre parenthèses : le motif de fin, ou le département (« Seine ») ou « inamovible »
    # pour cette période seulement (sénateur passé d'un département à un autre, ou élu inamovible en cours de carrière).
    mandats, ouvert = [], None

    def details(e):
        motif, circo, inamovible = None, None, False
        for x in re.findall(r"\(\s*([^)]*?)\s*\)", e):
            if x in MOTIFS:
                motif = x
            elif x.lower() == "inamovible":
                inamovible = True
            elif x:
                circo = x
        return motif, circo, inamovible
    for e in f["elections"]:
        motif, circo, inamov = details(e)
        periode = re.match(r"(?:Elue?|Réélue?|Devenue? Sénat\w*) du (.+?) au (.+?)(?:\(|$)", e)
        debut = re.match(r"(?:Elue?|Réélue?|Devenue? Sénat\w*) le (.+)", e)
        if periode:
            mandats.append({"debut": date_fr(periode.group(1)), "fin": date_fr(periode.group(2)),
                            "motif_fin": None if motif == "Fin de mandat" else motif, "circonscription": circo, "inamovible": inamov})
            ouvert = None
        elif debut:
            if ouvert is None:
                ouvert = {"debut": date_fr(debut.group(1)), "fin": None, "motif_fin": None, "circonscription": circo, "inamovible": inamov}
        elif e.startswith("Fin de mandat"):
            if ouvert is not None:
                ouvert.update(fin=date_fr(e), motif_fin=motif)
                mandats.append(ouvert)
            ouvert = None
    if ouvert is not None:
        mandats.append(ouvert)
    dep = f["departement"]
    for m in mandats:
        if not m["circonscription"] and not m["inamovible"]:
            m["circonscription"], m["inamovible"] = (None, True) if dep == "Inamovible" else (dep, False)
    # matricule de la fiche : « 1389r3 » ; « 0083r4 » pour un sénateur resté au Conseil de la République, ou matricule
    # de l'open data (« 000685 ») pour un sénateur de la Ve République : sa carte sénatoriale existe déjà (rapprochement)
    matricule = re.search(r"(\d+(?:r\d)?)\.html$", f["url"]).group(1).upper()
    return {"matricule": matricule, "nom": f"{prenom} {famille}".strip(), "nom_famille": famille, "prenom": prenom,
            "nom_civil": f"{civil[1]} {civil[0]}".strip() if civil else None,
            "nom_famille_civil": civil[0] if civil else None, "groupe": None, "sexe": "F" if ne and ne.startswith("Née") else "M",
            "naissance": date_fr(ne), "deces": date_fr(mort),
            "circonscription": None if dep in (None, "", "Inamovible") else dep,
            "inamovible": dep == "Inamovible", "etat": "ANCIEN", "mandats": mandats,
            "source": BASE + f["url"]}


def ecrire(fiches, senateurs):
    precedents = []
    if senateurs is None and os.path.exists(SORTIE):
        with open(SORTIE, encoding="utf-8") as fh:
            precedents = json.load(fh).get("senateurs", [])
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE + ".tmp", "w", encoding="utf-8") as fh:
        json.dump({"source": LISTE, "fiches": fiches, "senateurs": precedents if senateurs is None else senateurs},
                  fh, ensure_ascii=False, indent=0)
    os.replace(SORTIE + ".tmp", SORTIE)


def main():
    debut = time.time()
    lues = {}
    if os.path.exists(SORTIE):
        with open(SORTIE, encoding="utf-8") as fh:
            lues = {f["url"]: f for f in json.load(fh)["fiches"]}
    page = lire(LISTE)
    liste = [(u, re.sub(r"\s+", " ", html.unescape(n)).strip())
             for u, n in re.findall(r'href="(/senateur-3eme-republique/[^"]+)">([^<]+)</A>', page, re.I)]
    if len(liste) < 1500:
        raise SystemExit(f"Liste incomplète ({len(liste)} noms) : rien n'est écrit.")
    nouvelles, erreurs = 0, []
    for url, nom in liste:
        if url in lues and lues[url].get("statut") == 200:
            continue
        if time.time() - debut > MINUTES * 60:
            break
        try:
            lues[url] = fiche(url, nom)
            nouvelles += 1
        except RuntimeError as e:
            erreurs.append(str(e))
        if nouvelles and nouvelles % 100 == 0:
            ecrire([lues[u] for u, _ in liste if u in lues], None)  # reprise possible après une interruption
        time.sleep(1)
    fiches = [lues[u] for u, _ in liste if u in lues]
    ecrire(fiches, None)  # les fiches lues sont gardées même si la mise en forme échoue
    senateurs = []
    for f in fiches:
        if f.get("statut") != 200:
            continue
        try:
            senateurs.append(mettre_en_forme(f))
        except (AttributeError, ValueError) as e:
            erreurs.append(f"mise en forme de {f['url']} : {e}")
    ecrire(fiches, senateurs)

    # Rapport : mesure des champs
    r = [f"Sénateurs de la IIIe République (senat.fr) : {len(liste)} noms dans la liste, {len(fiches)} fiches lues "
         f"({nouvelles} à cette exécution), {len(senateurs)} retenues, {len(erreurs)} erreurs."]
    r.append(f"Fiches restant à lire : {len(liste) - len(fiches)}")
    c = Counter()
    for s, f in zip(senateurs, [f for f in fiches if f.get("statut") == 200]):
        c["sans date de naissance complète"] += not s["naissance"]
        c["sans date de décès"] += not s["deces"]
        c["inamovibles"] += s["inamovible"]
        c["sans département ni inamovible"] += not s["circonscription"] and not s["inamovible"]
        c["sans mandat"] += not s["mandats"]
        c["mandat sans date de début"] += any(not m["debut"] for m in s["mandats"])
        c["mandat sans date de fin"] += any(not m["fin"] for m in s["mandats"])
        c["plusieurs mandats séparés"] += len(s["mandats"]) > 1
        c["femmes"] += s["sexe"] == "F"
        autres = [e for e in f["elections"] if not re.match(r"(Elue?|Réélue?|Devenue? Sénat\w*) (le|du)|Fin de mandat", e)]
        c["lignes d'élection d'un format inconnu"] += bool(autres)
        c["périodes dans un autre département ou inamovibles"] += any(m["circonscription"] != s["circonscription"] for m in s["mandats"])
        if autres:
            c[f"  ex. {autres[0][:60]}"] += 1
    r += [f"  {k} : {v}" for k, v in c.items()]
    motifs = Counter(m["motif_fin"] for s in senateurs for m in s["mandats"])
    r.append("Motifs de fin de mandat : " + " ; ".join(f"{k} {v}" for k, v in motifs.most_common()))
    r.append("Exemples de noms : " + " ; ".join(s["nom"] for s in senateurs[:: max(1, len(senateurs) // 15)]))
    r += [f"Erreur : {e}" for e in erreurs[:20]]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(r) + "\n")
    print("\n".join(r))


if __name__ == "__main__":
    main()
