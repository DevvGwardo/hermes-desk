# Dashboard fold-in gates

Spec: `docs/DASHBOARD_FOLD_IN_SPEC.md`. Decisions taken from the spec's own recommendations: website session first (Q1), first key is offered (Q3), desktop/phone tabs stay hidden until `GET /api/profile` returns a user id.

- [x] G1 Account, Billing, and API keys render in Settings only after the website session answers
  CHECK: `npx vitest run --project unit src/components/__tests__/settings-fold-in.test.tsx`
  EXPECT: 4 passed. The 401 case has no Account/Billing/API keys buttons.
  EVIDENCE: 4 passed this session.
- [x] G2 Plain sentences and the character counter
  CHECK: `npx vitest run --project unit src/lib/__tests__/platform-account.test.ts`
  EXPECT: 10 passed. Removing the card-update sentence turns "asks for a card update by a date" red (checked once this session).
  EVIDENCE: 10 passed. Replacing the card-update sentence with `card problem` turned that test red, then the sentence was restored.
- [x] G3 Old dashboard paths 302
  CHECK: `cd ~/hermes-deploy && npx vitest run tests/billing-fold.test.ts tests/a11y-chrome.test.ts`
  EXPECT: passed. `src/proxy.ts` sends `/dashboard/llm` → `/nub/keys`, `/dashboard/billing` → `/nub/billing`, `/dashboard/profile` → `/nub/account`, and `/dashboard?skill=` → `/api/nub/launch` (302 to `#/agent/<id>?tools=skills`).
  EVIDENCE: 17 passed.
- [x] G4 Web shell, both viewports, fixture + failed plan card + empty keys, no page errors
  CHECK: `npm run build:web && node scripts/fold-in-probe.mjs --dir dist`
  EXPECT: `FOLD_IN_PROBE ok desktop+mobile`
  EVIDENCE: `FOLD_IN_PROBE ok desktop+mobile` against the web build (1280×800 settings tabs, 390×844 phone settings).
- [x] G5 Live www.maiavm.com 302
  CHECK: after hermes-deploy is deployed, `curl -sI https://www.maiavm.com/dashboard/billing`
  EXPECT: `302` and `location` contains `/nub/billing`.
  EVIDENCE: Deploy run 35684959782 (Vercel, commits cd76cb1/286e4f5) succeeded 2026-09-22. Live: `/dashboard/billing` -> 302 `/nub/billing`, `/dashboard/profile` -> 302 `/nub/account`, `/dashboard/llm` -> 302 `/nub/keys`, `/dashboard?skill=code-review` -> 302 `/api/nub/launch?skill=code-review` -> 302 `/login?...` when signed out; `/nub/{billing,account,keys}` all 200; `/api/billing/overview` unauth 401.
