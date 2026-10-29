#!/usr/bin/env python3
"""Fiches de jeu du Gouvernement : stature de chaque carte et étoiles de spécialité sur les cinquante thèmes.

Règles décidées avec l'utilisateur (octobre 2026, CLAUDE.md, « Jeu du Gouvernement ») :
- stature de 1 à 5, tirée du score de la carte (`TRANCHES`), un point de moins sans mandat parlementaire (1 au moins) ;
- étoiles par thème de politique publique : 3 pour un ministre du domaine (intitulé officiel de la fonction), 2 pour un
  secrétaire d'État du domaine ou la présidence de la commission permanente liée, 1 pour cinq ans au moins dans la
  commission liée ; années de commission et fonctions au sein des chambres comptées depuis le 19 juin 2002 seulement
  (règle de symétrie, `DECISION_SYMETRIE` de senat_fonctions.py : l'open data de l'Assemblée ne les porte pas avant) ;
- Relations avec le Parlement : 3 pour le ministre ou la présidence d'une chambre, 2 pour le secrétaire d'État, la
  vice-présidence, la questure ou la présidence d'un groupe, 1 pour le secrétariat du Bureau ;
- territoires (13 régions actuelles, Paris, Outre-mer, Français de l'étranger) : 1 étoile pour un mandat dans le
  territoire, 2 pour plusieurs ; 3 pour un ministre (Outre-mer, Français de l'étranger), 2 pour un secrétaire d'État.
Les ministres d'avant 1944 n'ont pas d'étoile de fonction gouvernementale : aucune source officielle structurée ne
couvre ces gouvernements (lacune acceptée par l'utilisateur).

Une fonction gouvernementale est lue dans son domaine : pour « Secrétaire d'État auprès du ministre X, chargé de Y »,
seul « Y » compte (`domaine`). Les fonctions sans date de fin (gouvernements de la IVe République, lus dans le RTF
officiel) sont closes la veille de l'entrée en fonction du chef du Gouvernement suivant, pour les liens de jeu.

Régions : Code officiel géographique de l'Insee (API Métadonnées, sans clé), départements de chaque région en vigueur ;
les anciens noms passent par leur numéro (site/departements.json, numeros_departements.py), sauf décisions
`DECISION_TERRITOIRES`.

Entrées : data/cartes.json, data/gouvernement/{fonctions,fonctions_assemblee,presidences_an,presidences_senat,
commissions}.json, site/departements.json.
Sorties : site/gouvernement.json (thèmes, groupes, départements, fiches), site/fiches/ (fiches découpées pour le
serveur), data/listes/rapports/fiches-gouvernement-rapport.txt
"""
import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from commissions import familles as familles_commission  # noqa: E402

SORTIE = os.path.join("site", "gouvernement.json")
RAPPORT = os.path.join("data", "listes", "rapports", "fiches-gouvernement-rapport.txt")
SYMETRIE = "2002-06-19"
ANNEES_COMMISSION = 5
PAQUETS_FICHES = 256  # comme PAQUETS_FICHES de site/gouvernement.js
# Stature : score de la carte -> 1 à 5 (bornes basses des tranches 2 à 5)
TRANCHES = [10, 20, 35, 55]
API_INSEE = "https://api.insee.fr/metadonnees/V1/geo/{}"
UA = {"User-Agent": "TGCParlement/1.0", "Accept": "application/json"}

# Thèmes de politique publique : (code, libellé, motif de l'intitulé de la fonction, familles de commission)
POLITIQUES = [
    ("interieur", "Intérieur", r"(?<!commerce )\binterieur|^securite\b|securite (publique|du quotidien)|citoyennete", ["lois"]),
    ("justice", "Justice", r"justice|garde des sceaux|victimes|penitentiaire", ["lois"]),
    ("etat", "Fonction publique et réforme de l'État",
     r"fonction publique|reforme de l.etat|reformes? administratives?|transformation (et de la fonction )?publique|"
     r"modernisation de l.etat|simplification|reforme constitutionnelle|institutions nouvelles|administration generale|"
     r"\bdes reformes$|coordination gouvernementale|evaluation des politiques publiques", ["lois"]),
    ("immigration", "Immigration et intégration", r"immigration|integration|rapatries|naturalisation|immigres", ["lois"]),
    ("parlement", "Relations avec le Parlement", r"relations avec (le parlement|l.assemblee|les assemblees)", []),
    ("budget", "Budget", r"budget|comptes publics", ["finances"]),
    ("economie", "Économie", r"econom(?!ie numerique)|finances|tresor|redressement productif|relance|privatisation|secteur public|"
     r"interessement|\bplan\b|prospective", ["finances", "economie"]),
    ("commerce-exterieur", "Commerce extérieur", r"commerce exterieur|exportation|attractivite", ["economie", "affaires-etrangeres"]),
    ("industrie", "Industrie", r"industri|\bmines\b", ["economie"]),
    ("commerce", "Commerce, artisanat et consommation",
     r"commerce(?! exterieur)|artisanat|consommation|petites et moyennes|\bpme\b|independants", ["economie"]),
    ("tourisme", "Tourisme", r"tourisme", ["economie"]),
    ("numerique", "Postes et numérique",
     r"\bpostes\b|telecommunications|numerique|\bp\.? ?t\.? ?t\b|intelligence artificielle", ["economie"]),
    ("diplomatie", "Diplomatie", r"affaires etrangeres|relations exterieures|affaires marocaines|affaires allemandes", ["affaires-etrangeres"]),
    ("europe", "Europe", r"europ", ["affaires-etrangeres"]),
    ("cooperation", "Coopération et francophonie",
     r"cooperation|francophonie|developpement international|^developpement\b(?! durable| rural| economique| industriel| de la)|"
     r"partenariats internationaux|action humanitaire|droits de l.homme",
     ["affaires-etrangeres"]),
    ("defense", "Défense", r"guerre|defense(?! des consommateurs)|armees?\b|forces armees|\bmarine\b(?! marchande)|\bl?air\b|armement",
     ["defense"]),
    ("memoire", "Anciens combattants et mémoire", r"anciens combattants|victimes de guerre|memoire|prisonniers|deportes", ["defense"]),
    ("education", "Éducation", r"education(?! physique)|instruction publique|enseignement(?! superieur)|reussite (scolaire|educative)",
     ["culture-education"]),
    ("recherche", "Recherche et université", r"recherche|enseignement superieur|universit", ["culture-education"]),
    ("culture", "Culture", r"(?<!agri)culture|beaux-arts|arts et lettres|patrimoine", ["culture-education"]),
    ("communication", "Information et communication",
     r"\binformation\b|(?<!tele)communication(?!s electroniques)|porte-parole|audiovisuel|radiodiffusion", ["culture-education"]),
    ("jeunesse", "Jeunesse et vie associative", r"jeunesse|vie associative|engagement|service national|temps libre", ["culture-education"]),
    ("sports", "Sports", r"\bsports?\b|jeux olympiques|education physique", ["culture-education"]),
    ("sante", "Santé", r"sante|hygiene|\bmaladie", ["affaires-sociales"]),
    ("travail", "Travail et emploi",
     r"travail|emploi|formations? professionnel|apprentissage|insertion|dialogue social|participation", ["affaires-sociales"]),
    ("solidarites", "Solidarités et famille",
     r"solidarit|famille|population|affaires sociales|securite sociale|protection sociale|enfance|pauvrete|exclusion|retraite|action sociale|cohesion sociale",
     ["affaires-sociales"]),
    ("handicap", "Handicap et dépendance", r"handicap|personnes agees|dependance|autonomie|aines|readaptation", ["affaires-sociales"]),
    ("egalite", "Droits des femmes et égalité",
     r"droits des femmes|droits de la femme|condition feminine|egalite|parite|discrimination", ["affaires-sociales"]),
    ("agriculture", "Agriculture", r"agricult|ravitaillement|\bpeche|aliment|foret", ["economie"]),
    ("transports", "Transports", r"transport|travaux publics|aviation|\bequipement|\broutes?\b|ferroviaire", ["territoires"]),
    ("mer", "Mer", r"\bmer\b|marine marchande|maritime", ["territoires"]),
    ("logement", "Logement et ville",
     r"logement|\bville\b|construction|reconstruction|urbanisme|quartiers", ["territoires", "economie"]),
    ("ecologie", "Écologie et énergie",
     r"environnement|ecolog|energie|transition (ecologique|energetique)|developpement durable|climat|biodiversite|protection de la nature|"
     r"qualite de (la )?vie|risques (naturels|technologiques)|charbon", ["territoires"]),
    ("territoires", "Aménagement et collectivités",
     r"amenagement du territoire|collectivites|decentralisation|cohesion des territoires|ruralite|\bterritoires\b|"
     r"developpement rural|reforme territoriale|libertes locales",
     ["territoires", "lois"]),
]
# Territoires : (code, libellé, codes de région de l'Insee, motif d'une fonction gouvernementale du territoire)
REGIONS = [
    ("auvergne-rhone-alpes", "Auvergne-Rhône-Alpes", ["84"]), ("bourgogne-franche-comte", "Bourgogne-Franche-Comté", ["27"]),
    ("bretagne", "Bretagne", ["53"]), ("centre-val-de-loire", "Centre-Val de Loire", ["24"]), ("corse", "Corse", ["94"]),
    ("grand-est", "Grand Est", ["44"]), ("hauts-de-france", "Hauts-de-France", ["32"]),
    ("ile-de-france", "Île-de-France", ["11"]), ("normandie", "Normandie", ["28"]),
    ("nouvelle-aquitaine", "Nouvelle-Aquitaine", ["75"]), ("occitanie", "Occitanie", ["76"]),
    ("pays-de-la-loire", "Pays de la Loire", ["52"]), ("provence-alpes-cote-d-azur", "Provence-Alpes-Côte d'Azur", ["93"]),
]
TERRITOIRES_HORS_REGION = [
    ("paris", "Paris", None),
    ("outre-mer", "Outre-mer", r"outre-mer|outre mer|colonies|\bd\.?o\.?m\b|dom-tom|france d.outre|nouvelle-caledonie|pacifique|"
     r"etats associes|etats de la communaute"),
    ("etranger", "Français de l'étranger", r"francais (de l.etranger|a l.etranger|etablis hors de france)"),
]
DECISION_TERRITOIRES = (
    "Paris : le département de Paris et celui de la Seine (supprimé en 1968, chef-lieu Paris) ; Paris compte aussi pour "
    "l'Île-de-France, dont il fait partie. Outre-mer : les départements et régions d'outre-mer de l'Insee, les collectivités "
    "d'outre-mer, et les anciennes colonies et territoires d'outre-mer représentés au Parlement (`OUTRE_MER`), suivis par "
    "les ministères des colonies puis de la France d'outre-mer ; les départements d'Algérie (numéros 91 à 94 avant 1962, "
    "réattribués à l'Île-de-France en 1968) et les citoyens français du Maroc et de Tunisie n'appartiennent à aucun "
    "territoire du jeu, sauf ces derniers pour les Français de l'étranger, qu'ils représentaient. Les départements "
    "antérieurs à 1943 absents du Code officiel géographique (`ANCIENS`) sont rattachés à la région de leur chef-lieu ; "
    "ceux de l'Empire aujourd'hui hors de France, à aucune.")
EXCLUS = {"Alger", "Oran", "Constantine", "Territoires du sud de l'Algérie", "Bône", "Anciens départements d'Algérie", "Oasis",
          "Saoura", "Département d'élection inconnu"}
# Circonscriptions d'Algérie de la IVe et de la Ve République (jusqu'en 1962), hors de tout territoire du jeu
ALGERIE = {"Alger-banlieue", "Alger-ville", "Batna", "Bône", "Constantine", "Médéa", "Mostaganem", "Oran", "Orléansville",
           "Sétif", "Tizi-Ouzou", "Tlemcen", "Setif-Batna", "Mostaganem-Tiaret", "Oran-Tlemcen", "Orléansville-Médéa",
           "Aumale-Tizi-Ouzou", "Bône-Tébessa", "Constantine-Philippeville", "Saïda-Tiaret", "Tiaret", "Saïda"}
# Graphies des sources des cartes -> intitulé de l'Insee
GRAPHIES = {"Territoire-de-Belfort": "Territoire de Belfort", "Côtes d'Armor": "Côtes-d'Armor",
            "Alpes de Haute-Provence": "Alpes-de-Haute-Provence", "Seine-St-Denis": "Seine-Saint-Denis"}
# Fonctions gouvernementales propres à une région
MOTIFS_REGION = {"ile-de-france": r"region capitale|grand paris"}
OUTRE_MER = {
    "Guadeloupe", "Martinique", "Guyane", "La Réunion", "Réunion", "Mayotte", "Saint-Pierre-et-Miquelon",
    "Polynésie française", "Nouvelle-Calédonie", "Wallis-et-Futuna", "Saint-Barthélemy et Saint-Martin",
    "Madagascar", "Sénégal", "Etablissements français de l’Inde", "Etablissements français de l'Inde", "Saint-Domingue",
    "Soudan", "Cameroun", "Cochinchine française", "Haute-Volta", "Comores", "Guinée", "Côte-d'Ivoire",
    "Oubangui-Chari-Tchad", "Gabon", "Niger", "Tchad", "Dahomey", "Côte française des Somalis", "Etablissements français d'Océanie",
    "Dahomey-Togo", "Gabon-Moyen-Congo", "Sénégal-Mauritanie", "Soudan-Niger", "Oubangui-Chari", "Territoire français des Affars et des Issas",
    "Moyen-Congo", "Mauritanie", "Togo", "Iles Wallis et Futuna", "Saint-Barthélemy", "Saint-Martin", "Ile-de-France (Maurice)", "Inde française", "Indes françaises",
}
ETRANGER = {"Français établis hors de France", "Etranger", "Citoyens français du Maroc", "Citoyens français de Tunisie"}
# Départements disparus avant 1943 (hors Code officiel géographique) : région actuelle de leur chef-lieu
ANCIENS = {
    "Meurthe": "44", "Rhône-et-Loire": "84", "Mont-Blanc": "84", "Seine-Inférieure": "28", "Loire-Inférieure": "52",
    "Basses-Alpes": "93", "Basses-Pyrénées": "75", "Charente-Inférieure": "75", "Côtes-du-Nord": "53",
    "Seine-et-Oise": "11", "Seine": "11", "Corse": "94", "Golo": "94", "Liamone": "94", "Var": "93",
}


def norme(t):
    t = unicodedata.normalize("NFD", t or "")
    return re.sub(r"\s+", " ", "".join(ch for ch in t if unicodedata.category(ch) != "Mn").lower().replace("’", "'")).strip()


def domaine(intitule):
    """Partie de l'intitulé qui dit le domaine : « …, chargé(e) de Y » -> « Y » ; sinon l'intitulé entier.
    Les mentions « outre-mer » sont écrites à part pour que « mer » ne les confonde pas avec la Mer, et « victimes de
    guerre » pour que la Défense ne prenne pas les anciens combattants."""
    n = norme(intitule)
    m = re.search(r"\bcharge(e|s|es)? (de la |de l'|du |des |de )?(.*)$", n)
    if m and not n.startswith(("ministre charge", "ministre delegue charge", "ministre deleguee chargee")):
        n = m.group(3)
    return n


def correspond(motif, n, code):
    if code == "mer":
        n = re.sub(r"outre[- ]mer", "", n)
    if code == "defense":
        n = n.replace("victimes de guerre", "")
    return re.search(motif, n) is not None


def jour(d):
    return datetime.date.fromisoformat(d[:10])


def lire(chemin):
    if os.path.exists(chemin):
        with open(chemin, encoding="utf-8") as f:
            return json.load(f)
    return {}


def insee(chemin):
    erreur = None
    for attente in (0, 10, 30):
        time.sleep(attente)
        try:
            with urllib.request.urlopen(urllib.request.Request(API_INSEE.format(chemin), headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — le rapport dit ce qui a échoué
            erreur = e
    raise RuntimeError(f"{chemin} ({erreur})")


def regions_des_departements(rapport):
    """Numéro de département en vigueur -> code de région, d'après le Code officiel géographique de l'Insee."""
    region_de = {}
    for code, _, regions in REGIONS:
        for r in regions:
            for d in insee(f"region/{r}/descendants?type=Departement"):
                region_de[d["code"]] = r
    for r in insee("regions"):
        if r["code"] in ("01", "02", "03", "04", "06"):
            for d in insee(f"region/{r['code']}/descendants?type=Departement"):
                region_de[d["code"]] = "outre-mer"
    rapport.append(f"Insee : {len(region_de)} départements rattachés à une région")
    return region_de


def territoires_carte(c, region_de, numeros, inconnus):
    """Nombre de mandats parlementaires de la carte par territoire du jeu."""
    compte = Counter()
    for m in c.get("mandats") or []:
        nom = m.get("departement")
        if not nom:
            f = re.match(r"S[ée]nat(eur|rice) \((.+)\)$", m.get("fonction") or "")
            nom = f.group(2) if f else None
        if not nom:
            continue
        nom = GRAPHIES.get(nom, nom)
        cles = set()
        if nom.startswith("Départements de l'Empire français aujourd'hui") or nom in ALGERIE:
            continue
        if nom in ETRANGER:
            cles.add("etranger")
        elif nom in OUTRE_MER:
            cles.add("outre-mer")
        elif nom in EXCLUS:
            pass
        elif nom in ("Paris", "Seine"):
            cles |= {"paris", "11"}
        elif nom in ANCIENS:
            cles.add(ANCIENS[nom])
        elif nom in numeros:
            for n in numeros[nom]:
                if n in region_de:
                    cles.add(region_de[n])
        else:
            inconnus[nom] += 1
        for k in cles:
            compte[k] += 1
    return compte


def periodes_gouvernement(fonctions):
    """Fonctions gouvernementales -> périodes [début, fin] en dates ; fin manquante close la veille de l'entrée en
    fonction du chef du Gouvernement suivant."""
    debuts_chefs = sorted({x["debut"] for v in fonctions.values() for x in v if x["liste"] == "chef-gouvernement" and x["debut"]})

    def fin_de(x):
        if x["fin"]:
            return x["fin"]
        suivants = [d for d in debuts_chefs if d > x["debut"]]
        return (jour(suivants[0]) - datetime.timedelta(days=1)).isoformat() if suivants else None
    return fin_de


def main():
    rapport = [DECISION_TERRITOIRES, ""]
    cartes = lire(os.path.join("data", "cartes.json"))
    gouv = lire(os.path.join("data", "gouvernement", "fonctions.json"))
    chambres = lire(os.path.join("data", "gouvernement", "fonctions_assemblee.json"))
    presidences = lire(os.path.join("data", "gouvernement", "presidences_an.json"))
    for k, v in lire(os.path.join("data", "gouvernement", "presidences_senat.json")).items():
        presidences.setdefault(k, []).extend(v)
    commissions = lire(os.path.join("data", "gouvernement", "commissions.json"))
    numeros = lire(os.path.join("site", "departements.json"))
    try:
        region_de = regions_des_departements(rapport)
    except RuntimeError as e:
        rapport.append(f"Insee indisponible ({e}) : fiches précédentes gardées")
        ecrire_rapport(rapport)
        return
    fin_de = periodes_gouvernement(gouv)
    themes = [(code, lib, "P") for code, lib, _, _ in POLITIQUES] + [(code, lib, "T") for code, lib, _ in REGIONS] + \
             [(code, lib, "T") for code, lib, _ in TERRITOIRES_HORS_REGION]
    indice = {code: i for i, (code, _, _) in enumerate(themes)}
    region_theme = {r: code for code, _, regions in REGIONS for r in regions}
    fiches, inconnus, etoiles_par_theme, staturess = {}, Counter(), defaultdict(Counter), Counter()
    groupes, index_groupe, departements, index_dep = [], {}, [], {}
    exemples_fonctions = defaultdict(set)
    for c in cartes:
        ident = str(c["id"])
        etoiles = Counter()

        def donner(code, n):
            etoiles[code] = max(etoiles[code], n)
        # Fonctions gouvernementales
        periodes, chefs = [], []
        for x in gouv.get(ident, []):
            if x["liste"] == "chef-gouvernement" and x["debut"]:
                chefs.append([x["debut"], fin_de(x)])
            if x["liste"] not in ("ministre", "secretaire-etat") or not x["debut"]:
                continue
            periodes.append([x["debut"], fin_de(x)])
            n = domaine(x["fonction"])
            niveau = 3 if x["liste"] == "ministre" else 2
            for code, _, motif, _ in POLITIQUES:
                if correspond(motif, n, code):
                    donner(code, niveau)
                    exemples_fonctions[code].add(x["fonction"])
            for code, motif in [(c, m) for c, _, m in TERRITOIRES_HORS_REGION] + list(MOTIFS_REGION.items()):
                if motif and re.search(motif, n):
                    donner(code, niveau)
                    exemples_fonctions[code].add(x["fonction"])
        # Fonctions au sein des chambres (depuis le 19 juin 2002, symétrie)
        for x in chambres.get(ident, []):
            if (x.get("fin") or "9999") < SYMETRIE:
                continue
            if x["liste"] == "presidence-commission":
                f = familles_commission(x["fonction"], "Sénat" if "Sénat" in x["fonction"] else "Assemblée")
                for code, _, _, fams in POLITIQUES:
                    if set(f) & set(fams):
                        donner(code, 2)
            elif x["liste"] == "rapporteur-general" and "finances" in norme(x["fonction"]):
                donner("budget", 2)
            elif x["liste"] in ("bureau-vp-questeur", "presidence-groupe"):
                donner("parlement", 2)
            elif x["liste"] == "bureau-secretaire":
                donner("parlement", 1)
        if presidences.get(ident):
            donner("parlement", 3)
        # Années en commission (depuis le 19 juin 2002, symétrie)
        jours = Counter()
        for x in commissions.get(ident, []):
            debut = max(x["debut"], SYMETRIE)
            fin = x["fin"] or datetime.date.today().isoformat()
            if fin <= debut:
                continue
            for fam in x["familles"]:
                jours[fam] += (jour(fin) - jour(debut)).days
        for code, _, _, fams in POLITIQUES:
            if any(jours[f] >= ANNEES_COMMISSION * 365.25 for f in fams):
                donner(code, 1)
        # Territoires
        for cle, n in territoires_carte(c, region_de, numeros, inconnus).items():
            code = region_theme.get(cle, cle)
            donner(code, 1 if n == 1 else 2)
        # Stature
        stature = 1 + sum(c["score"] >= t for t in TRANCHES)
        if not c.get("mandats"):
            stature = max(1, stature - 1)
        staturess[stature] += 1
        etoiles = {k: v for k, v in etoiles.items() if v}
        for k, v in etoiles.items():
            etoiles_par_theme[k][v] += 1
        # Liens : groupe affiché sur la carte, départements des mandats (sénateurs : département de la fonction)
        groupe = c.get("groupe") or ""
        if groupe and groupe not in index_groupe:
            index_groupe[groupe] = len(groupes)
            groupes.append(groupe)
        deps = set()
        for m in c.get("mandats") or []:
            f = re.match(r"S[ée]nat(eur|rice) \((.+)\)$", m.get("fonction") or "")
            d = GRAPHIES.get(m.get("departement") or (f.group(2) if f else ""), m.get("departement") or (f.group(2) if f else ""))
            if d:
                if d not in index_dep:
                    index_dep[d] = len(departements)
                    departements.append(d)
                deps.add(index_dep[d])
        fiche = [stature, sorted(indice[k] * 4 + v for k, v in etoiles.items()), round(c.get("annees_mandat") or 0, 1),
                 index_groupe[groupe] if groupe else -1, sorted(deps)]
        if periodes or chefs:
            fiche += [sorted(periodes, key=lambda p: p[0]), sorted(chefs, key=lambda p: p[0])]
        fiches[ident] = fiche
    # fiche : [stature, étoiles (indice du thème × 4 + nombre), années de mandat, groupe (-1 sans groupe), départements,
    #          puis, pour les membres du Gouvernement, périodes de fonction et périodes à la tête du Gouvernement]
    sortie = {"themes": [[code, lib, t] for code, lib, t in themes], "groupes": groupes, "departements": departements,
              "fiches": fiches}
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(sortie, f, ensure_ascii=False, separators=(",", ":"))
    ecrire_fiches_serveur(fiches, len(themes), rapport)
    rapport.insert(0, f"Fiches : {len(fiches)} cartes ; stature : " + ", ".join(f"{s} ({n})" for s, n in sorted(staturess.items())))
    rapport += ["", "Cartes par thème et par nombre d'étoiles (1, 2, 3) :"]
    for code, lib, _ in themes:
        e = etoiles_par_theme[code]
        rapport.append(f"  {lib} : {e[1]} / {e[2]} / {e[3]}")
    rapport += ["", "Fonctions gouvernementales retenues par thème (exemples) :"]
    for code, lib, _ in themes:
        ex = sorted(exemples_fonctions[code])
        rapport.append(f"  {lib} ({len(ex)} intitulés) : " + " | ".join(ex[:12]))
    if inconnus:
        rapport += ["", "Circonscriptions sans territoire : " + " ; ".join(f"{k} ({n})" for k, n in inconnus.most_common())]
    ecrire_rapport(rapport)
    print(rapport[0])


def fnv(texte):
    """FNV-1a 32 bits, comme paquetDeFiche (site/gouvernement.js)."""
    h = 2166136261
    for ch in texte:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def chevauche(a, b):
    return any(d1 <= (f2 or "9999") and d2 <= (f1 or "9999") for d1, f1 in a for d2, f2 in b)


def ecrire_fiches_serveur(fiches, nb_themes, rapport):
    """Fiches découpées pour le serveur, qui ne peut pas lire le fichier entier dans sa limite de calcul : PAQUETS
    fichiers rangés par empreinte de l'identifiant (site/fiches/pNNN.json), et un fichier par gouvernement réel (chef et
    membres de gouvernement qui ont servi sous lui) pour l'ordinateur (site/fiches/gNN.json, liste dans reels.json)."""
    dossier = os.path.join("site", "fiches")
    os.makedirs(dossier, exist_ok=True)
    for nom in os.listdir(dossier):
        if nom.endswith(".json"):
            os.remove(os.path.join(dossier, nom))
    paquets = defaultdict(dict)
    for ident, fiche in fiches.items():
        paquets[fnv(ident) % PAQUETS_FICHES][ident] = fiche
    for n in range(PAQUETS_FICHES):
        with open(os.path.join(dossier, f"p{n:03d}.json"), "w", encoding="utf-8") as f:
            json.dump(paquets[n], f, ensure_ascii=False, separators=(",", ":"))
    membres_gouv = [(i, f) for i, f in fiches.items() if len(f) > 5 and f[5]]
    chefs = []
    for ident, fiche in fiches.items():
        if len(fiche) > 6 and fiche[6]:
            membres = [[i, f] for i, f in membres_gouv if i != ident and chevauche(f[5], fiche[6])]
            with open(os.path.join(dossier, f"g{len(chefs):02d}.json"), "w", encoding="utf-8") as f:
                json.dump({"chef": [ident, fiche], "membres": membres}, f, ensure_ascii=False, separators=(",", ":"))
            chefs.append([ident, len(membres)])
    with open(os.path.join(dossier, "reels.json"), "w", encoding="utf-8") as f:
        json.dump({"themes": nb_themes, "chefs": chefs}, f, ensure_ascii=False, separators=(",", ":"))
    rapport.append(f"Fichiers du serveur : {PAQUETS_FICHES} paquets de fiches, {len(chefs)} gouvernements réels")


def ecrire_rapport(rapport):
    os.makedirs(os.path.dirname(RAPPORT), exist_ok=True)
    with open(RAPPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport) + "\n")


if __name__ == "__main__":
    main()
