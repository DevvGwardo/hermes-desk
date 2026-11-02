"""Composite orb raw (1024 RGBA, transparent) over opaque #9ecdff square
tile (corners must stay tile-opaque per brand tests) and emit all surfaces.
Usage: python3 composite.py [raw] [repo_root]"""
import os, sys
from PIL import Image

TILE = (158, 205, 255, 255)
raw_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join("out", "orb_raw.png")
repo = sys.argv[2] if len(sys.argv) > 2 else "/Users/devgwardo/hermes-deploy"

raw = Image.open(raw_path).convert("RGBA")
assert raw.size == (1024, 1024), raw.size
tile = Image.new("RGBA", (1024, 1024), TILE)
master = Image.alpha_composite(tile, raw).convert("RGB")

def save(img, rel, size=None):
    if size: img = img.resize((size, size), Image.LANCZOS)
    p = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    print(rel, img.size, "unique=", len(set(img.getdata())))

save(master, "public/logo.png")
save(master, "public/android-chrome-512x512.png", 512)
save(master, "src/app/icon.png", 512)
save(master, "src/app/nub/icon.png", 512)
save(master, "src/app/nub/waitlist/icon.png", 512)
save(master, "public/android-chrome-192x192.png", 192)
save(master, "src/app/apple-icon.png", 180)
fav = master.resize((32, 32), Image.LANCZOS)
fp = os.path.join(repo, "src/app/favicon.ico")
fav.save(fp, sizes=[(16, 16), (32, 32)])
print("src/app/favicon.ico", os.path.getsize(fp), "bytes")
im = Image.open(raw_path).convert("RGBA")
print("raw unique=", len(set(im.getdata())), "corners=", [im.getpixel(p) for p in [(2,2),(1021,2),(2,1021),(1021,1021)]], "center=", im.getpixel((512,512)))
