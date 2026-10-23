#!/usr/bin/env python3
"""Fonctions gouvernementales récentes, d'après l'open data de l'Assemblée nationale.

Le jeu de données de la Ve République (data.gouv.fr) s'arrête au 13 mars 2025. Pour les nominations
postérieures, on lit le fichier officiel « Députés, sénateurs et ministres de la législature »
(AMO20, data.assemblee-nationale.fr), qui porte les mandats de type GOUVERNEMENT avec leur intitulé
et leurs dates. Seules les fonctions commençant après le 13 mars 2025 sont reprises.
Le même fichier sert aussi aux fonctions au sein de l'Assemblée (présidences de groupe et de commission,
rapporteur général, vice-présidence, questure et secrétariat du Bureau), rattachées aux cartes par le nom
et la date de naissance. L'historique officiel est privilégié (AMO30, dit « depuis la XIe législature », mais
qui ne porte les fonctions au sein de l'Assemblée qu'à partir de la XIIe, en juin 2002) ; à défaut, le fichier
de la législature (AMO20) ne couvre que les députés en fonction et leurs mandats antérieurs.
Sorties : data/gouvernement/an_lignes.json, data/gouvernement/fonctions_assemblee.json,
data/listes/{presidence-groupe,presidence-commission,rapporteur-general,bureau-vp-questeur,bureau-secretaire}.json
et data/listes/rapports/gouvernements-an-rapport.txt
"""
import http.client
import io
import json
import os
import time
import urllib.error
import urllib.request
import zipfile

ADRESSES = [
    "https://data.assemblee-nationale.fr/static/openData/repository/17/amo/tous_acteurs_mandats_organes_xi_legislature/AMO30_tous_acteurs_tous_mandats_tous_organes_historique.json.zip",
] + [
    f"https://data.assemblee-nationale.fr/static/openData/repository/{leg}/amo/deputes_senateurs_ministres_legislature/AMO20_dep_sen_min_tous_mandats_et_organes.json.zip"
    for leg in (18, 17)
]
DEPUIS = "2025-03-13"
SORTIE = os.path.join("data", "gouvernement", "an_lignes.json")
RAPPORT = os.path.join("data", "listes", "rapports", "gouvernements-an-rapport.txt")


def telecharger(rapport, adresses=None):
    """Téléchargement par blocs, repris jusqu'à cinq fois si la connexion se coupe en cours de route."""
    for url in (adresses or ADRESSES):
        for essai, attente in enumerate((0, 10, 30, 60, 120), 1):
            time.sleep(attente)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "TGCParlement/1.0"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    attendu = int(r.headers.get("Content-Length") or 0)
                    morceaux = []
                    while True:
                        bloc = r.read(65536)
                        if not bloc:
                            break
                        morceaux.append(bloc)
                    brut = b"".join(morceaux)
                if attendu and len(brut) < attendu:
                    raise http.client.IncompleteRead(brut, attendu - len(brut))
                zipfile.ZipFile(io.BytesIO(brut)).testzip()  # archive complète et lisible
                rapport.append(f"Fichier lu : {url} ({len(brut)} octets, essai {essai})")
                return brut
            except urllib.error.HTTPError as e:
                rapport.append(f"{url} : {e}")
                break
            except (urllib.error.URLError, http.client.HTTPException, zipfile.BadZipFile, OSError) as e:
                rapport.append(f"{url} : essai {essai} interrompu ({type(e).__name__})")
    return None


def texte(v):
    if isinstance(v, dict):
        return v.get("#text") or ""
    return v or ""


# Compositions officielles transcrites d'info.gouv.fr (pages « Composition du gouvernement » des 5 et
# 12 octobre 2025 et « Composition du Gouvernement » annoncée le 26 février 2026). L'open data de
# l'Assemblée ne porte que la qualité « membre » : l'intitulé de chaque fonction vient de ces pages,
# selon la composition en vigueur à la date de nomination. La page actuelle est aussi lue en ligne
# lorsqu'elle est accessible, pour suivre un éventuel remaniement ; à défaut, cette transcription fait foi.
COMPOSITIONS = [
    ("2025-09-09", "https://www.info.gouv.fr/actualite/la-composition-du-gouvernement-de-sebastien-lecornu", {
        "Sébastien Lecornu": "Premier ministre"}),
    ("2025-10-05", "https://www.info.gouv.fr/actualite/la-composition-du-gouvernement-de-sebastien-lecornu", {
        "Élisabeth Borne": "Ministre d’État, ministre de l’Éducation nationale, de l’Enseignement supérieur et de la Recherche",
        "Manuel Valls": "Ministre d’État, ministre des Outre-mer",
        "Gérald Darmanin": "Ministre d’État, garde des Sceaux, ministre de la Justice",
        "Bruno Retailleau": "Ministre d’État, ministre de l’Intérieur",
        "Bruno Le Maire": "Ministre d’État, ministre des Armées et des Anciens combattants",
        "Catherine Vautrin": "Ministre du Travail, de la Santé, des Solidarités, des Familles, de l’Autonomie et des Personnes handicapées",
        "Rachida Dati": "Ministre de la Culture",
        "Roland Lescure": "Ministre de l’Économie, des Finances et de la Souveraineté industrielle et énergétique",
        "Jean-Noël Barrot": "Ministre de l’Europe et des Affaires étrangères",
        "Éric Woerth": "Ministre de l’Aménagement du territoire, de la Décentralisation et du Logement",
        "Agnès Pannier-Runacher": "Ministre de la Transition écologique, de la Biodiversité, de la Forêt, de la Mer et de la Pêche",
        "Annie Genevard": "Ministre de l’Agriculture et de la Souveraineté alimentaire",
        "Amélie de Montchalin": "Ministre des Comptes publics",
        "Naïma Moutchou": "Ministre de la Transformation et de la Fonction publiques, de l’Intelligence artificielle et du Numérique",
        "Philippe Tabarot": "Ministre des Transports",
        "Marina Ferrari": "Ministre des Sports, de la Jeunesse et de la Vie associative",
        "Aurore Bergé": "Ministre déléguée auprès du Premier ministre, chargée de l’Égalité entre les femmes et les hommes et de la Lutte contre les discriminations, porte-parole du Gouvernement",
        "Mathieu Lefèvre": "Ministre délégué auprès du Premier ministre, chargé des Relations avec le Parlement"}),
    ("2025-10-11", "https://www.info.gouv.fr/actualite/composition-du-gouvernement-du-sebastien-lecornu", {
        "Sébastien Lecornu": "Premier ministre",
        "Laurent Nunez": "Ministre de l’Intérieur",
        "Catherine Vautrin": "Ministre des Armées et des Anciens combattants",
        "Jean-Pierre Farandou": "Ministre du Travail et des Solidarités",
        "Monique Barbut": "Ministre de la Transition écologique, de la Biodiversité et des Négociations internationales sur le climat et la nature",
        "Gérald Darmanin": "Garde des Sceaux, ministre de la Justice",
        "Roland Lescure": "Ministre de l’Économie, des Finances et de la Souveraineté industrielle, énergétique et numérique",
        "Serge Papin": "Ministre des Petites et moyennes entreprises, du Commerce, de l’Artisanat, du Tourisme et du Pouvoir d’achat",
        "Annie Genevard": "Ministre de l’Agriculture, de l’Agro-alimentaire et de la Souveraineté alimentaire",
        "Édouard Geffray": "Ministre de l’Éducation nationale",
        "Jean-Noël Barrot": "Ministre de l’Europe et des Affaires étrangères",
        "Rachida Dati": "Ministre de la Culture",
        "Stéphanie Rist": "Ministre de la Santé, des Familles, de l’Autonomie et des Personnes handicapées",
        "Naïma Moutchou": "Ministre des Outre-mer",
        "Françoise Gatel": "Ministre de l’Aménagement du territoire et de la Décentralisation",
        "Amélie de Montchalin": "Ministre de l’Action et des Comptes publics",
        "Philippe Baptiste": "Ministre de l’Enseignement supérieur, de la Recherche et de l’Espace",
        "Marina Ferrari": "Ministre des Sports, de la Jeunesse et de la Vie associative",
        "Philippe Tabarot": "Ministre des Transports",
        "Vincent Jeanbrun": "Ministre de la Ville et du Logement",
        "Laurent Panifous": "Ministre délégué auprès du Premier ministre, chargé des Relations avec le Parlement",
        "Maud Bregeon": "Ministre déléguée auprès du Premier ministre, porte-parole du Gouvernement",
        "Aurore Bergé": "Ministre déléguée auprès du Premier ministre, chargée de l’Égalité entre les femmes et les hommes et de la Lutte contre les discriminations",
        "Marie-Pierre Vedrenne": "Ministre déléguée auprès du ministre de l’Intérieur",
        "Alice Rufo": "Ministre déléguée auprès de la ministre des Armées et des Anciens combattants",
        "Catherine Chabaud": "Ministre déléguée auprès de la ministre de la Transition écologique, de la Biodiversité et des Négociations internationales sur le climat et la nature, chargée de la Mer et de la Pêche",
        "Mathieu Lefèvre": "Ministre délégué auprès de la ministre de la Transition écologique, de la Biodiversité et des Négociations internationales sur le climat et la nature, chargé de la Transition écologique",
        "Sébastien Martin": "Ministre délégué auprès du ministre de l’Économie, des Finances et de la Souveraineté industrielle, énergétique et numérique, chargé de l’Industrie",
        "Anne Le Hénanff": "Ministre déléguée auprès du ministre de l’Économie, des Finances et de la Souveraineté industrielle, énergétique et numérique, chargée de l’Intelligence artificielle et du Numérique",
        "Benjamin Haddad": "Ministre délégué auprès du ministre de l’Europe et des Affaires étrangères, chargé de l’Europe",
        "Nicolas Forissier": "Ministre délégué auprès du ministre de l’Europe et des Affaires étrangères, chargé du Commerce extérieur et de l’Attractivité",
        "Éléonore Caroit": "Ministre déléguée auprès du ministre de l’Europe et des Affaires étrangères, chargée de la Francophonie, des Partenariats internationaux et des Français de l’étranger",
        "Charlotte Parmentier-Lecocq": "Ministre déléguée auprès de la ministre de la Santé, des Familles, de l’Autonomie et des Personnes handicapées, chargée de l’Autonomie et des Personnes handicapées",
        "Michel Fournier": "Ministre délégué auprès de la ministre de l’Aménagement du territoire et de la Décentralisation, chargé de la Ruralité",
        "David Amiel": "Ministre délégué auprès de la ministre de l’Action et des Comptes publics, chargé de la Fonction publique et de la Réforme de l’État"}),
    ("2026-02-26", "https://www.info.gouv.fr/composition-du-gouvernement", {
        "Maud Bregeon": "Ministre déléguée, porte-parole du Gouvernement auprès du Premier ministre et ministre déléguée, chargée de l’Énergie auprès du ministre de l’Économie, des Finances et de la Souveraineté industrielle, énergétique et numérique",
        "Jean-Didier Berger": "Ministre délégué auprès du ministre de l’Intérieur",
        "Sabrina Roubache": "Ministre déléguée auprès du ministre du Travail et des Solidarités et du ministre de l’Éducation nationale, chargée de l’Enseignement et de la Formation professionnels et de l’Apprentissage",
        "Camille Galliard-Minier": "Ministre déléguée auprès de la ministre de la Santé, des Familles, de l’Autonomie et des Personnes handicapées, chargée de l’Autonomie et des Personnes handicapées",
        "Catherine Pégard": "Ministre de la Culture",
        "David Amiel": "Ministre de l’Action et des Comptes publics"}),
]


def intitule_officiel(nom, debut):
    """Intitulé de la fonction dans la composition en vigueur à la date de nomination."""
    cle = norme(nom)
    retenu = None
    for date_c, _, membres in COMPOSITIONS:
        if date_c <= (debut or ""):
            for n, t in membres.items():
                if norme(n) == cle:
                    retenu = t
    return retenu


def changements_ulterieurs(nom, debut, libelle):
    """Compositions postérieures à la nomination où la même personne porte un autre intitulé."""
    cle, courant, liste = norme(nom), libelle, []
    for date_c, _, membres in COMPOSITIONS:
        if date_c > (debut or ""):
            for n, t in membres.items():
                if norme(n) == cle and t != courant:
                    liste.append((date_c, t))
                    courant = t
    return liste


def composition_officielle(rapport):
    """Composition du Gouvernement publiée sur info.gouv.fr : {nom normalisé: (nom, intitulé, photo)}.
    L'open data de l'Assemblée ne donne que « membre » comme qualité : l'intitulé vient de cette page."""
    import html as h
    import re
    try:
        req = urllib.request.Request("https://www.info.gouv.fr/composition-du-gouvernement", headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml", "Accept-Language": "fr-FR,fr;q=0.9"})
        with urllib.request.urlopen(req, timeout=120) as r:
            page = r.read().decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        rapport.append(f"Composition officielle du Gouvernement indisponible : {e}")
        return {}, None
    annonce = re.search(r"Annonc[ée] le\s*(\d{2})/(\d{2})/(\d{4})", page)
    date_annonce = f"{annonce.group(3)}-{annonce.group(2)}-{annonce.group(1)}" if annonce else None
    membres = {}
    for m in re.finditer(r"<h3[^>]*>\s*<a[^>]*/personnalite/[^>]*>(.*?)</a>\s*</h3>(.*?)(?=<h3|<h2|</main|$)", page, re.S):
        nom = h.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
        bloc = m.group(2)
        textes = [h.unescape(re.sub(r"\s+", " ", t)).strip() for t in re.findall(r">([^<>]+)<", bloc)]
        intitule = next((t for t in textes if len(t) > 6), None)
        img = re.search(r'<img[^>]+src="([^"]+)"', bloc)
        photo = None
        if img:
            photo = img.group(1) if img.group(1).startswith("http") else "https://www.info.gouv.fr" + img.group(1)
        if nom and intitule and norme(nom) not in membres:
            membres[norme(nom)] = (nom, intitule, photo)
    rapport.append(f"Composition officielle (info.gouv.fr, annoncée le {date_annonce or '?'}) : {len(membres)} membres")
    return membres, date_annonce


def categorie(code, libelle):
    t = f"{code} {libelle}".lower()
    if "premier ministre" in t:
        return "chef-gouvernement"
    if "secrétaire d'état" in t or "secretaire d'etat" in t:
        return "secretaire-etat"
    if "ministre" in t or "garde des sceaux" in t:
        return "ministre"
    return None


LISTES_ASSEMBLEE = {
    "presidence-commission": (10, "A présidé une commission permanente"),
    "rapporteur-general": (10, "A été rapporteur général du budget"),
    "presidence-groupe": (8, "A présidé un groupe politique"),
    "bureau-vp-questeur": (8, "A été vice-président ou questeur de l'Assemblée ou du Sénat"),
    "bureau-secretaire": (3, "A été secrétaire de l'Assemblée ou du Sénat"),
}


def norme(t):
    import unicodedata
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def fonction_assemblee(type_organe, qualite, libelle_organe):
    q, o = norme(qualite), norme(libelle_organe)
    if "rapporteur general" in q:
        return "rapporteur-general", f"Rapporteur général ({libelle_organe})"
    if type_organe == "GP" and q.startswith("president"):
        return "presidence-groupe", f"Président du groupe {libelle_organe}"
    if type_organe == "COMPER" and q.startswith("president"):
        return "presidence-commission", f"Président de la {libelle_organe[:1].lower() + libelle_organe[1:]}"
    if "bureau" in o or type_organe == "BUREAU":
        if q.startswith("vice-president") or q.startswith("questeur"):
            return "bureau-vp-questeur", f"{qualite} de l'Assemblée nationale"
        if q.startswith("secretaire"):
            return "bureau-secretaire", "Secrétaire de l'Assemblée nationale"
    return None, None


def main():
    rapport = []
    lignes, assemblee, circos, vus_gouv, exemples, sans_intitule = [], [], [], [], [], []
    composition, _ = composition_officielle(rapport)
    with open(os.path.join("data", "gouvernement", "photos_gouvernement.json") if os.path.isdir(os.path.join("data", "gouvernement")) else os.devnull, "w", encoding="utf-8") as f:
        json.dump({v[0]: v[2] for v in composition.values() if v[2]}, f, ensure_ascii=False, indent=0)
    # L'historique (AMO30) porte les fonctions au sein de l'Assemblée et les circonscriptions ; le fichier
    # de la législature (AMO20) porte en outre les membres du Gouvernement qui ne sont pas députés.
    archives = [telecharger(rapport, ADRESSES[:1]), telecharger(rapport, ADRESSES[1:])]
    for brut in archives:
        if not brut:
            continue
        with zipfile.ZipFile(io.BytesIO(brut)) as z:
            organes = {}
            for nom in z.namelist():
                if "/organe/" in nom and nom.endswith(".json"):
                    o = json.load(z.open(nom))["organe"]
                    organes[texte(o.get("uid"))] = (texte(o.get("codeType")), texte(o.get("libelle")))
            for nom in z.namelist():
                if "/acteur/" not in nom or not nom.endswith(".json"):
                    continue
                a = json.load(z.open(nom))["acteur"]
                ident = a["etatCivil"]["ident"]
                naissance = texte((a["etatCivil"].get("infoNaissance") or {}).get("dateNais"))[:10]
                mandats = a.get("mandats", {}).get("mandat", [])
                if isinstance(mandats, dict):
                    mandats = [mandats]
                for m in mandats:
                    if m.get("typeOrgane") == "ASSEMBLEE":
                        lieu = (m.get("election") or {}).get("lieu") or {}
                        if texte(lieu.get("numCirco")):
                            circos.append({"prenom": ident.get("prenom"), "nom": ident.get("nom"), "naissance": naissance,
                                           "departement": texte(lieu.get("departement")), "num": texte(lieu.get("numCirco")),
                                           "code_dep": texte(lieu.get("numDepartement")),
                                           "debut": texte(m.get("dateDebut"))[:10] or None,
                                           "fin": texte(m.get("dateFin"))[:10] or None})
                    if True:
                        q = m.get("infosQualite") or {}
                        ref = (m.get("organes") or {}).get("organeRef")
                        ref = ref[0] if isinstance(ref, list) else ref
                        type_o, lib_o = organes.get(texte(ref), (texte(m.get("typeOrgane")), ""))
                        code, libelle = fonction_assemblee(texte(m.get("typeOrgane")) or type_o, texte(q.get("codeQualite")), lib_o)
                        if code:
                            assemblee.append({"code": code, "fonction": libelle, "prenom": ident.get("prenom"),
                                              "nom": ident.get("nom"), "naissance": naissance,
                                              "debut": texte(m.get("dateDebut"))[:10] or None,
                                              "fin": texte(m.get("dateFin"))[:10] or None})
                    if m.get("typeOrgane") != "GOUVERNEMENT":
                        continue
                    vus_gouv.append(texte(m.get("dateDebut"))[:10])
                    if texte(m.get("dateDebut"))[:10] > DEPUIS and len(exemples) < 8:
                        q_ = m.get("infosQualite") or {}
                        ref_ = (m.get("organes") or {}).get("organeRef")
                        exemples.append(f"{ident.get('prenom')} {ident.get('nom')} : " + json.dumps(
                            {"qualite": q_, "organe": organes.get(texte(ref_[0] if isinstance(ref_, list) else ref_)),
                             "autres": {k: v for k, v in m.items() if k not in ("infosQualite", "organes", "suppleants", "collaborateurs")}},
                            ensure_ascii=False)[:600])
                    debut = texte(m.get("dateDebut"))[:10]
                    if not debut or debut <= DEPUIS:
                        continue
                    q = m.get("infosQualite") or {}
                    code, libelle = texte(q.get("codeQualite")), texte(q.get("libQualite"))
                    cat = categorie(code, libelle)
                    if not cat:
                        # Qualité « membre » : intitulé repris de la composition officielle, pour les fonctions en cours
                        nom_complet = f"{ident.get('prenom')} {ident.get('nom')}"
                        fin_m = texte(m.get("dateFin"))[:10]
                        libelle = intitule_officiel(nom_complet, debut)
                        officiel = composition.get(norme(nom_complet))
                        if officiel and not fin_m and (not libelle or debut >= "2026-02-26"):
                            libelle = officiel[1]  # page en ligne, si accessible et plus récente
                        if libelle:
                            cat = categorie("", libelle)
                        if not cat:
                            sans_intitule.append(f"{ident.get('prenom')} {ident.get('nom')} ({texte(m.get('dateDebut'))[:10]} -> {fin_m or 'en cours'})")
                            continue
                    fin_mandat = texte(m.get("dateFin"))[:10] or None
                    # Mandat en cours dont l'intitulé a changé lors d'un remaniement sans nouvelle nomination
                    # dans l'open data (ex. : ministre délégué devenu ministre) : deux fonctions successives
                    changements = [] if fin_mandat else changements_ulterieurs(f"{ident.get('prenom')} {ident.get('nom')}", debut, libelle)
                    bornes = [debut] + [d for d, _ in changements]
                    intitules = [libelle or code] + [t for _, t in changements]
                    for k, (d_k, t_k) in enumerate(zip(bornes, intitules)):
                        f_k = bornes[k + 1] if k + 1 < len(bornes) else fin_mandat
                        lignes.append({"liste": categorie("", t_k) or cat, "prenom": ident.get("prenom"), "nom": ident.get("nom"),
                                       "debut": d_k, "fin": f_k, "fonction": t_k})
    vus = set()
    lignes = [l for l in lignes if not ((k := (l["prenom"], l["nom"], l["debut"], l["fonction"])) in vus or vus.add(k))]
    assemblee_vus = set()
    assemblee = [x for x in assemblee if not ((k := (x["prenom"], x["nom"], x["debut"], x["fonction"])) in assemblee_vus or assemblee_vus.add(k))]
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(lignes, f, ensure_ascii=False, indent=0)
    rattacher_assemblee(assemblee, rapport, circos)
    rapport.append(f"Mandats gouvernementaux présents dans les fichiers : {len(vus_gouv)} ; le plus récent commence le "
                   f"{max(vus_gouv) if vus_gouv else '—'}")
    rapport.append(f"Fonctions gouvernementales postérieures au {DEPUIS} : {len(lignes)} (intitulés : compositions officielles d'info.gouv.fr)")
    if sans_intitule:
        rapport.append(f"Fonctions récentes non reprises faute d'intitulé officiel : {len(sans_intitule)}")
        rapport += ["  " + e for e in sorted(set(sans_intitule))]
    rapport += [f"  {l['prenom']} {l['nom']} : {l['fonction']} ({l['debut']} -> {l['fin'] or 'en cours'})"
                for l in sorted(lignes, key=lambda x: x["debut"])]
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")
    print("\n".join(rapport[:6]))


def rattacher_assemblee(assemblee, rapport, circos=()):
    """Rattachement aux cartes : même date de naissance et même nom de famille (tous ses mots)."""
    if not assemblee or not os.path.exists(os.path.join("data", "cartes.json")):
        rapport.append("Fonctions au sein de l'Assemblée : aucune lue")
        return
    with open(os.path.join("data", "cartes.json"), encoding="utf-8") as f:
        cartes = json.load(f)
    import re
    from collections import defaultdict
    mots = lambda t: set(re.findall(r"[a-z]+", norme(t))) - {"de", "du", "des", "la", "le", "d", "l"}
    par_date = defaultdict(list)
    for c in cartes:
        if c.get("naissance"):
            par_date[c["naissance"]].append(c)
    membres, detail, orphelins = defaultdict(set), defaultdict(list), set()
    for x in assemblee:
        candidats = [c for c in par_date.get(x["naissance"], []) if mots(x["nom"]) and mots(x["nom"]) <= mots(c["nom"])]
        if len(candidats) != 1:
            orphelins.add(f"{x['prenom']} {x['nom']} ({x['naissance']})")
            continue
        ident = candidats[0]["id"]
        membres[x["code"]].add(ident)
        detail[str(ident)].append({"fonction": x["fonction"], "liste": x["code"], "debut": x["debut"], "fin": x["fin"]})
    # Numéros de circonscription des mandats de député (open data, depuis 1997)
    par_carte = defaultdict(list)
    for x in circos:
        candidats = [c for c in par_date.get(x["naissance"], []) if mots(x["nom"]) and mots(x["nom"]) <= mots(c["nom"])]
        if len(candidats) == 1:
            par_carte[str(candidats[0]["id"])].append({k: x[k] for k in ("departement", "code_dep", "num", "debut", "fin")})
    with open(os.path.join("data", "gouvernement", "circonscriptions.json"), "w", encoding="utf-8") as f:
        json.dump(par_carte, f, ensure_ascii=False, indent=0)
    rapport.append(f"Circonscriptions rattachées : {len(par_carte)} députés")
    for code, (points, libelle) in LISTES_ASSEMBLEE.items():
        with open(os.path.join("data", "listes", code + ".json"), "w", encoding="utf-8") as f:
            json.dump({"code": code, "points": points, "plancher": None, "libelle": libelle,
                       "source": "Assemblée nationale, open data (mandats au sein des organes), depuis 2002 (XIIe législature)",
                       "ids": sorted(membres[code], key=str)}, f, ensure_ascii=False, indent=1)
    fusion = {}
    for ident, fs in detail.items():
        uniques = {}
        for x in sorted(fs, key=lambda x: x["debut"] or ""):
            u = uniques.setdefault(x["fonction"], dict(x))
            u["fin"] = None if not (u["fin"] and x["fin"]) else max(u["fin"], x["fin"])
        fusion[ident] = list(uniques.values())
    with open(os.path.join("data", "gouvernement", "fonctions_assemblee.json"), "w", encoding="utf-8") as f:
        json.dump(fusion, f, ensure_ascii=False, indent=0)
    rapport.insert(1, "Fonctions au sein de l'Assemblée : " + ", ".join(f"{k} {len(v)}" for k, v in membres.items())
                   + f" ; non rattachées : {len(orphelins)}")


if __name__ == "__main__":
    main()
