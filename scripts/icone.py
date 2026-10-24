# Icône de l'application : éventail de trois cartes bleue, blanche et rouge, bordées d'or, sur fond de marbre
# (choix de l'utilisateur, octobre 2026). Bleu France et rouge Marianne de la Marque de l'État.
# Deux versions : « any » (cartes pleine taille) et « maskable » (réduite à 76 % pour rester entière dans la
# zone sûre d'Android, un cercle de 80 % du côté).
import math, struct, zlib
BLEU, BLANC, ROUGE = (0, 0, 145), (255, 255, 255), (225, 0, 15)
OR, VELOURS, MARBRE = (201, 162, 74), (92, 16, 32), (239, 233, 223)
def dans_rect_arrondi(x, y, cx, cy, l, h, r, angle=0):
    a = math.radians(angle); dx, dy = x - cx, y - cy
    x, y = dx * math.cos(a) + dy * math.sin(a), -dx * math.sin(a) + dy * math.cos(a)
    qx, qy = abs(x) - l / 2 + r, abs(y) - h / 2 + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r <= 0
def dans_h(x, y, cx, cy, t):
    w, e = t * 0.78, t * 0.22
    montant = abs(y - cy) <= t / 2 and (abs(x - (cx - w / 2 + e / 2)) <= e / 2 or abs(x - (cx + w / 2 - e / 2)) <= e / 2)
    return montant or (abs(y - cy) <= e / 2 and abs(x - cx) <= w / 2)
def pixel(x, y, echelle=1.0):
    # coordonnées d'une icône de 512 px, ramenées vers le centre pour la version réduite
    x, y = 256 + (x - 256) / echelle, 256 + (y - 256) / echelle
    couleur = MARBRE
    for angle, ox, oy, carte in [(-17, -96, 18, BLEU), (17, 96, 18, ROUGE), (0, 0, 0, BLANC)]:
        if dans_rect_arrondi(x, y, 256 + ox, 262 + oy, 226, 318, 24, angle):
            couleur = OR if not dans_rect_arrondi(x, y, 256 + ox, 262 + oy, 202, 294, 16, angle) else carte
            if carte == BLANC and couleur == BLANC and dans_h(x, y, 256, 262, 128):
                couleur = VELOURS
    return couleur
def png(taille, chemin, echelle=1.0):
    k, lignes = 512 / taille, bytearray()
    for j in range(taille):
        lignes.append(0)
        for i in range(taille):
            acc = [0, 0, 0]
            for a in range(4):
                for b in range(4):
                    c = pixel((i + (a + .5) / 4) * k, (j + (b + .5) / 4) * k, echelle)
                    for n in range(3): acc[n] += c[n]
            lignes += bytes(round(v / 16) for v in acc)
    bloc = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(chemin, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + bloc(b"IHDR", struct.pack(">IIBBBBB", taille, taille, 8, 2, 0, 0, 0))
                + bloc(b"IDAT", zlib.compress(bytes(lignes), 9)) + bloc(b"IEND", b""))
png(192, "site/icone-192.png"); png(512, "site/icone-512.png"); png(512, "site/icone-maskable-512.png", 0.76)
