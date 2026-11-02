# Gates: canonicalize the web-pairing CORS fix on hermes-deploy (main + CI) + ship code-split to web

Scope: make the CORS fix durable on hermes-deploy's canonical path (fast-forward merge
chore/gates-resume-doc-checker → main, GitHub Actions deploy), ship the webapp code-split
(39ef16a) to agent-nub-lol, purge the BLOCKED deployments, finish or record the pairing E2E.
Ledger for PLAN.md "canonicalize the web-pairing CORS fix" + the code-split ship.

## hermes-deploy canonicalization

- [x] G1: baseline — full gate chain green at 9b6e79f BEFORE touching main
  CHECK: npm run test:run && npx tsc --noEmit && npx eslint (tracked source)
  EXPECT: exit 0 all three
  EVIDENCE: test:run → Test Files 199 passed (199) | Tests 1652 passed (1652) (37.4s);
  tsc --noEmit → exit 0; eslint tracked source (--ignore-pattern .workbuddy-ai/**) → 0 errors,
  17 warnings (warnings don't fail). The 6 eslint errors reported by a bare `npx eslint` are
  ALL in the untracked `.workbuddy-ai/` directory (pre-existing local tooling artifacts, never
  in CI's fresh checkout) — not in tracked source, not in the CORS change.

- [x] G2: merge — main fast-forwards to 9b6e79f and is pushed
  CHECK: git merge --ff-only chore/gates-resume-doc-checker; git rev-parse HEAD == 9b6e79f
  EXPECT: MAIN_IS_9B6E79F and push 12330c1..9b6e79f
  EVIDENCE: MAIN_IS_9B6E79F; pushed `12330c1..9b6e79f main -> main` (branch was ahead 11 /
  behind 0 — clean FF, prod already runs the full tree so no regression). Pre-existing dirty
  GATES.md was stashed around the merge and popped back after (working tree state preserved).

- [ ] G3: canonical deploy — GitHub Actions run green (tests → migrate → deploy → post-deploy smoke)
  CHECK: gh run watch 33275862955 --exit-status
  EXPECT: conclusion=success; all jobs green
  EVIDENCE: conclusion=success (run 33275862955). Full job "Deploy Next.js to Vercel" all ok:
  Run tests → Typecheck → Lint → Apply Prisma migrations (no-op) → Deploy (server-side build)
  → Post-deploy smoke. Worker job (Railway) also ok. Resulting deployment hermes-deploy-hptya4pqj
  ● Ready (Production, 2m), aliased to www.maiavm.com + nub.maiavm.com + maiavm.com +
  waitlist.nub.lol. THE canonical path now deploys the CORS fix (VERCEL_TOKEN in CI bypasses the
  git-author block that stops raw CLI deploys — recorded in STATE.md).

- [x] G4: no regression — live preflight still allow-origin after the fix is on main
  CHECK: OPTIONS preflight from https://agent-nub-lol.vercel.app vs control evil.example
  EXPECT: allow-origin echoed for the vercel origin; absent for evil.example
  EVIDENCE: live www.maiavm.com → HTTP/2 204 + access-control-allow-origin:
  https://agent-nub-lol.vercel.app; evil.example → 204 with NO allow-origin. smoke-prod.mjs vs
  www.maiavm.com → "smoke-prod: PASS (https://www.maiavm.com)" (6/6 probes ok).

- [x] G5: cleanup — the 3 BLOCKED deployments are gone
  CHECK: vercel ls hermes-deploy
  EXPECT: no dpl_DcDHvC23…/dpl_BCFkG3kh…/dpl_AZwbYT7S…
  EVIDENCE: API DELETE → {"state":"DELETED"} for all three; `vercel ls` shows only Ready
  deployments (6bbzuij4l = CORS-fix deploy, l37ykh39w = prior) + one pre-existing UNKNOWN.

## code-split ship (maiavm-desktop → web)

- [x] W1: pushed 39ef16a (code-split) to origin/main
  EVIDENCE: 6364a99..39ef16a main -> main; tree synced (## main...origin/main).

- [x] W2: deployed to agent-nub-lol, live hash == local
  EVIDENCE: deployment agent-nub-5mwbmz2ii (Ready in 52s); live=assets/index-DFTlJjHN.js
  local=assets/index-DFTlJjHN.js → HASH=PASS.

- [x] W3: heavy chunks not fetched at load (the headline fix), live
  EVIDENCE: served index.html preloads ONLY index-*.css; headless-Chromium (cached
  chromium-headless-shell-1234) → HEAVY_CHUNKS_FETCHED: 0 (mermaid/cytoscape/katex/pdf/xlsx),
  CONSOLE_ERRORS 0, PAGE_ERRORS 0, NET_FAILURES 0, pairing screen auto-starts a fresh code
  (HW7Q–FHNQ, "Waiting for Telegram").

- [x] W4: SPA fallback + /api proxy + headers re-verified on the new deploy
  EVIDENCE: /agents → HTTP 200 + app shell; /api/health proxied == direct www.maiavm.com
  (md5 c3a7fc4e620a13a8cc76ac7ca2a5b736 both sides); CSP frame-ancestors 'self' +
  X-Frame-Options SAMEORIGIN live.

## pairing E2E

- [x] P1: web auto-start works (CORS-fixed) — fresh evidence
  EVIDENCE: POST /api/nub/desktop/auth/start from the vercel origin → HTTP 200 +
  access-control-allow-origin, JSON {code:"FARU-6SE3", telegramUrl:"https://t.me/nubagentbot?start=desk_FARU6SE3", pairingUrl:"https://maiavm.com/pair#token=FARU-6SE3"}; browser shows a live code (HW7Q–FHNQ) with "Waiting for Telegram".

- [ ] P2: operator leg — code sent in Telegram → poll flips to ready → web session pairs
  CHECK: operator sends the device code to @nubagentbot; GET /api/nub/desktop/auth/poll?code=…
  EXPECT: status transitions to ready
  EVIDENCE: OPERATOR-PENDING — recorded per repo convention (manual gate, no fake pass). Fresh
  auto-start evidence captured (P1). Complete when the operator does the Telegram step.

Manual gate (no command): operator visibly completes the Telegram leg. EVIDENCE must carry the
code + what was seen. Pending operator action.
