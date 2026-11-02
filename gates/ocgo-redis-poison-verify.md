# Gates — verify opencode-go-budget test-fixture Redis poisoning diagnosis + fix (d82f9cb)

Repo under test: /Users/devgwardo/hermes-deploy (local clone of Maia-VM/hermes-deploy).
Claim source: user's 8-step diagnosis/fix report (2026-08-19).
Status: **7/7 checked.**

- [x] G1-fixtures — tests/opencode-go-budget.test.ts really uses userIds `whale` and `u1` as fixtures (root-cause claim).
  CHECK: `grep -nE "userId[\"' ]*[:=][\"' ]*(whale|u1)" tests/opencode-go-budget.test.ts`
  EXPECT: hits for `whale` and `u1` as userId fixtures.
  EVIDENCE: `102/109/122/128/135: userId: "u1"` (asserts of 600_000µs = $0.60 — exactly the "u1 $0.60" in the diagnosis) + `156: userId: "whale"` (recordOcGoSpend 12_000_000µs = $12/run — accumulates to $36 across 3 windows/repeat runs). Both match the poisoned counter values claimed.
- [x] G2-guard — getRedis() refuses test env BEFORE reading UPSTASH env / constructing the client.
  CHECK: `git show d82f9cb` + read src/lib/opencode-go-budget.ts:171-183.
  EVIDENCE: guard `if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") { redis = null; return null; }` sits above the `UPSTASH_REDIS_REST_URL/TOKEN` read and `new Redis(...)`. Belt-and-suspenders: tests/setup.ts unconditionally forces `NODE_ENV="test"` (line 8), covering shells that export NODE_ENV=production.
- [x] G3-pushed — d82f9cb on origin/main; both files clean in working tree.
  CHECK: `git status -sb -- <files>` + `git branch -r --contains d82f9cb`.
  EVIDENCE: `main...origin/main` (no ahead marker), files not in status; `origin/main` listed by `--contains`. Commit 13:21:15 EDT = 17:21:15 UTC, 1 message/6 insertions, only src/lib/opencode-go-budget.ts.
- [x] G4-regression — suite passes AND makes zero Redis connections with poison env exported.
  CHECK: exported `UPSTASH_REDIS_REST_URL=http://127.0.0.1:45987` + token + `NODE_ENV=production`, ran `npx vitest run tests/opencode-go-budget.test.ts` against an nc listener; positive control proves detector.
  EVIDENCE: 10/10 tests passed, listener log 0 bytes. Positive control on same listener setup: curl → 87 bytes logged (detector valid). Full-suite variant: 95 files / 858 tests passed, 0 listener hits with poison env exported.
- [x] G5-redis-clean — prod Upstash: no whale/u1 keys; counters = real-user spend under cap.
  CHECK: Upstash REST `KEYS ocgo:*`, `KEYS *whale*`, `KEYS *u1*`, GET each counter (creds: railway variables, hermes-deploy-worker prod).
  EVIDENCE: `*whale*`→`[]`, `*u1*`→`[]`. Live keys: 11 total, user keys only real instance IDs (cmsnplrz…, cmsorz7…). Counters (µs): pool 5h=2,876 ($0.003) < $9.60 cap; 12h=2,876 < $19.20; weekly=monthly=3,438,376 = **$3.4384 ≈ the "$3.44 real user spend"** in the diagnosis; user monthly sum 3,414,054+24,273=3,438,327 ≈ pool (consistent, no drift).
- [x] G6-complete-fix — no other test-reachable path connects to prod Redis.
  CHECK: grep all UPSTASH consumers + full-suite poison-listener run.
  EVIDENCE: 3 other constructors WITHOUT the guard (src/lib/cache.ts:30, src/lib/llm-ratelimit.ts:31-39, src/lib/llm-semantic-cache.ts:60-68, + status-probes.ts:335): currently safe only because their tests stub fake URLs (https://test.upstash.io etc.). Full suite (858 tests) with exported poison URL → 0 connections. Verdict: empirically contained today, structurally latent — see report note.
- [x] G7-vm-live — VM responds fast with real streamed tokens through the previously-poisoned path.
  CHECK: live `POST /v1/chat/completions` "reply with boop" on bot VM (217.154.255.95, IONOS-resolved) with the VM's real key; + agent.log history; + counter delta.
  EVIDENCE: HTTP 200 SSE, stream open + first chunk at TTFB 6ms, 20 completion tokens, finish_reason=stop, 11.5s total (20,202-token context replay). User's own post-cleanup turn in /opt/data/logs/agent.log 17:20:56 UTC: `msg='reply with boop'` → out=38, finish stop, latency 14.1s, no 429. Pool 5h counter 2,876→5,710µs across the two calls = assert admitted + settle recorded. Outage tail confirmed in gateway.log: `Retrying API call in 600s` ×3, last 429 17:12:42 UTC. Telegram user leg not exercisable from this machine (no user Telegram session) — provider path proven instead.
