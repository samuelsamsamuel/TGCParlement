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
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date
from difflib import SequenceMatcher
from html.parser import HTMLParser
from urllib.parse import urljoin

sys.path.insert(0, os.path.dirname(__file__))
from cartes import lire_date  # noqa: E402
from sycomore import lignes_de  # noqa: E402

PAGE = ("https://www2.assemblee-nationale.fr/decouvrir-l-assemblee/histoire/"
        "les-presidents-de-l-assemblee-nationale-depuis-17893")
CONTACT = os.environ.get("CONTACT", "contact non renseigne")
UA = "Projet parlementaires, extraction autorisee par l'Assemblee nationale (" + CONTACT + ")"
SORTIE = os.path.join("data", "listes", "proposees")
F_DECISIONS = os.path.join("data", "listes", "decisions-presidences.json")
VE = ("https://www2.assemblee-nationale.fr/decouvrir-l-assemblee/histoire/"
      "la-ve-republique/les-presidents-de-l-assemblee-nationale-depuis-1958")
rapport = []


def telecharger(url):
    for attente in (0, 20, 60):
        time.sleep(1 + attente)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            erreur = e
            if e.code < 500:
                break
        except Exception as e:
            erreur = e
    rapport.append(f"ÉCHEC {url} : {erreur}")
    return ""


class Tables(HTMLParser):
    """Relève les lignes de tableaux, les liens et les attributs évoquant des onglets."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lignes, self.liens, self.attributs = [], [], []
        self.onglets, self.onglet = [], None
        self.ligne, self.cellule, self.titre, self.dans_titre = None, None, None, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.liens.append(a["href"])
        if tag == "a" and (a.get("data-target") or "").startswith("#node_"):
            self.onglet = [a["data-target"][6:], ""]
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
        if tag == "a" and self.onglet:
            self.onglet[1] = " ".join(self.onglet[1].split())
            self.onglets.append(tuple(self.onglet))
            self.onglet = None
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
        if self.onglet is not None:
            self.onglet[1] += data
        if self.cellule is not None:
            self.cellule += data
        if self.dans_titre:
            self.titre += data


def lire(url):
    html = telecharger(url)
    t = Tables()
    t.feed(html)
    t.texte = []
    if not t.lignes and html:
        lignes = [x for _, x in lignes_de(html)]
        if "Contenu de l'article" in lignes:
            lignes = lignes[lignes.index("Contenu de l'article") + 1:]
        t.texte = lignes[:60]
        for i, x in enumerate(lignes[:-1]):
            p = re.search(r"\((\d{1,2}(?:er)? \w+ \d{4})\s*-\s*(\d{1,2}(?:er)? \w+ \d{4})\)", x)
            if p and lire_date(p.group(1)):
                t.lignes.append((x, [p.group(1), p.group(2), lignes[i + 1]]))
                continue
            m = re.match(r"(?:Du|Depuis le)\s+(.+?)(?:\s+au\s+(.+))?$", x)
            if m and lire_date(m.group(1)):
                t.lignes.append((None, [m.group(1), m.group(2) or "", lignes[i + 1]]))
    return t


RE_VE = re.compile(r"Présidente? de l'Assemblée nationale (?:du|depuis le) (.+?)(?: au (.+?))?(?:[.,;]|$)")


def lire_ve():
    """Pages de la Ve République : nom en titre, puis « Président de l'Assemblée nationale du X au Y »."""
    pages, vus = {}, set()
    for n in range(0, 40):
        u = VE + (f"?offset={n}" if n else "")
        html = telecharger(u)
        if not html:
            break
        t = Tables()
        titre, trouve = None, False
        for balise, x in lignes_de(html):
            if balise in ("h1", "h2", "h3") and "Présidents de l'Assemblée" not in x:
                titre = x
            for m in RE_VE.finditer(x):
                cle = (m.group(1), titre)
                if titre and cle not in vus:
                    vus.add(cle)
                    trouve = True
                    t.lignes.append((None, [m.group(1), m.group(2) or "en cours", titre]))
        if not trouve:
            if n:
                break
            rapport.append("VE RÉPUBLIQUE : aucune présidence lue sur la première vue ; début du texte :")
            rapport.extend("    | " + x for _, x in lignes_de(html)[60:100])
        else:
            pages[u] = t
    return pages


def slug(titre):
    t = unicodedata.normalize("NFKD", titre).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


# --- Rattachement aux fiches -------------------------------------------------

PARTICULES = {"de", "la", "le", "du", "des", "d", "l", "dit", "dite", "ne", "nee"}


def jetons(nom):
    n = unicodedata.normalize("NFKD", nom).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\(.*?\)", " ", n)
    return [j for j in re.split(r"[^a-z]+", n) if j and j not in PARTICULES]


_cache_fonction = {}


def en_fonction(jour, cartes):
    if jour not in _cache_fonction:
        _cache_fonction[jour] = [c for c in cartes if siege_le(c, jour)]
    return _cache_fonction[jour]


def siege_le(carte, jour):
    for m in carte["mandats"]:
        if m["chambre"] != "AN" or not m["debut"]:
            continue
        fin = date.fromisoformat(m["fin"]) if m["fin"] else date.today()
        if date.fromisoformat(m["debut"]) <= jour <= fin:
            return True
    return False


def siege_pendant(carte, debut, fin):
    for m in carte["mandats"]:
        if m["chambre"] != "AN" or not m["debut"]:
            continue
        mf = date.fromisoformat(m["fin"]) if m["fin"] else date.today()
        if date.fromisoformat(m["debut"]) <= fin and mf >= debut:
            return True
    return False


def departage(js, candidats):
    """Plus de jetons communs ; à égalité, celui dont le dernier jeton est le nom cherché."""
    def note(c):
        jc = jetons(c["nom"] or "")
        return (len(set(js) & set(jc)), 1 if jc and jc[-1] == js[-1] else 0)
    notes = sorted(((note(c), c) for c in candidats), key=lambda x: x[0], reverse=True)
    if len(notes) > 1 and notes[0][0] == notes[1][0]:
        return None, notes
    return notes[0][1], notes


COUPURES = re.compile(r"\s+(?:du|de la|de l'|des|de|la)\s+", re.I)


def nom_coupe(nom):
    """Partie du nom précédant le premier complément (« Leclerc du Maine-et-Loire » -> « Leclerc »)."""
    tete = re.sub(r"\(.*?\)", " ", nom).strip()
    m = list(COUPURES.finditer(tete))
    for x in m:
        if x.start() > 0 and len(tete[:x.start()].split()) >= 2:
            return tete[:x.start()]
    return None


def rattacher(nom, jour, cartes, index, fin=None):
    js = jetons(nom)
    if not js:
        return None, "nom vide"
    present = (lambda c: siege_pendant(c, jour, fin)) if fin else (lambda c: siege_le(c, jour))
    cles = [js[-1]]
    coupe = nom_coupe(nom)
    if coupe and jetons(coupe):
        cles.append(jetons(coupe)[-1])
    # 1. Nom exact (nom complet, puis nom sans complément)
    candidats = {c["id"]: c for k in cles for c in index.get(k, []) if present(c)}
    alerte = None
    if not candidats:
        # 2. Graphie voisine du nom (Reubell / Rewbell, Pusy / Puzy...)
        vivier = en_fonction(jour, cartes) if not fin else [c for c in cartes if present(c)]
        for c in vivier:
            jc = jetons(c["nom"] or "")
            if any(SequenceMatcher(None, k, j).ratio() >= 0.8 for k in cles for j in jc):
                candidats[c["id"]] = c
        alerte = "GRAPHIE VOISINE, à vérifier"
    if not candidats:
        return None, "aucun député de ce nom en fonction à cette date"
    c, notes = departage(js, list(candidats.values()))
    if not c:
        return None, "ambigu : " + " / ".join(f"{x['id']} {x['nom']}" for _, x in notes[:4])
    if not alerte and notes[0][0][0] < 2 and len(js) > 1:
        alerte = "PRÉNOM NON CONCORDANT, à vérifier"
    return c, alerte


def main():
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    par_id = {c["id"]: c for c in cartes}
    decisions, appliquees = {}, set()
    if os.path.exists(F_DECISIONS):
        with open(F_DECISIONS, encoding="utf-8") as f:
            for d in json.load(f)["decisions"]:
                if not d.get("a_decider"):
                    decisions[d["ligne"]] = d
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
    for noeud, titre in principale.onglets:
        essais = [PAGE + "/" + slug(titre), urljoin(PAGE, "/node/" + noeud)]
        for u in essais:
            if u in pages:
                break
            t = lire(u)
            if t.lignes:
                pages[u] = t
                break
            if t.texte:
                rapport.append(f"ONGLET SANS DONNÉES LISIBLES : {titre} ({u}) ; début du texte :")
                rapport.extend("    | " + x for x in t.texte[:25])
                break
        else:
            rapport.append(f"ONGLET NON TROUVÉ : {titre} (essais : {', '.join(essais)})")
    pages_ve = lire_ve()
    pages.update(pages_ve)
    rapport.append(f"Pages lues : {len(pages)}")
    for u, t in pages.items():
        rapport.append(f"  {len(t.lignes):4d} lignes  {u}")
    if len(pages) == 1 and not principale.onglets:
        rapport.append("Aucun onglet trouvé par les liens ; attributs relevés :")
        rapport.extend("  " + a for a in principale.attributs[:60])

    vues, periodes, noms, alertes = set(), defaultdict(list), {}, defaultdict(set)
    for u, t in pages.items():
        for titre, (du, au, nom) in t.lignes:
            if du.lower() in ("du", "de"):
                continue  # ligne d'en-tête
            cle = (du, au, nom)
            if cle in vues:
                continue
            vues.add(cle)
            if "refus" in nom.lower():
                rapport.append(f"ÉCARTÉ (présidence refusée) : {du} | {nom}")
                continue
            d, f = lire_date(du), (date.today() if au == "en cours" else lire_date(au))
            annuel = False
            if not d and re.fullmatch(r"\d{4}", du) and re.fullmatch(r"\d{4}", au or ""):
                # Source donnée à l'année : bornes extrêmes, durée seulement encadrée
                annuel = True
                d, f = date(int(du), 1, 1), date(int(au), 12, 31)
            if not d:
                rapport.append(f"DATE ILLISIBLE : {du} | {au} | {nom}")
                continue
            if f and f < d:
                rapport.append(f"INCOHÉRENCE (fin avant début) : {du} | {au} | {nom}")
            cle_decision = f"{du} | {nom}"
            if cle_decision in decisions:
                dec = decisions[cle_decision]
                appliquees.add(cle_decision)
                if dec.get("id") is None:
                    rapport.append(f"EXCLU PAR DÉCISION ({dec.get('motif', '')}) : {du} | {au} | {nom}")
                    continue
                carte, motif = par_id.get(dec["id"]), "DÉCISION MANUELLE"
                if not carte:
                    rapport.append(f"DÉCISION INVALIDE (identifiant inconnu {dec['id']}) : {cle_decision}")
                    continue
            else:
                carte, motif = rattacher(nom, d, cartes, index, f if annuel else None)
            if not carte:
                rapport.append(f"NON RATTACHÉ ({motif}) : {du} | {au} | {nom}")
                continue
            if motif:
                alertes[carte["id"]].add(motif)
            periodes[carte["id"]].append((d, f, annuel, int(au) - int(du) if annuel else None))
            noms[carte["id"]] = (nom, carte["nom"])

    for cle in set(decisions) - appliquees:
        rapport.append(f"DÉCISION SANS LIGNE CORRESPONDANTE (vérifier la clé) : {cle}")
    longue, courte = [], []
    rapport.append("\nRattachements (vérifier chaque ligne) :")
    indetermines = []
    for ident, ps in sorted(periodes.items()):
        precises = [(d, f) for d, f, a, _ in ps if not a]
        jours = sum(((f or d) - d).days for d, f in precises if not f or f >= d)
        ecarts = [e for *_, a, e in ps if a]
        if jours >= 365 or any(e >= 2 for e in ecarts):
            longue.append(ident)          # au moins un an, certain
        elif any(e == 1 for e in ecarts):
            indetermines.append(ident)    # « 1888-1889 » : entre un jour et deux ans
        else:
            courte.append(ident)
        officiel, fiche = noms[ident]
        sans_fin = sum(1 for _, f, a, _ in ps if not f and not a)
        if ecarts:
            jours = "années " + ", ".join(f"{d.year}-{f.year}" for d, f, a, _ in ps if a)
        rapport.append(f"  {ident:6d}  {jours if isinstance(jours, str) else str(jours) + ' j':>12}  {officiel}  ->  {fiche}"
                       + (f"  ({sans_fin} période(s) sans date de fin, comptée(s) 0 jour)" if sans_fin else "")
                       + "".join(f"  [{a}]" for a in sorted(alertes[ident])))

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
    rapport.insert(0, f"Présidents rattachés : {len(periodes)} ({len(longue)} au moins un an, "
                      f"{len(courte)} moins d'un an, {len(indetermines)} indéterminés faute de dates précises)")
    if indetermines:
        rapport.append("\nDurée indéterminée (source à l'année, écart d'un an) : " + ", ".join(map(str, indetermines)))
    texte = "\n".join(rapport)
    with open(os.path.join(SORTIE, "presidences-rapport.txt"), "w", encoding="utf-8") as f:
        f.write(texte + "\n")
    print(texte)


if __name__ == "__main__":
    main()
