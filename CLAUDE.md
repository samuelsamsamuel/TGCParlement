# TGCParlement — note de reprise

Jeu de cartes à collectionner sur les parlementaires français depuis 1789 (« Hémicycle »).
Site statique dans `site/` (HTML et JavaScript natifs, sans compilation), publié par Cloudflare depuis ce dépôt.
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

## Prochaines tâches

1. Jeu : recyclage des doubles contre des paquets supplémentaires ; page d'objectifs de collection
   (une législature, les Quatre-vingts, présidents de l'Assemblée, Compagnons de la Libération, département),
   chaque objectif atteint donnant un paquet ; partage de la collection par un lien encodant son état.
2. Lacunes connues, faute de source officielle structurée : sénateurs de la IIIe République et du Conseil
   de la République (1946-1948), gouvernements antérieurs à 1944, villes des circonscriptions avant 2012,
   fonctions au sein de l'Assemblée avant juin 2002 (seuls les comptes rendus de séance en PDF les portent ;
   leur lecture lèverait la règle de symétrie).
