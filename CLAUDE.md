# TGCParlement — note de reprise

Jeu de cartes à collectionner sur les parlementaires français depuis 1789 (« Hémicycle »).
Site dans `site/` (HTML et JavaScript natifs, sans compilation) : `index.html` (interface), `regles.js` (règles
du jeu), `jeu.json` (cartes, écrit par `export_jeu.py`), `serveur.json` (catalogue réduit du serveur, écrit par
`scripts/catalogue_serveur.js`). Publié par Cloudflare Workers Builds à chaque commit sur main, à l'adresse
https://jeu.hemicycle.workers.dev (Worker « jeu », sous-domaine de compte « hemicycle », octobre 2026) : le Worker
`worker/index.js` (configuration `wrangler.jsonc`) sert le site et l'API `/api/`, avec la base D1 « hemicycle ».
Données construites par les scripts Python de `scripts/` (bibliothèque standard uniquement), lancés par
le workflow `.github/workflows/listes.yml` (« Listes fermées et cartes »), chaque nuit à 2 h 41 UTC ou à la main, une
exécution à la fois, qui enregistre `data/` et `site/` (même après une annulation : l'enregistrement est `always()`).

## Règles du projet

- Sources officielles uniquement (Assemblée nationale : Sycomore et open data ; Sénat : data.senat.fr ;
  data.gouv.fr ; info.gouv.fr ; Insee via geo.api.gouv.fr). Wikidata seulement pour les noms d'usage, les
  portraits et quatre distinctions, toujours rattachés par identifiant officiel (Sycomore P1045, Sénat P1808) ;
  Wikipédia seulement pour l'image principale de l'article rattaché de la même façon (`portraits_wikipedia.py`) ;
  Commons seulement pour les fichiers dont la fiche dit ne représenter (P180) que cet élément (`portraits_commons.py`,
  demande de l'utilisateur d'améliorer la couverture photo, octobre 2026).
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
(Ve République et rattachements ; le jeu de données de data.gouv.fr, arrêté au gouvernement Bayrou, laisse ses
fonctions sans fin : elles sont closes la veille de l'entrée en fonction du Premier ministre suivant, comme dans
l'open data de l'Assemblée, sans quoi ses membres passaient pour « en exercice ») ;
7. `quatre_vingts.py`, `doyens.py`, `presidences.py`, `presidences_senat.py`, `distinctions.py` ;
8. `cartes.py` (version finale : score, rareté par époque, bonus des élus en exercice) ;
9. `portraits.py` (libellé français, sinon le libellé commun « mul » que Wikidata utilise désormais pour beaucoup de
personnes ; membres du Gouvernement sans mandat : libellé ou autre nom, homonymes départagés par les dates de vie
et de fonction puis par la nationalité française ; image déjà retenue gardée tant qu'elle reste valable ; garde : une réponse de Wikidata très inférieure à la précédente n'écrase rien),
`portraits_sycomore.py` (portraits officiels de Sycomore pour les députés sans portrait
Wikidata, sondés par reprise, 20 minutes par exécution), `portraits_assemblee.py` (photos officielles des députés
depuis la XIe législature, `static/tribun/<législature>/photos/<numéro PA>.jpg`, rattachement de `gouvernements_an.py` ;
187 photos à la première exécution, octobre 2026), `portraits_senat.py` (photos officielles des anciens
sénateurs sur senat.fr, adresse reconstruite avec le matricule et vérifiée ; aussi pour les cartes Sycomore des
sénateurs qui ont été députés, par `correspondances.json`), `portraits_wikipedia.py` (image principale libre de
l'article Wikipédia rattaché par P1045 ou P1808, pour les cartes sans autre portrait ; décision de l'utilisateur,
octobre 2026 ; seulement si la fiche Commons dit représenter la personne (P180), plus un filtre de mots ; une seule
image retenue à la deuxième exécution sur 550 images principales libres, le reste étant tombes, armoiries, pages de titre ; rapport des
retenus et écartés), `portraits_commons.py` (fichiers de Commons qui ne dépeignent que la personne, recherche
`haswbstatement:P180=…` par lots de 16, reprise de 10 minutes par exécution, jamais sondés d'abord, dates dans
`data/portraits_commons_sondes.json` ; nom de famille exigé dans le nom de fichier ; premier passage complet : 35
personnes sur 6 761 ont un fichier qui les dépeint, 2 portraits retenus), `villes_circonscriptions.py`, `numeros_departements.py` (numéros des départements pour la recherche de
l'ordre du jour, Code officiel géographique de l'Insee par l'API Métadonnées sans clé, départements en vigueur au 1er janvier
de chaque année depuis 1943, anciens noms compris ; écrit `site/departements.json`), `export_jeu.py` (écrit
`site/jeu.json`), puis
`node scripts/catalogue_serveur.js` (écrit `site/serveur.json`).

## Décisions de notation

- Groupe affiché sur la carte (`groupe_principal`, `cartes.py`) : groupe du mandat en cours pour un élu en
  exercice, sinon groupe où il a siégé le plus longtemps.

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
- Rythme : un paquet toutes les 30 minutes dans une réserve de dix (décision de l'utilisateur, octobre 2026, au lieu
  d'un par heure et huit ; `RECHARGE_MS`, `RESERVE_MAX`, état `reserve` et `ancre`), puis les paquets offerts. Le plafond
  n'est plus dans la contrainte de la colonne `stock` (`CHECK (stock >= 0)`) : `leverPlafondStock` (worker) a reconstruit
  une fois la table `joueurs`, à l'identique, qui portait `CHECK (stock BETWEEN 0 AND 8)`. Questions au Gouvernement (sous les paquets de la Séance) : cinq
  questions tirées des fiches (`questions`, graine déterministe), depuis 1958 seulement et une de chaque type par série
  (`TYPES_QUIZ`, demande de l'utilisateur, octobre 2026) : « Qui est-ce ? » sur un portrait (cartes de score 40 et plus,
  `SCORE_PHOTO`), « Qui est actuellement… ? » (poste sans date de fin à titulaire unique), département, « Qui a été… ? »,
  fonction (score 35 et plus, libellés de 90 signes au plus) ; mauvaises réponses du même sexe ; 2 voix par bonne réponse et 5 pour un
  sans-faute, une fois par jour de Paris (`validerQuiz`) ; le navigateur connaît les réponses, d'où le plafond
  de 15 voix par jour. Duels (demande de l'utilisateur, octobre 2026 : « servir à quelque chose » et plus accessibles) : mise
  facultative de 10 à 100 voix ou de 1 à 3 paquets offerts (`MISES_DUEL`, `MISE_VOIX_MAX`, `MISE_PAQUETS_MAX`), retenue au
  lanceur dans le lot qui crée le duel (statut `propose`) ; l'adversaire relève (`/relever`, même mise retenue, clôture
  `duel-releve`) ou refuse (mise rendue, `duel-clos`) ; le lanceur peut annuler tant que le défi n'est pas relevé. Le serveur
  garde la graine et juge chaque réponse dans l'ordre (`GET /api/duels/:id/questions` sans les réponses,
  `POST /api/duels/:id/reponse`), d'après `site/quiz-serveur.json` (`compacterQuiz`, mêmes questions que le catalogue
  complet, vérifié par le test) ; à la dixième réponse, `cloreDuel` (clôture `duel-fini`) : le gagnant emporte les deux
  mises, une égalité rend la sienne à chacun. Tâche horaire `expirerDuels` : défi ignoré trois jours remboursé (`expire`),
  duel relevé non fini au bout de trois jours clos avec les réponses données. Vingt duels en cours au plus par joueur.
  Accès : bloc Duels de la Séance (défis à relever, duels à jouer ou reprendre, formulaire avec les amis en puces et la mise),
  bouton Défier de l'onglet Amis qui y mène, formulaire prérempli.
- Doubles réduits (demande de l'utilisateur, octobre 2026 : 10 % entre le 700e et le 1 500e paquet) : une carte déjà
  possédée ou déjà sortie dans le paquet est retirée dans la même rareté avec la probabilité `RELANCE_DOUBLE` (0,9) ;
  l'élu en exercice garanti, s'il est déjà possédé, laisse la place à une carte de la même rareté parmi toutes
  (`tirerActuel` ; le millier d'élus en exercice, presque tous possédés vers le 700e paquet, faisait l'essentiel des
  doubles). Raretés inchangées, aussi au serveur (même `regles.js`). Simulation de 1 500 paquets, douze joueurs : 0,1 %,
  0,7 %, 2,8 % et 9,9 % de doubles sur les paquets 1-100, 101-300, 301-700 et 701-1 500 (avant : 3, 9, 19 et 33 %) ;
  vérifié par le test (entre 7 et 13 % du 701e au 1 500e).
- Économie : Recyclage d'un exemplaire en trop : commune 1,
  peu commune 2, rare 5, épique 15, légendaire et hors catégorie 40, mythique 100 points ; 25 points font un
  paquet. Un paquet de doubles rapporte en moyenne 21 points : le prix doit rester au-dessus, sans quoi le
  recyclage créerait des paquets sans fin (vérifié par le test). Par défaut, seules les raretés commune à
  rare sont cochées pour le recyclage : les doubles plus rares serviront aux échanges entre joueurs.
- Rareté « unique » (demande de l'utilisateur, octobre 2026) : au-dessus de toutes, pour la seule carte de Charles de
  Gaulle (`CARTES_UNIQUES`, `cartes.py` ; jusque-là hors catégorie). Ajoutée en dernier dans `RARETES` (`export_jeu.py`)
  et `ORDRE` (`regles.js`) pour ne pas décaler les indices publiés ; poids de tirage 0,004 (`POIDS`), sous celui d'une
  mythique donnée (0,4 pour 95 cartes ; vérifié par le test), soit une carte sur 25 000 environ ; dissolution 250 voix ;
  cadre tricolore et or (`.r-unique`) ; en tête de « Toutes les cartes », avant le tri par score (demande de l'utilisateur).
- Paliers (`PALIERS`) hauts et modestes pour les législatures (50, 150) et les départements (15, 40) : des
  paliers bas s'auto-entretenaient (simulation : la moitié des cartes dès le premier jour). Un test vérifie
  qu'un premier jour avec toutes les récompenses en cascade reste borné.
- Récompenses : les tâches simples paient en voix (premiers pas, 10 voix chacun ; « Remplir l'hémicycle » à 10, 25,
  50 et 100 cartes), les plus dures en paquets offerts (`PALIERS` : [seuil, quantité] ou [seuil, quantité, "voix"]).
  `reclamer` et `recompensesEnAttente` renvoient {paquets, voix}.
- Premiers pas, pour des récompenses rapides : premier membre du Gouvernement, premier député, premier sénateur,
  première femme parlementaire, premier élu en exercice, premier chef de l'État ou du Gouvernement, première
  carte de chaque rareté (rare à mythique), premier parlementaire de chaque époque (un paquet chacun) ; et
  « Remplir l'hémicycle » (10, 25, 50, 100, 250, 348, 577, 1000 cartes différentes). Bouton « Tout réclamer ».
- Objectifs : Quatre-vingts, Compagnons de la Libération, présidents de l'Assemblée, chaque législature
  (table `assemblees` de `jeu.json`), chaque département d'au moins cinq cartes. Paliers dans `PALIERS` ;
  la collection complète donne 5 paquets et a sa propre clé (`@complet`), pour ne se réclamer qu'une fois.
- Tests : `node tests/regles.test.js` (sans installation) ; `tests/api.test.js` contre un serveur local
  (`npx wrangler dev`, mode d'emploi en tête du fichier) ; parcours Playwright `tests/ui.test.js` (sans compte),
  `tests/ui-compte.test.js` (deux joueurs) et `tests/accueil.test.js` (première ouverture). Tous lancés par
  `.github/workflows/tests.yml` à chaque pull request et à chaque commit sur main (Wrangler et Playwright aux
  versions fixées, installés sur la machine de GitHub seulement) ; captures en artefact « captures ».

## Vocabulaire du jeu (références parlementaires)

Onglets : Séance (paquets du jour), Hémicycle (collection), Ordre du jour (objectifs, synthèse et rubriques
repliables ; un objectif par ligne : marque, titre, bouton « + gain » ou prochaine récompense, jauge pour ceux à compter ;
en-tête de rubrique sur une ligne, terminés/total et nombre à réclamer ; législatures et départements limités aux
huit plus avancés, `LIMITE_RUBRIQUE`, avec « Afficher les autres » ; départements cherchés par nom ou numéro, « 1 » et « 01 »
trouvant l'Ain, numéro affiché à côté du nom, `departements.json` chargé à la première ouverture), Buvette (sous-onglets Échanges : propositions en attente en fiches « Vous donnez / Vous recevez », et proposer ; Comptoir en
étals, grille de tuiles portrait, rareté, prix, vendeur, Acheter ou « Pas assez de voix », puis « Mes cartes au comptoir »
avec la tuile « Mettre une carte en vente » ;
Historique : échanges terminés, ventes et achats au comptoir, par mois, filtre Tout / Échanges / Comptoir, cartes nommées
avec miniature ; `GET /api/annonces` renvoie aussi les achats, index `annonces_acheteur`), Amis, Plus : six onglets, assez
grands pour le téléphone ; le menu Plus ouvre quatre vues, Mon siège (chiffres et vitrine en six cases, libellé du
pseudo une fois connecté), « Toutes les cartes » (catalogue complet, cartes non obtenues grisées),
Règlement (règles et sources) et Paramètres (infos du compte, déconnexion et suppression, thème sombre, clair ou comme
l'appareil gardé dans le navigateur, notifications, contact, mentions légales). Pas de pied de page. Au-delà de 1 180 px
de large, ces quatre vues sont des onglets (`onglet-large`) et « Plus » disparaît ; sur ordinateur, la barre d'onglets se
fixe en haut de l'écran une fois l'en-tête passé (`nav-flottante`, demande de l'utilisateur : changer d'onglet à tout
moment, après un paquet). Après le dernier paquet, le récapitulatif propose « Revenir en séance » et « Voir mon hémicycle ».
Hémicycle : les pastilles du haut filtrent (favoris, doubles, une rareté) et se désélectionnent au second toucher ;
le bouton « Voir mes doubles » pose le même filtre (`doubles`) ; l'échange de voix contre un paquet n'y figure pas
(Séance et encart des voix seulement, demande de l'utilisateur) ; toucher une carte l'ouvre en grand (`apercu`) avec ses exemplaires, la dissolution de ses doubles (`dissoudre`,
`POST /api/dissoudre`) ou, sans double, de la carte elle-même avec sa valeur en voix (`tout`, confirmation demandée ;
retirée de la vitrine), la vente au comptoir et « Mettre en vitrine » ou « Retirer de ma vitrine » (vitrine pleine : choix de la carte à
remplacer, qui cède sa case, demande de l'utilisateur) ; tri par défaut par rareté puis par score. Reflets des mythiques et
légendaires espacés (11 et 15 s), dégradé sans répétition pour que la carte reste nette entre deux passages.
Première ouverture (`demarrerAccueil`, étape gardée dans `hemicycle-accueil`) : fenêtre d'accueil (créer un compte,
recommandé ; ouvrir ses cartes dans le navigateur ; « J'ai déjà un compte ») ; après le compte, tutoriel
d'installation selon l'appareil (iPhone : bouton Partager puis « Sur l'écran d'accueil » ; Android et ordinateur :
invitation `beforeinstallprompt` ou menu du navigateur) ; puis visite guidée (`ETAPES_VISITE`) qui éclaire chaque
élément et attend certains gestes (ouvrir le paquet, retourner la carte, finir le paquet). Au récapitulatif du deuxième paquet
ouvert sur l'appareil (`paquetTermine`, compteur `hemicycle-paquets-ouverts`), une fois (`hemicycle-preferences`) et
jamais pendant la visite, la fenêtre `preferences` propose le thème et l'activation des notifications (demande de
l'utilisateur). Les tests du navigateur
posent `hemicycle-accueil = fait` pour passer l'accueil. Pendant la visite, rien ne défile (`recentrer` suspendu) :
la classe `presentation` de `html` resserre l'interface le temps de la visite seulement (séance et découverte
sans défilement sur 390 × 844) ; hors visite, les tailles habituelles, jugées plus lisibles par l'utilisateur.
Portraits : vignettes Wikimedia en largeur standard (330 px ; 320 px est refusé, 400), connexions ouvertes d'avance,
portraits Wikimedia et Sénat demandés en CORS et gardés par le service de travail (cache `hemicycle-portraits`,
800 au plus) ; ceux de l'Assemblée, sans CORS, restent au cache du navigateur (une réponse opaque gonflerait le
quota et risquerait l'effacement des données du site, collection locale comprise). Un toucher sur les voix ouvre un encart qui explique leur usage. Choix d'une carte
(vitrine, vente, lots d'un échange) : fenêtre `choisirCarte` en miniatures, favoris d'abord ; à la vente, toute la
collection y figure, les cartes verrouillées grisées avec leur raison. Buvette et Ordre du jour allégés : pas de
paragraphes d'introduction, historique et objectifs déjà reçus repliés. Pendant la découverte d'un
paquet et son récapitulatif, les questions au Gouvernement sont masquées.
Classement des joueurs retiré à la demande de l'utilisateur. Dissoudre des doubles (recyclage) rapporte des voix, la
monnaie du jeu (« acheter des voix est parfaitement réglementaire ») ; à la buvette, les joueurs échangent
des cartes et se les vendent au comptoir. Pas plus de termes : compte, connexion et échanges gardent des mots
simples (« prendre séance » et consorts ont été écartés). Les noms de code (fonctions, API, base, champ
`points`) gardent les termes techniques. Les voix restent visibles en haut à droite. Pendant la découverte d'un
paquet, toucher la carte la retourne (plus de bouton Verso) ; « Précédente » et « Suivante » naviguent ; l'étoile
la met en favori (`favoris` de l'état, 300 au plus, `basculerFavori` ; colonne `favoris` et `POST /api/favori` côté
serveur), filtre « Mes favoris » dans l'Hémicycle. Pas de zoom au double toucher
(`touch-action: manipulation`).

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
  10 ms de calcul du plan gratuit. Pas de récupération de mot de passe faute d'envoi d'e-mails. Changement dans Paramètres
  (`POST /api/mot-de-passe`, ancien vérifié, 10 essais par quart d'heure, sel neuf, autres sessions fermées). En cas
  d'oubli, réinitialisation à la main par l'éditeur dans la console D1 (nouveau sel et empreinte de la preuve d'un
  mot de passe provisoire, sessions et tentatives du joueur effacées), après s'être assuré de l'identité du joueur.
- Reprise de la collection locale à l'inscription, une fois : décision de l'utilisateur (octobre 2026), les cartes
  reprises sont des cartes ordinaires, vendables et échangeables, alors que le serveur ne peut pas vérifier une
  collection locale (risque accepté : un joueur peut s'écrire des cartes dans son navigateur avant l'inscription).
  Colonne `importes` gardée à 0 (migration unique `importes-liberes`, table `reglages`) ; paliers déjà atteints
  marqués réclamés ; voix reprises aussi (demande de l'utilisateur, octobre 2026), 1 000 au plus (`MAX_VOIX_REPRISES`) ;
  paquets offerts non repris. Une carte en vente est « réservée », verrouillée.
- Monnaie du marché : les voix (champ `points`), gagnées en dissolvant des doubles. Pas d'argent réel.
- Lignes lues (limite gratuite de D1 : 5 millions par jour) : `appliquer` garde l'état écrit (`env.etatEcrit`), la
  réponse ne relit donc pas la collection (mesure, joueur de 300 cartes : 745 lignes par paquet avant, 372 après) ;
  pastilles d'attente relues seulement quand la page est visible. Mesurer : `wrangler dev --var MESURE_LECTURES:1`,
  en-tête `x-lignes-lues` de chaque réponse.
- Catalogue du serveur : membres des objectifs codés en plages et décodés à la demande ; le catalogue n'est
  chargé que par les routes qui en ont besoin (environ 12 ms au premier chargement, en cache ensuite).
- D1 accepte au plus 100 paramètres par requête (le serveur local n'a pas cette limite) : insertions groupées par
  `insertionsGroupees`. L'inscription avec reprise part en un seul lot (transaction) ; un compte resté vide
  (aucune possession, aucun journal) est repris par une nouvelle inscription avec le même mot de passe.
- Concurrence des opérations des règles : version du joueur incrémentée dans le même lot ; une insertion dans la
  table `garde` (contrainte `ok = 0`) n'a lieu que si la version a changé (`changes() = 0`) et annule tout.
- Amis (table `amis`, une ligne par sens) : `GET /api/amis`, `POST /api/amis/(demander|accepter|retirer)` ; une demande
  croisée vaut acceptation, retirer efface les deux sens (refus, annulation, fin d'amitié) ; `GET /api/amis` renvoie
  aussi `vitrines` (trois premières cartes de la vitrine de chaque ami, lues dans la même ligne, sans lecture de plus).
  Onglet Amis : ajout en une ligne, fiche par ami (pastille de couleur tirée du pseudo, aperçu de la vitrine qui ouvre
  le profil, Échanger, Défier, Retirer en lien discret), demandes reçues mises en avant ; « Vous connaissez peut-être » :
  `suggestions` de `GET /api/amis`, amis d'amis sans lien avec le joueur, les plus d'amis en commun d'abord (6 au plus).
  « Qui a cette carte ? » (demande de l'utilisateur, octobre 2026) : champ de l'onglet Amis, six cartes proposées par nom,
  puis les amis qui l'ont (`GET /api/amis/carte?carte=`, exemplaires et libres) avec « Lui demander », qui ouvre l'échange
  avec la carte déjà demandée (`proposerEchangeA(pseudo, carte)`) ; même liste sous la grande carte (« Chez vos amis »).
  Identifiants de carte acceptés par ces routes : `ID_CARTE` (tirets compris, cartes « G- » du Gouvernement).
- Notifications (Web Push, RFC 8030 et 8292) : poussée sans contenu, signée VAPID (ES256, clés créées à la première
  demande et gardées dans `reglages`) ; le texte attend dans `notifications` et le service de travail le lit
  (`GET /api/notifications`, qui le supprime). Abonnements par appareil (`abonnements`, services de poussée connus
  seulement), préférences « buvette » (échanges, amis, duels, ventes) et « réserve ». Déclencheur planifié horaire
  (`triggers.crons` de `wrangler.jsonc`, `scheduled`) : réserve pleine, une fois par remplissage (`reserve_vue`),
  seulement si la moitié au moins de la réserve s'est remplie depuis le dernier paquet (`RESERVE_MIN_AVIS` ; un paquet
  ouvert d'une réserve pleine la remplissait en une heure, d'où une notification presque à chaque paquet) ; un
  message identique non lu est remplacé ; testé par `api.test.js` (`wrangler dev --test-scheduled`).
  Signature vérifiée contre FCM (jeton juste : 410 pour un abonnement inconnu ; jeton faux : 403). Sur iPhone,
  seulement dans l'application installée sur l'écran d'accueil.
- Codes (demande de l'utilisateur, octobre 2026) : saisis dans Mon siège (`POST /api/code`, 10 essais par quart d'heure,
  casse indifférente), créés par l'éditeur dans la console D1, table `codes` (`voix`, `paquets` offerts, `cartes` en
  liste JSON d'identifiants, `limite` d'utilisations et `fin` facultatives, « 2026-12-31 » valant jusqu'au soir UTC) ;
  `codes_utilises` (clé code + joueur) : une fois par compte. Exemple :
  `INSERT INTO codes (code, voix, paquets, cartes, limite, fin) VALUES ('NOEL2026', 50, 2, '["4567"]', 100, '2026-12-31');`
  Méthode retenue par l'utilisateur : il donne les codes voulus et leurs récompenses, Claude les ajoute dans
  `worker/codes.js` (empreinte SHA-256 du code en minuscules, `node scripts/code.js "CODE"`, jamais le code en clair, ni
  dans le dépôt ni dans les messages de commit ou de PR ; note sur l'usage du code), puis PR et fusion : le code marche
  dès le déploiement, recopié dans D1 à la première saisie (récompenses et limites suivent ensuite le fichier). Tests :
  `--var CODE_ESSAI:1` du Worker local ajoute le code d'essai « essai-depot ».
- Détenteurs (demande de l'utilisateur, octobre 2026) : sous la grande carte (`apercu`, Hémicycle et « Toutes les cartes »),
  nombre de comptes qui en ont au moins un exemplaire, sans dire lesquels (`GET /api/detenteurs?carte=`, sans connexion,
  index `possessions_carte`, cache de dix minutes) ; une carte cédée sort de la collection, les objectifs déjà
  réclamés restent acquis, et elle n'est pas grisée dans « Toutes les cartes » (demande de l'utilisateur) : `deja` de
  l'état, cartes dont la ligne de possession est à zéro (jamais supprimée), lue avec les autres par `chargerEtat`.
- Migrations uniques : `MIGRATIONS` (worker), notées dans `reglages`.
- Colonnes ajoutées après la mise en service : déclarées dans `COLONNES` (worker), ajoutées à la volée.
- Vitrine (six cases, chacune remplie ou vidée à part, enregistrée aussitôt ; ordre changé par glisser-déposer à la souris
  ou au doigt, événements de pointeur, `glisserVitrine`, `touch-action: none` sur les cases pleines), profil, prix du comptoir
  (dernières ventes, médiane par rareté), compteur d'attente (échanges reçus, demandes d'ami, duels à jouer), suppression du
  compte, formulaire de contact (table `messages`, effacée après un an) ; signalement de pseudo retiré à la demande de
  l'utilisateur (octobre 2026 ; table `signalements` gardée pour les lignes déjà écrites, effacées avec le compte).
  Modération des pseudos : `MOTS_INTERDITS` (cherchés dans le pseudo) et `NOMS_RESERVES` (pseudo entier).
  Lire les messages : console D1 du tableau de bord Cloudflare.
- Site : application installable (`manifest.webmanifest`, `sw.js` réseau d'abord, copie hors connexion ; icônes
  écrites par `scripts/icone.py` : éventail de trois cartes bleue, blanche et rouge sur fond de marbre, choisi par
  l'utilisateur, avec une version « maskable » réduite pour la zone sûre d'Android ; changer `CACHE` dans `sw.js`
  à chaque changement d'icône ; l'application installée, gardée en mémoire par iOS, compare au retour au premier plan
  la page en ligne à celle du démarrage, au plus toutes les dix minutes, et se recharge si elle a changé, hors
  découverte d'un paquet, visite guidée ou saisie),
  polices servies par le site (`site/polices/`, licence OFL), page `mentions.html` (mentions légales,
  conditions d'utilisation, dont l'interdiction de vendre cartes, voix ou comptes contre de l'argent hors du jeu,
  confidentialité ; date de la version des sources, Licence Ouverte 2.0, lue dans `maj.json`, écrit par `export_jeu.py`,
  aussi dans le champ `maj` de `jeu.json` et affichée dans le Règlement). `jeu.json` pèse 6,5 Mo mais 1 Mo compressé par Cloudflare.
- Limites connues : un joueur peut ouvrir plusieurs comptes et faire passer leurs cartes vers un seul
  (inscriptions limitées à 100 par heure et par adresse IP, connexions à 300 par quart d'heure et par adresse, pour ne
  pas gêner les connexions partagées ; 10 essais par quart d'heure et par pseudo) ; pas de modération des pseudos.

## Prochaines tâches

1. Application en service. À confirmer par l'utilisateur : l'éditeur reste anonyme dans `mentions.html`
   (article 1-1 de la loi du 21 juin 2004, texte officiel non consulté, Légifrance refusant les requêtes
   automatiques), ce qui suppose que Cloudflare connaisse son identité. Écarté pour l'instant : adresse
   e-mail vérifiée (récupération du mot de passe, frein aux comptes multiples).
2. Portraits : 6 600 cartes sans portrait, surtout avant 1870 (un tiers de couverture pour la Révolution et les
   monarchies constitutionnelles) ; Wikidata, Sycomore, Sénat, Assemblée, Wikipédia et Commons (P180) épuisés.
   Piste non retenue : catégorie Commons de la personne (Wikidata P373), 396 cartes sans portrait, surtout des
   signatures numérisées des Archives nationales.
3. Lacunes connues, faute de source officielle structurée : sénateurs de la IIIe République et du Conseil
   de la République (1946-1948), gouvernements antérieurs à 1944, villes des circonscriptions avant 2012,
   fonctions au sein de l'Assemblée avant juin 2002 (seuls les comptes rendus de séance en PDF les portent ;
   leur lecture lèverait la règle de symétrie).
