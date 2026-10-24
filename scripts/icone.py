# Icône de l'application : fond rouge velours, médaille dorée, « H » sombre et bande bleu-blanc-rouge
import struct, sys, zlib
FOND, OR, ANNEAU, ENCRE = (112,22,40), (201,162,74), (230,210,154), (52,5,16)
BLEU, BLANC, ROUGE = (0,0,145), (255,255,255), (225,0,15)   # couleurs de la Marque de l'État
def pixel(x, y):
    # coordonnées ramenées à une icône de 512 px ; suréchantillonnage 4×4 pour lisser les bords
    d2 = (x-256)**2 + (y-256)**2
    if d2 > 206**2: return FOND
    if d2 > 190**2: return ANNEAU
    if 330 <= y <= 382 and 120 <= x <= 392:
        if y < 334 or y > 378: return ANNEAU
        return BLEU if x < 211 else BLANC if x < 301 else ROUGE
    if 118 <= y <= 302 and (166 <= x <= 210 or 302 <= x <= 346 or (210 < x < 302 and 189 <= y <= 229)): return ENCRE
    return OR
def png(taille, chemin):
    k, lignes = 512 / taille, bytearray()
    for j in range(taille):
        lignes.append(0)
        for i in range(taille):
            acc = [0, 0, 0]
            for a in range(4):
                for b in range(4):
                    c = pixel((i + (a + .5) / 4) * k, (j + (b + .5) / 4) * k)
                    for n in range(3): acc[n] += c[n]
            lignes += bytes(round(v / 16) for v in acc)
    bloc = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(chemin, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + bloc(b"IHDR", struct.pack(">IIBBBBB", taille, taille, 8, 2, 0, 0, 0))
                + bloc(b"IDAT", zlib.compress(bytes(lignes), 9)) + bloc(b"IEND", b""))
png(192, "site/icone-192.png"); png(512, "site/icone-512.png")
