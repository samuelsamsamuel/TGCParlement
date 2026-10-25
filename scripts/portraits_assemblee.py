#!/usr/bin/env python3
"""Photos officielles des députés depuis la XIe législature, publiées par l'Assemblée nationale.

Source officielle : www2.assemblee-nationale.fr/static/tribun/<législature>/photos/<numéro>.jpg, la photo de la fiche
du député pour la législature, où <numéro> est l'identifiant de l'open data (PA794750 -> 794750). Sycomore n'a pas de
portrait pour beaucoup de députés récents : ces photos les complètent.

Rattachement aux cartes : celui de gouvernements_an.py (rattacher_assemblee), même date de naissance et nom de famille
de l'open data entièrement compris dans le nom de la carte, un seul candidat. Pour chaque député, la photo de la
législature la plus récente où il a siégé est essayée d'abord ; elle est vérifiée par une requête HEAD (statut 200,
type image/*).

Mesure préalable (octobre 2026) : 198 cartes rattachées sans portrait, 185 photos trouvées.

Durée : BUDGET_MINUTES (5 par défaut). Sorties : data/portraits_assemblee.json ({identifiant de carte: adresse}),
data/listes/rapports/portraits-assemblee-rapport.txt
"""
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from gouvernements_an import ADRESSES, telecharger, texte  # noqa: E402

SORTIE = os.path.join("data", "portraits_assemblee.json")
RAPPORT = os.path.join("data", "listes", "rapports", "portraits-assemblee-rapport.txt")
UA = "TGCParlement/1.0 (portraits ; contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
BUDGET = float(os.environ.get("BUDGET_MINUTES", "5")) * 60


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


def mots(t):
    t = "".join(c for c in unicodedata.normalize("NFD", (t or "").lower()) if unicodedata.category(c) != "Mn")
    return set(re.findall(r"[a-z]+", t)) - {"de", "du", "des", "la", "le", "d", "l"}


def existe(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    for attente in (0, 5):
        time.sleep(attente)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status == 200 and r.headers.get("content-type", "").startswith("image/")
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                return False
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
    return None  # injoignable : à refaire à la prochaine exécution


def deputes(rapport):
    """{uid: (nom, date de naissance, législatures en ordre décroissant)} d'après l'open data."""
    resultat = {}
    for url in ADRESSES:
        brut = telecharger(rapport, [url])
        if not brut:
            continue
        with zipfile.ZipFile(io.BytesIO(brut)) as z:
            for nom in z.namelist():
                if "/acteur/" not in nom or not nom.endswith(".json"):
                    continue
                a = json.loads(z.read(nom))["acteur"]
                uid = texte(a["uid"])
                naissance = texte((a["etatCivil"].get("infoNaissance") or {}).get("dateNais"))[:10]
                ms = (a.get("mandats") or {}).get("mandat") or []
                ms = ms if isinstance(ms, list) else [ms]
                legs = {int(texte(m["legislature"])) for m in ms if m.get("typeOrgane") == "ASSEMBLEE" and texte(m.get("legislature")).isdigit()}
                if legs and naissance:
                    ancien = resultat.get(uid, (None, None, []))[2]
                    resultat[uid] = (texte(a["etatCivil"]["ident"].get("nom")), naissance, sorted(legs | set(ancien), reverse=True))
    return resultat


def main():
    rapport = []
    cartes = lire(os.path.join("data", "cartes.json"), [])
    deja = set(lire(os.path.join("data", "portraits.json"), {}))
    for chemin in ("portraits_sycomore.json", "portraits_senat.json"):
        deja |= {k for k, v in lire(os.path.join("data", chemin), {}).items() if v}
    resultats = lire(SORTIE, {})
    acteurs = deputes(rapport)
    if not acteurs:
        print("Open data de l'Assemblée injoignable : photos précédentes gardées")
        return
    par_date = defaultdict(list)
    for c in cartes:
        if c.get("naissance"):
            par_date[c["naissance"]].append(c)
    a_sonder, orphelins = [], 0
    for uid, (nom, naissance, legs) in sorted(acteurs.items()):
        candidats = [c for c in par_date.get(naissance, []) if mots(nom) and mots(nom) <= mots(c["nom"])]
        if len(candidats) != 1:
            orphelins += 1
            continue
        c = candidats[0]
        ident = str(c["id"])
        if c.get("photo") or ident in deja or ident in resultats:
            continue
        a_sonder.append((ident, c["nom"], uid, legs))
    trouves, absents, erreurs, debut = 0, [], 0, time.monotonic()
    for ident, nom, uid, legs in a_sonder:
        if time.monotonic() - debut > BUDGET:
            erreurs += 1
            continue
        reponse = None
        for leg in legs:
            url = f"https://www2.assemblee-nationale.fr/static/tribun/{leg}/photos/{uid[2:]}.jpg"
            r = existe(url)
            time.sleep(0.3)
            if r:
                reponse = url
                break
            if r is None:
                reponse = False
        if reponse:
            resultats[ident] = reponse
            trouves += 1
        elif reponse is False:
            erreurs += 1
        else:
            absents.append(f"{ident}\t{nom}\t{uid}\tlégislatures {', '.join(map(str, legs))}")
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(resultats, f, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Photos officielles de l'Assemblée : {len(resultats)} en tout ; sondées cette fois : {len(a_sonder)}, trouvées "
              f"{trouves}, sans photo {len(absents)}, erreurs à refaire {erreurs} ; députés de l'open data sans carte unique : {orphelins}",
              ""] + rapport + ["", "Sans photo :"] + absents
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print(lignes[0])


if __name__ == "__main__":
    main()
