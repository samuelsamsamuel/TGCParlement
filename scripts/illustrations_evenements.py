#!/usr/bin/env python3
"""Illustrations des cartes évènements : licence relue sur Commons, vignettes pour la revue à l'œil.

Les candidats (`data/evenements/candidats_images.json`, évènement -> fichiers de Commons proposés par la recherche, du
meilleur au moins bon) sont relus par l'API de Commons (`prop=imageinfo`, `extmetadata`) : seuls les fichiers dont la
licence est libre (domaine public, CC0, CC BY, CC BY-SA, Licence Ouverte ; pas de clause NC ni ND, le jeu pouvant
proposer des options payantes) et qui ne sont pas marqués non libres sont gardés, avec leur
auteur et leur licence tels que Commons les affiche. Les photos de presse sous droits ne sont pas retenues : la mention
de la source ne suffit pas, la reproduction intégrale d'une photographie n'étant pas une courte citation au sens de
l'article L122-5 du code de la propriété intellectuelle (jurisprudence constante de la Cour de cassation).

La revue à l'œil (`data/evenements/revue_images.json`, évènement -> fichier retenu, ou « aucune ») choisit l'image de
chaque carte parmi les candidats libres ; tant qu'elle n'a pas tranché, la vignette de 250 px de chaque candidat libre est
déposée dans `data/revue_evenements/` avec un index, pour Claude (Wikimedia refuse presque toutes les requêtes du
conteneur de Claude : d'où le passage par le workflow). Reprise : un fichier déjà relu ne l'est plus.

Sorties : data/evenements/licences_images.json (fichier -> [libre, auteur, licence, largeur, hauteur]),
data/evenements/illustrations.json (évènement -> {fichier, auteur, licence}, lu par export_jeu.py), vignettes et index
dans data/revue_evenements/, rapport data/listes/rapports/illustrations_evenements.txt. Bibliothèque standard uniquement.
"""
import hashlib
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

DOSSIER = os.path.join("data", "evenements")
REVUE = os.path.join("data", "revue_evenements")
RAPPORT = os.path.join("data", "listes", "rapports", "illustrations_evenements.txt")
UA = "TGCParlement/1.0 (projet personnel, contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
MINUTES = float(os.environ.get("MINUTES_ILLUSTRATIONS", "10"))
LIBRE = re.compile(r"^(public domain|pd|cc0|etalab|licence ouverte|cc[- ]by(-sa)?( \d\.\d)?( [a-z]{2,})?|cc[- ]by(-sa)? \d\.\d)", re.I)


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


def ecrire(chemin, donnees):
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=1, sort_keys=True)


def texte(v):
    """Valeur d'extmetadata : HTML réduit à son texte."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(v or "")))).strip()


def interroger(lot):
    q = urllib.parse.urlencode({"action": "query", "format": "json", "prop": "imageinfo", "iiprop": "size|extmetadata",
                                "iiextmetadatafilter": "LicenseShortName|Artist|NonFree|Copyrighted",
                                "titles": "|".join("File:" + f for f in lot)})
    for attente in (0, 10, 30, 60):
        time.sleep(attente)
        try:
            req = urllib.request.Request("https://commons.wikimedia.org/w/api.php?" + q, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError):
            continue
    return None


def vignette(fichier):
    nom = fichier.replace(" ", "_")
    h = hashlib.md5(nom.encode("utf-8")).hexdigest()
    ext = nom.rsplit(".", 1)[-1].lower()
    suffixe = ".png" if ext == "svg" else ".jpg" if ext in ("tif", "tiff", "pdf", "djvu", "webm") else ""
    q = urllib.parse.quote(nom)
    return f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{q}/250px-{q}{suffixe}"


def main():
    debut = time.time()
    evenements = {e["id"]: e for e in lire(os.path.join(DOSSIER, "evenements.json"), [])}
    candidats = {k: v for k, v in lire(os.path.join(DOSSIER, "candidats_images.json"), {}).items() if k in evenements}
    revue = lire(os.path.join(DOSSIER, "revue_images.json"), {})
    licences = lire(os.path.join(DOSSIER, "licences_images.json"), {})
    a_lire = sorted({f for l in candidats.values() for f in l} - set(licences))
    echecs = 0
    for i in range(0, len(a_lire), 40):
        if time.time() - debut > MINUTES * 60:
            break
        lot = a_lire[i:i + 40]
        r = interroger(lot)
        if r is None:
            echecs += 1
            continue
        norm = {n["to"]: n["from"] for n in r.get("query", {}).get("normalized", [])}
        for p in r.get("query", {}).get("pages", {}).values():
            nom = norm.get(p["title"], p["title"])[5:]
            ii = (p.get("imageinfo") or [None])[0]
            if not ii:
                licences[nom] = [False, "", "introuvable", 0, 0]
                continue
            m = ii.get("extmetadata", {})
            lic = texte(m.get("LicenseShortName", {}).get("value"))
            non_libre = texte(m.get("NonFree", {}).get("value")).lower() in ("true", "1")
            licences[nom] = [bool(LIBRE.match(lic)) and not re.search(r"\b(nc|nd)\b", lic, re.I) and not non_libre, texte(m.get("Artist", {}).get("value"))[:120] or "auteur non indiqué",
                             lic, ii.get("width", 0), ii.get("height", 0)]
        time.sleep(1)
    ecrire(os.path.join(DOSSIER, "licences_images.json"), licences)

    # Image de chaque carte : celle que la revue a retenue, si elle est toujours libre
    illustrations = {}
    for eid, choix in revue.items():
        if choix and choix != "aucune" and licences.get(choix, [False])[0]:
            _, auteur, lic, _, _ = licences[choix]
            illustrations[eid] = {"fichier": choix, "auteur": auteur, "licence": lic}
    ecrire(os.path.join(DOSSIER, "illustrations.json"), illustrations)

    # Vignettes des candidats libres des évènements que la revue n'a pas tranchés ; les autres sont effacées
    os.makedirs(REVUE, exist_ok=True)
    cle = lambda f: hashlib.sha1(f.encode("utf-8")).hexdigest()[:12]
    index, nouvelles, echecs_v = {}, 0, 0
    for eid, fichiers in sorted(candidats.items()):
        if eid in revue:
            continue
        for f in fichiers:
            if not licences.get(f, [False])[0]:
                continue
            chemin = os.path.join(REVUE, cle(f) + ".jpg")
            if not os.path.exists(chemin) and time.time() - debut < MINUTES * 60 * 1.5:
                try:
                    req = urllib.request.Request(vignette(f), headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=60) as r, open(chemin, "wb") as s:
                        s.write(r.read())
                    nouvelles += 1
                    time.sleep(1)
                except (urllib.error.URLError, TimeoutError):
                    echecs_v += 1
            if os.path.exists(chemin):
                index[cle(f)] = {"evenement": eid, "titre": evenements[eid]["titre"], "fichier": f, "licence": licences[f][2]}
    for nom in os.listdir(REVUE):
        if nom.endswith(".jpg") and nom[:-4] not in index:
            os.remove(os.path.join(REVUE, nom))
    ecrire(os.path.join(REVUE, "index.json"), index)

    libres = sum(1 for v in licences.values() if v[0])
    lignes = [f"Évènements : {len(evenements)} ; avec candidats : {len(candidats)} ; fichiers relus : {len(licences)} "
              f"(libres : {libres}) ; restant à relire : {len(a_lire) - sum(1 for f in a_lire if f in licences)} ; lots en échec : {echecs}.",
              f"Revue à l'œil : {len(revue)} évènements tranchés ; illustrations retenues : {len(illustrations)}.",
              f"Vignettes à revoir : {len(index)} (nouvelles : {nouvelles}, échecs : {echecs_v}).",
              "Fichiers écartés (licence non libre ou introuvable) :",
              *(f"  {f} : {v[2]}" for f, v in sorted(licences.items()) if not v[0])]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    print("\n".join(lignes[:3]))


if __name__ == "__main__":
    main()
