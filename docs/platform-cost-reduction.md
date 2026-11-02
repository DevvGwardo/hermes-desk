# Platform cost reduction: Vercel Active CPU + Upstash Redis

Status: **2026-09-26.** Trigger: the Vercel team hit 100% of the free 4 h/month Fluid Active CPU (projects auto-pause past it), and the `hermes-deploy-cache` Redis is at 90% of 500k monthly commands.

Both are driven by **request volume into www.maiavm.com** (the hermes-deploy app on Vercel). The desktop/web/mobile clients are the main source of that volume, and the proxy's per-request work multiplies it. The maiavm.com server code was not available to this change, so §2–§3 are recommendations inferred from the client code and the platform's documented behaviour; §1 is shipped.

## 1. Shipped in the client (this repo)

`src/lib/poll-cadence.ts`: activity-aware polling. Base interval while the app is in use, 1 min when idle or unfocused, 5 min after 10 min idle, nothing while hidden, and an immediate refresh when the user returns.

| Poller | Before | After (in use → idle → dormant) |
|---|---|---|
| Desktop conversation sync (`/api/chat/sync` + transcript + roster) | 5 s, always while visible | 10 s → 60 s → 5 min |
| Mobile home list | 5 s | 10 s → 60 s → 5 min |
| Mobile open thread | 2.5 s | 5 s → 60 s → 5 min (streaming replies keep their own follow) |
| Open group room (idle) | 10 s | 10 s → 60 s → 5 min (live turn still ~1 s) |
| Approvals inbox / notifications bell | 60 s | 60 s → 60 s → 5 min |

**Effect:** a window left open for an idle hour goes from about 720 sync polls (~1,000 requests including transcript and roster) to about 24. Active use roughly halves.

**Rollout:** the web build takes effect on the next Vercel deploy. Desktop and Android take effect as users update, so push a desktop release soon; old clients keep polling at 5 s until they update.

## 2. Vercel Fluid Active CPU (server-side, highest impact first)

Active CPU counts only time the CPU is busy, not time spent waiting on I/O. Long-lived streams that mostly wait (chat SSE) are cheap. Crypto, parsing and cold starts are expensive.

1. **Stop SSH-per-request to VMs.** The client notes that the proxy reaches VM dashboards and files over SSH when the VM's public dashboard hostname doesn't resolve (`src/lib/hermes-rest.ts` "the proxy SSHs loopback", `electron/nub-link.cjs` `via: 'maiavm-ssh'`). A fresh SSH connection means a key exchange and handshake, which is pure CPU, and every proxied dashboard or fs call pays it. Options, best first:
   - **Make the direct path work.** Give each VM a resolvable HTTPS hostname (Caddy + per-VM DNS, as `dashboardUrlFromPublicUrl` already expects). Desktop clients already try the direct dashboard URL before maiavm (`dashboardRequest` in `electron/nub-link.cjs`), so those requests leave Vercel entirely.
   - **Proxy over HTTPS instead of SSH.** Call the VM dashboard over HTTPS with the session token, with keep-alive (`undici` Agent reuse across Fluid invocations).
   - **Keep SSH only for provisioning and repair,** never for per-request reads.
2. **Make "nothing changed" polls nearly free.** In `/api/chat/sync`, `/api/notifications` and `/api/llm/usage`, check a per-user version key first (one Redis `GET`, or better an in-memory cache, see §3). If the client's cursor or ETag matches, return `304` / empty before any Postgres query or JSON building.
3. **Send cacheable responses with `Cache-Control`.** Catalogs and static-ish lists (skills hub official list, MCP catalog, blueprints, update checks) can use `s-maxage` + `stale-while-revalidate` so the CDN serves repeats. This only works where the response isn't user-private; key the cache by instance only when safe.
4. **Find the actual top routes** in Vercel → Observability → Functions, sorted by CPU. Confirm §2.1 before optimizing anything else.
5. **Budget guard.** Hobby can't buy overage; the project pauses. If the next reset is more than a few days away, upgrading to Pro ($20/mo, far more CPU) is cheap insurance while §2.1–2.2 land.

## 3. Upstash Redis commands (500k/month free)

Upstash counts **every command**, including each command inside a pipeline or transaction. 500k/month is about 16k/day, which is only about 700 polls/hour across all users. That's under one idle desktop window at the old cadence.

1. **Cache session and instance lookups in memory.** Fluid reuses warm instances, so a module-level LRU with a 30–60 s TTL for `desktopToken → {userId, instanceId, gatewayToken}` removes most per-request `GET`/`HGETALL` calls. Invalidate on unlink.
2. **Rate limiting.** If `@upstash/ratelimit` runs on every proxied call, enable its `ephemeralCache` (blocks known-limited callers without Redis). Also exempt or loosen cheap authenticated GET polls, or rate-limit per user instead of per route, so one poll doesn't cost 2–4 commands.
3. **Combine keys.** Use one hash per user/instance (`HGETALL`/`HMGET`) instead of several `GET`s. Avoid writing a "last seen" or cursor on every poll; write only on change, or at most once a minute.
4. **Use TTLs, not background sweeps.** Don't use `SCAN`/`KEYS` sweeps from cron. Let keys expire.
5. **Pay-as-you-go.** It costs about $0.20 per 100k commands, so even 2M/month is about $4. Switching the database to it removes the hard cap if the reset is far away.

## 4. Order of work

1. Ship this client update: web deploy now, desktop release next.
2. Server: in-memory session cache (§3.1) and the version-key short-circuit (§2.2). These are small changes with a large effect on both meters.
3. Server: direct HTTPS to VMs instead of SSH (§2.1), the largest CPU win.
4. As a stop-gap until 2–3 land: Vercel Pro and Upstash pay-as-you-go.
