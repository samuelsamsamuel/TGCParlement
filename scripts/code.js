#!/usr/bin/env node
// Empreinte d'un code pour worker/codes.js : SHA-256 du code en minuscules, sans espaces autour
//   node scripts/code.js "NOEL2026"
const code = process.argv[2];
if (!code) { console.error('Usage : node scripts/code.js "CODE"'); process.exit(1); }
console.log(require("crypto").createHash("sha256").update(code.normalize("NFC").trim().toLowerCase()).digest("hex"));
