/* Codes du jeu tenus dans le dépôt (décision de l'utilisateur, octobre 2026 : il donne les codes voulus, ils sont
   ajoutés ici et mis en ligne avec le Worker, sans passer par la console D1).

   Le texte du code n'est pas écrit ici, seulement son empreinte : SHA-256 du code en minuscules, sans espaces autour
   (node scripts/code.js "MONCODE"). Champs : voix, paquets (offerts), cartes (identifiants : numéro Sycomore, ou
   « S » et matricule pour un sénateur jamais député), limite (nombre de comptes, null pour aucune), fin (dernier jour
   valable, « 2026-12-31 », null pour aucune), choix (facultatif : {choix, raretes}, une carte à garder parmi `choix` de ces
   raretés, comme les lots de la série du Gouvernement), note (à quoi sert le code ; ne jamais y recopier le code).

   À la première saisie, le code est recopié dans la table codes de D1, qui compte les utilisations ; ses récompenses
   et ses limites suivent ensuite ce fichier. Les codes créés à la main dans la console D1 marchent aussi. */
export const CODES = [
  // Une carte rare ou mieux à choisir parmi trois, comme le palier 3 de la série du Gouvernement ; offert à une joueuse
  // (octobre 2026), une seule utilisation
  {empreinte: "d46c26589a428afb9f64781f850edd1d024f60c60708e2a96280ec5fff511db4", voix: 0, paquets: 0, cartes: [],
   choix: {choix: 3, raretes: ["rare", "epique", "legendaire", "mythique"]}, limite: 1, fin: "2026-12-31",
   note: "carte rare ou mieux à choisir, cadeau ponctuel"},
];
