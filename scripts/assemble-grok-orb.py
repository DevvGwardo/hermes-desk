#!/usr/bin/env python3
"""Assemble src/lib/grok-orb/core.js — the verbatim Grok bot mark engine.

Pulls the ACTUAL beautified/extracted source from docs/grok-extracted/ and
concatenates it in dependency order into one self-contained module that
exports the real `vzt` React component (plus lzt + all data).

Order (must match JS hoisting needs — the source is one big IIFE originally):
  1. constants + core helpers (from the raw bundle region, re-extracted cleanly)
  2. shape generators + al + Y3 (shape-data.js — already the clean region)
  3. lzt particle system (beautified)
  4. vzt component (beautified) — needs `T` (React) and `h` (jsx-runtime)
"""

import re
from pathlib import Path

SRC = Path(__file__).parent.parent / 'docs' / 'grok-extracted'
OUT = Path(__file__).parent.parent / 'src' / 'lib' / 'grok-orb' / 'core.js'

bundle = open(SRC.parent / 'grok-asar-extract' / 'dist' / 'renderer' / 'assets' / 'index-x-YCiXos.js').read()

def region(name, start_pat, end_pat, start_off=0):
    idx = bundle.find(start_pat, start_off)
    if idx < 0:
        raise SystemExit(f"start not found: {start_pat}")
    end = bundle.find(end_pat, idx + 1)
    if end < 0:
        raise SystemExit(f"end not found: {end_pat} (from {start_pat})")
    return bundle[idx:end]

parts = []

# ── 1. Constants + core helpers ───────────────────────────────────────────
# $e (center), Kse, Ed, PIe, Yt, ns, M3, fu, ipe, uve, azt, ape, _ae, xoe,
# Nc, Wl, rzt, izt, Oj, _Ft, u2e, Hr, gZ, kX (path builder), pot, nie,
# Sqe, MFt, Eqe, OFt, LFt, BFt, RFt, JFt, DFt, qFt, FFt, jFt, zFt, $Ft,
# ZFt, Nqe, UFt, GFt, HFt, WFt, Iqe, PTe, hot, fve, wzt, Mae, Oqe, pzt,
# gzt, yzt, kzt, AFt, PFt, ATe, IFt, nzt, szt, QFt, B0e, ezt, rpe, Aqe,
# tzt, dzt, uzt, Mqe, mzt, fzt, hzt, mve, CFt, Y3, al, sl, lzt, vzt, czt,
# kq, yot, dve, _qe, Sot, Lqe, Dd

# Grab the region from the start of the mark engine through the component.
# The engine starts around offset 926400 (AFt/$e region) and the component
# vzt ends right before the next top-level export.
start = bundle.find('$e=114.2705')
# The full engine + component: from $e down to the closing of vzt.
# vzt ends right before `const` czt? No — czt is INSIDE. The component ends
# before the next top-level statement after vzt. From earlier extraction,
# vzt full component was 34,860 chars starting at 949,668.
# We take from $e start to the vzt end boundary.
vzt_start = bundle.find('vzt=T.forwardRef')
# find where vzt ends: the render ends with `})` at depth 0 then `;` then the
# next top-level (usually `const` or `export` or another component)
vzt_region = bundle[vzt_start:]
# Find the close: pattern `})` followed by `;` then newline or `const`
# From the earlier extraction, the component ended at 984527 (depth-0 close)
# and after that came `,const czt` (a comma-separated const chain!).
# So vzt is part of a comma chain: `...,vzt=T.forwardRef(...),const czt=...`
# We need vzt plus everything up to the next `;` at top level after it.

# Simpler robust approach: find the end of vzt's expression using the
# earlier computed boundary (vzt at 949668, depth-0 close at 984527).
end_idx = 984527 + 1  # include the closing paren
# verify: look at what follows
after = bundle[end_idx:end_idx+80]
print(f"after vzt: {after!r}")

# ── Assemble ──────────────────────────────────────────────────────────────
# header: react + jsx-runtime imports (the component references T and h)
header = '''/* eslint-disable */
/**
 * Grok Bot mark engine — VERBATIM port of the xAI Grok Bot app mascot
 * (component `vzt` + particle system `lzt` + shape machinery + data tables).
 * Extracted from Grok Bot.app app.asar (v0.16.0), beautified, assembled here.
 * This is the real engine, not a reimplementation.
 */
import * as T from "react";
import { jsx as h, jsxs as hjsxs, Fragment as hFragment } from "react/jsx-runtime";

'''

# Actually the beautified code uses `h.jsxs(...)` and `h.jsx(...)` — check
vzt = open(SRC / 'vzt-full-component.beautified.js').read()
uses_hjsxs = 'h.jsxs(' in vzt
uses_jsx = 'h.jsx(' in vzt
print(f"component uses h.jsxs: {uses_hjsxs}, h.jsx: {uses_jsx}")
# The beautified output renders `h.jsxs("svg", {...})` — so h must have .jsx/.jsxs.
# jsx-runtime exports jsx/jsxs directly; make h = { jsx, jsxs }.
if uses_hjsxs or uses_jsx:
    header = '''/* eslint-disable */
/**
 * Grok Bot mark engine — VERBATIM port of the xAI Grok Bot app mascot
 * (component `vzt` + particle system `lzt` + shape machinery + data tables).
 * Extracted from Grok Bot.app app.asar (v0.16.0), beautified, assembled here.
 * This is the real engine, not a reimplementation.
 */
import * as T from "react";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
const h = { jsx: _jsx, jsxs: _jsxs, Fragment: _Fragment };

'''

core_parts = []
core_parts.append(header)

# 1. core helpers region — from $e through the al/CFt/Y3 definitions.
# shape-data.js already contains Y3+al+CFt+morph data cleanly. Use it but it
# starts at `Y3=` — it needs the earlier helpers. Let's assemble from the
# bundle region instead: $e .. start of Y3
y3_start = bundle.find('Y3=')
core_region = bundle[start:y3_start]
core_parts.append("// ── constants + core helpers (verbatim bundle region) ──\n")
core_parts.append(core_region + "\n")

# 2. Y3 + al + shape data (shape-data.js = Y3 .. lzt region, already clean)
shape_data = open(SRC / 'shape-data.js').read()
core_parts.append("// ── Y3 eye poses + al shapes + CFt (verbatim) ──\n")
core_parts.append(shape_data + "\n")

# 3. lzt particle system (beautified, self-contained given helpers above)
lzt = open(SRC / 'lzt-particle-system.beautified.js').read()
core_parts.append("// ── lzt particle system (verbatim) ──\n")
core_parts.append(lzt + "\n")

# 4. vzt component (beautified)
core_parts.append("// ── vzt mark component (verbatim) ──\n")
core_parts.append(vzt + "\n")

# 5. export
core_parts.append("export { vzt, lzt, al, Y3, rpe, Aqe, tzt, dzt, uzt, Oqe, Mae, CFt };\n")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("\n".join(core_parts))
print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
