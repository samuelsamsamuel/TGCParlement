# TGCParlement — note de reprise

Jeu de cartes à collectionner sur les parlementaires français depuis 1789 (« Hémicycle »).
Site dans `site/` (HTML et JavaScript natifs, sans compilation) : `index.html` (interface), `regles.js` (règles
du jeu), `jeu.json` (cartes, écrit par `export_jeu.py`), `serveur.json` (catalogue réduit du serveur, écrit par
`scripts/catalogue_serveur.js`). Publié par Cloudflare Workers Builds à chaque commit sur main : le Worker
`worker/index.js` (configuration `wrangler.jsonc`) sert le site et l'API `/api/`, avec la base D1 « hemicycle ».
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
9. `portraits.py`, `villes_circonscriptions.py`, `export_jeu.py` (écrit `site/jeu.json`), puis
`node scripts/catalogue_serveur.js` (écrit `site/serveur.json`).

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
- Tests : `node tests/regles.test.js` (sans installation) ; `tests/api.test.js` contre un serveur local
  (`npx wrangler dev`, mode d'emploi en tête du fichier).

## Vocabulaire du jeu (références parlementaires)

Onglets : Séance (paquets du jour), Hémicycle (collection), Ordre du jour (objectifs), Buvette (échanges et
marché), Mon siège (compte), Règlement (règles). Dissoudre des doubles (recyclage) rapporte des jetons ; à la
buvette, les tractations (échanges entre joueurs) s'adoptent, se rejettent ou se retirent, et les cartes se
vendent au comptoir (marché). Créer un compte : se faire élire ; se connecter : prendre séance ; se
déconnecter : quitter l'hémicycle. Les noms de code (fonctions, API, base) gardent les termes techniques.

## Serveur : comptes, échanges, marché

- Gratuit dans les limites des plans de base de Workers et D1. Le serveur juge tout : tirages (aléa
  cryptographique), recyclage, objectifs, échanges, marché. Le navigateur sans compte garde le mode local.
- Intégrité : chaque écriture est une variation sous contraintes de la base (`CHECK` sur possessions, points,
  paquets du jour ; clés uniques des paliers réclamés et des clôtures d'annonce ou d'échange), dans un lot D1
  exécuté comme une transaction. Une demande croisée viole une contrainte et n'écrit rien (409). SQLite
  vérifie les `CHECK` d'une insertion avant le conflit : un retrait de cartes est donc toujours un `UPDATE`
  sur une ligne vérifiée au préalable (les lignes de possession ne sont jamais supprimées).
- Mots de passe : étirés dans le navigateur (PBKDF2-SHA-256, 600 000 tours, sel « hemicycle|pseudo »), le
  serveur ne garde que SHA-256(sel aléatoire + preuve) ; le calcul lent hors du Worker tient dans la limite de
  10 ms de calcul du plan gratuit. Pas de récupération de mot de passe faute d'envoi d'e-mails.
- Reprise de la collection locale à l'inscription, une fois : exemplaires « importés », verrouillés (ni
  recyclés ni cédés), faute de pouvoir vérifier leur origine ; paliers déjà atteints marqués réclamés ; points
  et paquets offerts non repris. Une carte en vente est « réservée », verrouillée de même.
- Monnaie du marché : les points de recyclage. Pas d'argent réel.
- Limites connues : un joueur peut ouvrir plusieurs comptes et faire passer leurs cartes vers un seul
  (inscriptions limitées à cinq par heure et par adresse IP, sans plus) ; pas de modération des pseudos.

## Prochaines tâches

1. Application : comptes, sauvegarde côté serveur, buvette (tractations et comptoir) en service, base D1
   « hemicycle » reliée dans `wrangler.jsonc`. Ensuite : adresse e-mail vérifiée (récupération du mot de
   passe, frein aux comptes multiples), modération des pseudos, notifications de tractation.
2. Lacunes connues, faute de source officielle structurée : sénateurs de la IIIe République et du Conseil
   de la République (1946-1948), gouvernements antérieurs à 1944, villes des circonscriptions avant 2012,
   fonctions au sein de l'Assemblée avant juin 2002 (seuls les comptes rendus de séance en PDF les portent ;
   leur lecture lèverait la règle de symétrie).
