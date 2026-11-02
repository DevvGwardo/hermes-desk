# Gates: harden overlay-repair.py to self-upgrade overlay modules

Scope: make `templates/overlay-repair.py` in `/Users/devgwardo/hermes-deploy` re-drop
`run_buffer.py` + `dashboard_runs.py` from embedded canonical content on every
gateway restart (mirroring the existing `ensure_voice_vad()` pattern), so a stale
VM self-heals without an operator running `install-runs-overlay.ts`. No behavior
change when files are already current.

- [x] G1: overlay-repair.py embeds canonical run_buffer.py + dashboard_runs.py (base64) and exposes an ensure function that rewrites on drift
  CHECK: grep -c "RUN_BUFFER_B64\|DASHBOARD_RUNS_B64\|def ensure_overlay_module" /Users/devgwardo/hermes-deploy/templates/overlay-repair.py
  EXPECT: /^3$|^[4-9]$/
  EVIDENCE: 5 (2 B64 constants + 1 def + 2 call sites)

- [x] G2: main() calls the module-ensure BEFORE apply_all() so DR-01/DR-02 see the modules on the same run (fixes the "na" skip)
  CHECK: awk '/ensure_overlay_module|ensure_voice_vad/{e=NR} /apply_all\(\)/{a=NR} END{print (e<a)?"ORDER_OK":"ORDER_BAD"}' /Users/devgwardo/hermes-deploy/templates/overlay-repair.py
  EXPECT: /ORDER_OK/
  EVIDENCE: ORDER_OK (ensure_overlay_module/voice_vad lines precede apply_all)

- [x] G3: the repair script is syntactically valid Python
  CHECK: python3 -m py_compile /Users/devgwardo/hermes-deploy/templates/overlay-repair.py && echo COMPILE_OK
  EXPECT: /COMPILE_OK/
  EVIDENCE: COMPILE_OK (python3 3.14.7, after backup-resilience fix)

- [x] G4: local harness proves self-heal — run the script against a temp tree with a stale/missing module; it writes the canonical content and reports changed; a second run reports up-to-date (idempotent)
  CHECK: node /tmp/overlay-repair-harness.mjs && tail -3 /tmp/overlay-repair-harness.out
  EXPECT: /PASS/
  EVIDENCE: HARNESS PASS 6/6 — stale healed, missing healed, idempotent, corrupt fails closed, bad-syntax rejected, ordering

- [x] G5: lockstep docs updated — overlay-assets.ts LOCKSTEP warning + docs/overlays-runbook.md both list overlay-repair.py's new embedded payloads as a lockstep surface
  CHECK: grep -c "overlay-repair.py" /Users/devgwardo/hermes-deploy/src/lib/overlay-assets.ts /Users/devgwardo/hermes-deploy/docs/overlays-runbook.md
  EXPECT: /[2-9]/
  EVIDENCE: overlay-assets.ts:2 + runbook 4 mentions; two-step regen documented

- [x] G6: a runnable regen path exists (script or documented snippet) that regenerates the embedded B64 constants from scripts/_overlay-files/*.py, so future overlay updates don't rot the embedded copy
  CHECK: test -f /Users/devgwardo/hermes-deploy/scripts/regen-overlay-repair-payloads.ts && node /Users/devgwardo/hermes-deploy/scripts/regen-overlay-repair-payloads.ts --check && echo REGEN_OK
  EXPECT: /REGEN_OK/
  EVIDENCE: RUN_BUFFER_B64: OK + DASHBOARD_RUNS_B64: OK (matches _overlay-files)

- [x] G7: independent review (claudex-glm52 + a fork) of the diff finds no blocking issue (restart-loop safety, idempotency, perms, lockstep, AST-validation)
  CHECK: test -f /tmp/overlay-repair-review.md && grep -c "BLOCKING:" /tmp/overlay-repair-review.md
  EXPECT: /^0$/
  EVIDENCE: claudex-glm52: BLOCKING none, VERDICT SHIP; fork: BLOCKING none, VERDICT SHIP. Polishes applied from their MINOR/NOTE findings (atomic write, dead import, header preservation, CI enforcement).

- [x] G8: hermes-deploy commit of templates/overlay-repair.py + docs + regen script (no unrelated files), pushed
  CHECK: cd /Users/devgwardo/hermes-deploy && git log -1 --name-only --pretty=format: | grep -cE "templates/overlay-repair.py|docs/overlays-runbook.md|scripts/regen-overlay-repair-payloads.ts|src/lib/overlay-assets.ts"
  EXPECT: /^4$/
  EVIDENCE: squash-merged as 31cb3f1 on main via PR #79 (branch deleted). Deployed to Vercel prod manually (CI workflows were disabled_manually): test gate 839/839 on merged tree, prisma migrate clean, vercel deploy --prod -> Ready 21:11 UTC, site 200. Landing WIP stashed during deploy, restored.

- [x] G9: live verification — the new repair script is pushed to the user's VM and runs; log shows it ensured the modules (up-to-date on a current VM, or self-healed if staled)
  CHECK: ssh -i /tmp/fleet-key root@217.154.255.95 'tail -5 /opt/data/overlay-repair.log' 2>/dev/null | grep -c "run_buffer.py\|dashboard_runs.py"
  EXPECT: /[1-9]/
  EVIDENCE: VM 217.154.255.95: staled dashboard_runs.py -> repair wrote 33247 bytes (self-healed); sha256 matches canonical; second run up-to-date; api_server patches intact (na=0).
