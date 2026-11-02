# Browser-use subagent runner (Playwright on cube) — plan

Status: **planned, closes #19 — no code in this pass.** Prior skeleton answered
nothing; every open question below carries a decision with a one-line why.
Implementation order is phased so each lands independently behind a probe flag.

Step 2 status (2026-09-05, #25 — desktop slice, inert-off): job client +
per-instance probe (`probeBrowserJobs`, create/get/steer/delete in
`src/lib/hermes-rest.ts`), `browser.progress` SSE mapping (fetch-SSE path in
`src/lib/hermes-stream.ts` + `processSseBlock` in
`src/lib/agents/deploy-stream.ts`; the serve bridge has no browser wire shape
so nothing is forwarded there), run applier (`applyBrowserProgressEvent` in
`src/lib/delegate-apply.ts`, `Browsing <url>…` digests, `browserJobId` on
`SubagentRun`), spawn-suggestion gate (`useBrowserJobsSupported`, fail-closed),
job-scoped screenshot refs ride the existing VmShot path. Everything stays
inert until the cube job API exists. Steps 1/3/4 remain server-side.

## Decisions

### 1. Host: dedicated Playwright worker on the agent's own cube
Not a shared pool, not a new fleet. One tenant per cube means session
isolation is free — a shared pool would need tenant isolation built from
scratch, and cubes already scale with provisioning.

### 2. Job API: REST under the existing instance scope
```
POST   /api/instances/:id/browser/jobs        {goal, startUrl?} → {jobId}
GET    /api/instances/:id/browser/jobs/:jobId → {state, url?, screenshotRef?}
POST   /api/instances/:id/browser/jobs/:jobId/steer
  {action: 'type'|'click'|'goto'|'screenshot'|'stop', selector?, text?, url?}
DELETE /api/instances/:id/browser/jobs/:jobId → destroys the context
```
Auth reuses the proven desktop session→instance pin (same as the
`/api/chat/runs/:turnId/*` routes) — no new trust domain, 404 on unowned.

### 3. Progress over the existing run-events SSE (new event family, no new stream)
`browser.progress {jobId, status, url?, screenshotRef?}` alongside
`subagent.*`. Reattach + Last-Event-Id semantics come free; the client maps
`jobId` → the `SubagentRun` with kind `browserUse`.

### 4. Session isolation + leak cleanup
One Playwright browser context per job. Destroyed on DELETE, on job
completion, or by a 30-minute idle sweeper. Screenshots land under a
job-scoped path and are served through the existing preview proxy —
never a world-readable dir. A leaked context costs one idle browser until
the sweeper, never another tenant's cookies.

### 5. Unicode typing gates (Grok parity)
Per browser-image build (not per job): drive `type` on a test page with
CJK + emoji + RTL text and read back exact. Required: `en` + one CJK IME.
Gate result ships with the image metadata; jobs on an ungated image refuse
`type` with a clear error.

### 6. Chrome cookie import: opt-in, per-site, never logged
Electron reads the OS keychain (existing `secrets-op` launcher pattern),
POSTs cookies into the job-scoped jar over the pinned session. Explicit
consent modal per site per import. Cookie values never touch logs,
transcripts, or the renderer state dump. Jar dies with the context.

### 7. Client shape (unchanged surfaces, no new framework)
- `/spawn browserUse <goal>` → task-queue dispatch of a driver turn that owns
  the job lifecycle (create → steer → delete). Follows `src/lib/spawn.ts`
  routing; `browserUse` stays in the task-queue kinds.
- Pill/thread UX reused (`SubagentRun`, `subagentStatus`); kind-specific
  status text ("Browsing <url>…").
- Screenshots render as `VmShot` cards (existing `ChatPanel` path).
- UI hides behind a probe flag in the resize-probe pattern: hidden entirely
  on deploys without the route.

### 8. Rollout order (each independently shippable)
1. Cube service + job API behind probe flag (platform PR first).
2. Driver turn + SSE mapping + pill status (desktop, probe-gated UI).
3. Unicode gate harness in the image pipeline.
4. Cookie import channel + its own security review (separate gate).

## Non-goals (unchanged)
Anything on the 0.24 skip list; no local-Mac browser automation (cube only);
no persistent browser profiles across jobs; no general web-scraping API
outside a spawned run's goal.
