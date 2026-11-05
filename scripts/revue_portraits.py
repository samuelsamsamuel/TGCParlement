#!/usr/bin/env python3
"""Vignettes des portraits de Commons à revoir à l'œil (photos en largeur), pour choisir leur cadrage.

Dans une photo plus large que haute (photo de groupe, cérémonie, tableau), la personne peut se trouver n'importe où, et
le cadrage commun des cartes (centré, calé à 20 % du haut, dans un bandeau 1,71 fois plus large que haut) peut la
manquer. Ce script télécharge la vignette de 250 px de large de chacune de ces photos (dimensions mesurées par
`dimensions_portraits.py`) dans `data/revue_portraits/`, avec un index (numéro -> fichier, dimensions). Une photo dont
le cadrage est décidé dans `data/cadrages.json` (position choisie, ou position commune « 50% 20% » confirmée) sort de la
revue : sa vignette est effacée à l'exécution suivante. Depuis le conteneur de Claude, Wikimedia refuse presque toutes
les requêtes (429) : d'où le passage par le workflow. Demande de l'utilisateur, novembre 2026 (recadrer les photos).

Sortie : data/revue_portraits/ (vignettes et index.json), rapport data/listes/rapports/revue_portraits.txt.
Bibliothèque standard uniquement.
"""
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

DOSSIER = os.path.join("data", "revue_portraits")
RAPPORT = os.path.join("data", "listes", "rapports", "revue_portraits.txt")
UA = "TGCParlement/1.0 (projet personnel, contact : " + os.environ.get("CONTACT", "non renseigné") + ")"
MINUTES = float(os.environ.get("MINUTES_REVUE", "10"))


def lire(chemin, defaut):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return defaut


def vignette(fichier):
    nom = fichier.replace(" ", "_")
    h = hashlib.md5(nom.encode("utf-8")).hexdigest()
    ext = nom.rsplit(".", 1)[-1].lower()
    suffixe = ".png" if ext == "svg" else ".jpg" if ext in ("tif", "tiff", "pdf", "djvu") else ""
    q = urllib.parse.quote(nom)
    return f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{q}/250px-{q}{suffixe}"


def main():
    debut = time.time()
    with open(os.path.join("site", "jeu.json"), encoding="utf-8") as f:
        utilises = {c[9] for c in json.load(f)["cartes"] if c[9]}
    tailles = lire(os.path.join("data", "portraits_dimensions.json"), {})
    cadrages = lire(os.path.join("data", "cadrages.json"), {})
    a_revoir = sorted(f for f in utilises if f in tailles and tailles[f][0] > 1.15 * tailles[f][1] and f not in cadrages)
    os.makedirs(DOSSIER, exist_ok=True)
    index_avant = lire(os.path.join(DOSSIER, "index.json"), {})
    # Nom de la vignette : empreinte courte du fichier, stable d'une exécution à l'autre
    cle = lambda f: hashlib.sha1(f.encode("utf-8")).hexdigest()[:12]
    index, nouvelles, echecs = {}, 0, 0
    for f in a_revoir:
        chemin = os.path.join(DOSSIER, cle(f) + ".jpg")
        if not os.path.exists(chemin):
            if time.time() - debut > MINUTES * 60:
                continue
            for attente in (0, 10, 30):
                time.sleep(attente)
                try:
                    req = urllib.request.Request(vignette(f), headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=60) as r:
                        data = r.read()
                    with open(chemin, "wb") as fh:
                        fh.write(data)
                    nouvelles += 1
                    break
                except (urllib.error.URLError, TimeoutError):
                    continue
            else:
                echecs += 1
                continue
            time.sleep(0.5)
        index[cle(f)] = {"fichier": f, "largeur": tailles[f][0], "hauteur": tailles[f][1]}
    # Vignettes des photos sorties de la revue (cadrage décidé, carte disparue) : effacées
    effacees = 0
    for nom in os.listdir(DOSSIER):
        if nom.endswith(".jpg") and nom[:-4] not in index:
            os.remove(os.path.join(DOSSIER, nom))
            effacees += 1
    with open(os.path.join(DOSSIER, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=0, sort_keys=True)
    lignes = [f"Photos en largeur sans cadrage décidé : {len(a_revoir)} ; vignettes présentes : {len(index)} "
              f"(dont {nouvelles} téléchargées à cette exécution) ; échecs : {echecs} ; vignettes effacées : {effacees} ; "
              f"index précédent : {len(index_avant)}."]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lignes) + "\n")
    print("\n".join(lignes))


if __name__ == "__main__":
    main()
