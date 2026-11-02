# SPEC — waitlist.nub.lol red-team remediation
Date: 2026-09-17. Source: REPORT.md:9, findings.md:27.
Scope: `POST/GET /api/public/waitlist`, signup form, headers, robots/status.

## 1. Goal
Fix H1 (angle-bracket email accepted) without breaking valid signups; harden L1/L2/INFO at low cost. No new junk rows during verification.

## 2. Non-goals
- No captcha vendor switch in this spec (optional follow-up).
- No dashboard redesign, only output-escaping audit.
- No brute-forcing disallowed routes.

## 3. Requirements

### R1 — Strict server email validation (fixes H1)
- Location: handler for `POST /api/public/waitlist` (currently returns `400 {"ok":false,"error":"that email doesn't look right"}` for bad input, `200 {"ok":true,"position":N}` for good).
- Behavior:
  1. Trim + lowercase before validate/store. Reject if != 3..254 chars.
  2. Reject if contains `< > " ' ( ) , ; : [ ]` whitespace newline, or more than one `@`.
  3. Must match `^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$` AND pass existing mail check (e.g. zod `.email()`).
  4. On fail: `400 {"ok":false,"error":"that email doesn't look right"}` — no position bump, no DB write.
  5. On dup (normalized match): return existing `position`, do not increment `total`.
- Acceptance: `POST {"email":"<script>alert(1)</script>@example.com"}` → 400; `POST {"email":"<b>@example.com"}` → 400; valid `a+b@example.com` → 200 once, second POST same → same position, total +1 only.

### R2 — Output safety audit
- Dashboard/admin list, admin mail, CSV export must HTML-escape / CSV-quote emails.
- CSV: prefix-quote cells starting `= + - @` with `'`, wrap in quotes per RFC 4180.
- Acceptance: insert H1 payload in staging only, verify dashboard shows literal text, CSV opens in Sheets without script/formula execution.

### R3 — Count enumeration (L1, optional)
- `GET /api/public/waitlist` keep `200 {"total":N}` but add `Cache-Control: public, max-age=60` (already behind Vercel HIT stale 300s per headers.txt:23) and optional rounding (`~300`) if scraping becomes issue.
- Do not require auth (would break landing page). Add per-IP throttle on GET.
- Acceptance: GET works unauth, no `Access-Control-Allow-Origin` echo.

### R4 — Headers / robots / status (L2)
- Remove `Access-Control-Allow-Origin: *` from HTML responses unless required; keep API without ACAO (current API is correct).
- Keep `robots.txt` as-is, verify `/status`, `/dashboard/`, `/agent/`, `/embed/`, `/r/`, `/redeem/` require auth or return minimal 404/401 — read-only check only.
- Acceptance: `curl -I https://waitlist.nub.lol/` shows no `ACAO: *`; API responses show no ACAO.

### R5 — Rate limit + logging (INFO)
- Keep current `429 {"ok":false,"error":"rate limited"}`. Add per-IP (e.g. 10 POST/min) + per-email (3/day) counters, log `x-nub-waitlist-source` but do not trust it for auth.
- Acceptance: 11 rapid POSTs from one IP → ≥1 x 429; distinct IPs unaffected.

## 4. Cleanup (owner, prod DB)
- `DELETE FROM waitlist WHERE email LIKE '%<script>%'` — junk row at position 295, total baseline 294 per recon6.txt.
- Verify with cache-bypass GET or direct DB count.

## 5. Test plan (no new pollution)
- Unit: validator table — valid, `<script>`, `a@b`, 300-char, `' OR 1=1--@x.com`, newline `Bcc:` → expect 400 except valid.
- Staging e2e: `py recon6.py` pointed at staging → angle-bracket → 400, no position change.
- Prod verify (read-only + 1 invalid POST): `POST {"email":"<b>@example.com"}` → 400; `GET` total unchanged.
- Regression: valid plus-address signup still 200 once.

## 6. Rollout
1. Deploy validator + dedupe + CSV escaping to staging.
2. Run unit + staging e2e.
3. Prod deploy, delete junk row, read-only GET verify.
4. Re-run `py recon6.py` against prod with invalid-only payloads.

## 7. Files
- Inputs: REPORT.md:1, findings.md:1, recon6.txt, recon7.txt, headers.txt:9, chunk-waitlist.js (contains `fetch("/api/public/waitlist")`).
- Output of this spec: SPEC.md (this file). No code changed by this spec.
