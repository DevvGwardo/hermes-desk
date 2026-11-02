"""Symmetry + transparency check for orb captures. Prints JSON."""
import json, sys
from PIL import Image
from collections import deque

path = sys.argv[1]
im = Image.open(path).convert("RGBA")
w, h = im.size
px = im.load()

corners = [im.getpixel(p) for p in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]]
transparent = all(c[3] == 0 for c in corners)
center = im.getpixel((w // 2, h // 2))

# Dark navy eye pixels: very dark, blue-dominant-ish (eye ink #1a3d6b range,
# rendered dark). Orb fills are light blue (all channels >140).
dark = set()
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a > 128 and r < 90 and g < 120 and b < 170:
            dark.add((x, y))

# Connected blobs (4-connectivity)
blobs = []
seen = set()
for seed in dark:
    if seed in seen:
        continue
    q = deque([seed]); seen.add(seed); xs = []; ys = []
    while q:
        x, y = q.popleft(); xs.append(x); ys.append(y)
        for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if (nx, ny) in dark and (nx, ny) not in seen:
                seen.add((nx, ny)); q.append((nx, ny))
    blobs.append({"n": len(xs),
                  "cx": sum(xs) / len(xs), "cy": sum(ys) / len(ys)})

# Keep substantial blobs only (filter AA specks: >=40px at 1024)
big = [b for b in blobs if b["n"] >= 40]
big.sort(key=lambda b: b["cx"])
sym = None
if len(big) == 2:
    (x1, y1), (x2, y2) = (big[0]["cx"], big[0]["cy"]), (big[1]["cx"], big[1]["cy"])
    mirror_err = abs(x1 + x2 - w)
    level_err = abs(y1 - y2)
    sym = {"mirror_err": round(mirror_err, 2), "level_err": round(level_err, 2),
           "pass": bool(mirror_err < 4 and level_err < 4),
           "c1": [round(x1,1), round(y1,1)], "c2": [round(x2,1), round(y2,1)],
           "sizes": [big[0]["n"], big[1]["n"]]}

print(json.dumps({
    "size": [w, h],
    "corners_transparent": transparent,
    "corners": [list(c) for c in corners],
    "center": list(center),
    "n_dark": len(dark),
    "n_blobs": len(big),
    "sym": sym,
}))
