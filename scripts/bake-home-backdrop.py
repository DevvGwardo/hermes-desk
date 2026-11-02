#!/usr/bin/env python3
"""Bake the Home page backdrop: Flint's coastal panorama re-graded into Hermes colours.

Usage: python3 scripts/bake-home-backdrop.py [source.jpg] [out.jpg]
Default source: the Flint project's assets/welcome-coast.jpg.

Grade: a luminance gradient map onto the Hermes Teal dashboard ramp (#041c1c ground,
#ffe6cb cream highlights), then the source's warm light (sunset band, lighthouse lamp)
is kept as Hermes gold/bronze (#FFD700 / #FFBF00 / #CD7F32) instead of turning cream.
The fade into the page is CSS, so the image stays reusable.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/Volumes/T7 Shield/mac-offload/Projects/flint/assets/welcome-coast.jpg')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'src/assets/home/hermes-coast.jpg'

# Luminance → colour stops (Hermes Teal ramp: deep teal ground up to dashboard cream).
STOPS = [
    (0.00, (2, 15, 16)),
    (0.20, (5, 34, 34)),
    (0.42, (14, 70, 68)),
    (0.66, (78, 136, 128)),
    (0.86, (214, 205, 176)),
    (1.00, (255, 238, 210)),
]
BRONZE, AMBER, GOLD = np.array((205, 127, 50)), np.array((255, 191, 0)), np.array((255, 215, 0))


def gradient_map(lum: np.ndarray) -> np.ndarray:
    xs = [s[0] for s in STOPS]
    return np.stack([np.interp(lum, xs, [s[1][c] for s in STOPS]) for c in range(3)], axis=-1)


def main() -> None:
    src = Image.open(SOURCE).convert('RGB')
    rgb = np.asarray(src).astype(np.float32)
    lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]) / 255.0
    lo, hi = np.percentile(lum, 1), np.percentile(lum, 99.7)
    lum = np.clip((lum - lo) / max(hi - lo, 1e-6), 0, 1) ** 0.92
    out = gradient_map(lum)

    # Warm light in the source (red well above blue) becomes Hermes gold, graded by brightness.
    warmth = np.clip((rgb[..., 0] - rgb[..., 2] - 2) / 30.0, 0, 1)
    warmth = np.asarray(Image.fromarray((warmth * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))) / 255.0
    t = lum[..., None]
    gold = np.where(t < 0.5, BRONZE + (AMBER - BRONZE) * (t / 0.5), AMBER + (GOLD - AMBER) * ((t - 0.5) / 0.5))
    m = (warmth ** 0.8)[..., None] * 0.9
    out = out * (1 - m) + gold * m

    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(OUT, 'JPEG', quality=82, optimize=True, progressive=True)
    print(f'{OUT} {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
