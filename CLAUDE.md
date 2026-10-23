# TGCParlement — note de reprise

Jeu de cartes à collectionner sur les parlementaires français depuis 1789 (« Hémicycle »).
Site statique dans `site/` (HTML et JavaScript natifs, sans compilation), publié par Cloudflare depuis ce dépôt :
`index.html` (interface), `regles.js` (règles du jeu), `jeu.json` (cartes, écrit par `export_jeu.py`).
Données construites par les scripts Python de `scripts/` (bibliothèque standard uniquement), lancés par
le workflow `.github/workflows/listes.yml` (« Listes fermées et cartes »), qui enregistre `data/` et `site/`.

## Règles du projet

- Sources officielles uniquement (Assemblée nationale : Sycomore et open data ; Sénat : data.senat.fr ;
  data.gouv.fr ; info.gouv.fr ; Insee via geo.api.gouv.fr). Wikidata seulement pour les noms d'usage, les
  portraits et quatre distinctions, toujours rattachés par identifiant officiel (Sycomore P1045, Sénat P1808).
- Rien d'inventé : une information non vérifiable est omise ; un cas douteux est tranché par une décision
  motivée intégrée au script concerné (`DECISIONS_INTEGREES`, `RETIRES_DU_PANTHEON`, etc.).
- Chaque script écrit un rapport dans `data/listes/rapports/` : le lire après chaque exécution.
- Mesurer avant de lire un format inconnu (étape qui liste colonnes et valeurs), puis écrire la lecture.
- Aucun coût, aucune installation sur le poste de l'utilisateur.

## Chaîne de construction (ordre du workflow)

1. `senateurs.py` (open data du Sénat, sénateurs actifs) ; 2. `cartes.py` (première passe, écrit aussi
`data/senat/correspondances.json`) ; 3. `gouvernements_ive.py` (1944-1959, RTF officiel) ;
4. `gouvernements_an.py` (open data AN : fonctions récentes, fonctions au sein de l'Assemblée,
circonscriptions ; intitulés gouvernementaux transcrits d'info.gouv.fr dans `COMPOSITIONS`, à compléter à
chaque remaniement) ; 5. `senat_fonctions.py` (commissions et groupes) puis `senat_bureau.py` (Bureau du
Sénat, lu dans l'export complet `export_sens.zip`, tables `bur` et `senbur`) ; 6. `gouvernements.py`
(Ve République et rattachements) ;
7. `quatre_vingts.py`, `doyens.py`, `presidences.py`, `presidences_senat.py`, `distinctions.py` ;
8. `cartes.py` (version finale : score, rareté par époque, bonus des élus en exercice) ;
9. `portraits.py`, `villes_circonscriptions.py`, `export_jeu.py` (écrit `site/jeu.json`).

## Décisions de notation

- Symétrie des fonctions au sein des chambres (`DECISION_SYMETRIE`, `senat_fonctions.py`) : l'open data de
  l'Assemblée ne porte ces fonctions (Bureau, présidences de commission et de groupe, rapporteur général)
  qu'à partir de la XIIe législature (19 juin 2002 ; AMO30 n'a aucun mandat au Bureau avant). Aucune source
  officielle structurée ne couvre 1958-2002. Une fonction du Sénat ne donne donc des points que si elle a été
  exercée le 19 juin 2002 ou après ; les fonctions antérieures restent dans le détail des cartes, sans points.
  Les listes concernées sont reconstruites à chaque exécution (membres de l'Assemblée + sénateurs retenus).
- Libellés des listes du Bureau communs aux deux chambres (« de l'Assemblée ou du Sénat »), définis dans
  `LISTES_ASSEMBLEE` (`gouvernements_an.py`) et repris par les scripts du Sénat.

## Jeu : règles et préparation d'une vraie application

- `site/regles.js` porte toutes les règles, sans interface ni stockage : tirage des paquets, recyclage,
  échange de points, objectifs. Chaque action est une opération nommée (`ouvrirPaquet`, `recycler`,
  `echangerPoints`, `reclamer`) qui vérifie, modifie l'état et renvoie son résultat ; l'interface n'écrit
  jamais l'état elle-même. Le fichier s'exécute aussi sous Node : le futur serveur (comptes, échanges,
  marché) le reprendra pour devenir seul juge des tirages et des récompenses.
- L'état du joueur est versionné (`VERSION_ETAT`, `migrer`) et passe par l'objet `depot` d'`index.html`
  (navigateur aujourd'hui, serveur demain). Un journal des dernières opérations est tenu dans l'état.
- Économie : 3 paquets par jour, puis les paquets offerts. Recyclage d'un exemplaire en trop : commune 1,
  peu commune 2, rare 5, épique 15, légendaire et hors catégorie 40, mythique 100 points ; 25 points font un
  paquet. Un paquet de doubles rapporte en moyenne 21 points : le prix doit rester au-dessus, sans quoi le
  recyclage créerait des paquets sans fin (vérifié par le test). Par défaut, seules les raretés commune à
  rare sont cochées pour le recyclage : les doubles plus rares serviront aux échanges entre joueurs.
- Objectifs : Quatre-vingts, Compagnons de la Libération, présidents de l'Assemblée, chaque législature
  (table `assemblees` de `jeu.json`), chaque département d'au moins cinq cartes. Paliers dans `PALIERS` ;
  la collection complète donne 5 paquets et a sa propre clé (`@complet`), pour ne se réclamer qu'une fois.
- Tests : `node tests/regles.test.js` (sans installation).

## Prochaines tâches

1. Application : comptes, sauvegarde de la collection côté serveur (reprise de l'état local à la première
   connexion), échanges entre joueurs, marché. Le partage de la collection par un lien n'a pas été fait :
   les comptes le remplaceront.
2. Lacunes connues, faute de source officielle structurée : sénateurs de la IIIe République et du Conseil
   de la République (1946-1948), gouvernements antérieurs à 1944, villes des circonscriptions avant 2012,
   fonctions au sein de l'Assemblée avant juin 2002 (seuls les comptes rendus de séance en PDF les portent ;
   leur lecture lèverait la règle de symétrie).
