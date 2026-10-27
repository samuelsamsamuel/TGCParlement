#!/usr/bin/env node
/* Catalogue du serveur : site/serveur.json, tiré de site/jeu.json par les règles du jeu (site/regles.js).

Le serveur (worker/index.js) juge les tirages, le recyclage et les objectifs. Il lui faut les cartes (identifiant,
rareté, en exercice, score) et la liste des objectifs, calculée ici par le même code que dans le navigateur.
Le fichier fait environ 600 Ko et s'analyse en quelques millisecondes, là où jeu.json en demanderait plus de cent.
Écrit aussi site/quiz-serveur.json (environ 450 Ko) : de quoi fabriquer les questions des duels côté serveur.
À lancer après export_jeu.py : node scripts/catalogue_serveur.js
*/
const fs = require("fs"), path = require("path");
const Regles = require("../site/regles.js");
const racine = path.join(__dirname, "..");
const jeu = JSON.parse(fs.readFileSync(path.join(racine, "site", "jeu.json"), "utf-8"));
const cat = Regles.catalogue(Regles.cartesDeJeu(jeu), jeu.assemblees || []);
const sortie = Regles.compacter(cat);
fs.writeFileSync(path.join(racine, "site", "serveur.json"), JSON.stringify(sortie));
// Données des questions des duels, jugés par le serveur (questions sans réponses envoyées au navigateur)
fs.writeFileSync(path.join(racine, "site", "quiz-serveur.json"), JSON.stringify(Regles.compacterQuiz(cat)));
console.log(`Catalogue du serveur : ${sortie.cartes.length} cartes, ${sortie.objectifs.length} objectifs, `
  + `${Math.round(fs.statSync(path.join(racine, "site", "serveur.json")).size / 1024)} Ko`);
