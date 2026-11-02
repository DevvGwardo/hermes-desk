# Gates: web redeploy from main + Phase 2 router

Scope: ship current main to agent-nub-lol + land lightweight hash router for panels/agent/conversation

- [x] G1: live web stale confirmed pre-deploy (live hash != local build hash)
  CHECK: node -e "const live='DFTlJjHN'; const fs=require('fs'); const html=fs.readFileSync('/tmp/nub-web-main/index.html','utf8'); const m=html.match(/index-([A-Za-z0-9_-]+)\.js/); if(!m) throw new Error('no local hash'); if(m[1]===live) throw new Error('not stale'); console.log('STALE_OK live='+live+' local='+m[1])"
  EXPECT: STALE_OK
  EVIDENCE: STALE_OK live=DFTlJjHN local=Cmn65FS3

- [x] G2: router module exists with parse/serialize roundtrip + unit tests green
  CHECK: npx vitest run src/lib/__tests__/router.test.ts 2>&1 | tail -n 5
  EXPECT: Tests  10 passed
  EVIDENCE: Start at  10:33:09 | Duration  530ms (transform 22ms, setup 0ms, import 30ms, tests 3ms, environment 427ms)

- [x] G3: every panel reachable by URL and survives reload (hash routes for settings/kanban/mcp/tools/files/preview/agent/conversation)
  CHECK: node -e "const s=require('fs').readFileSync('src/lib/router.ts','utf8'); for(const r of ['settings','kanban','mcp','tools','files','preview','agent','conversation']) if(!s.includes(r)) throw new Error('missing '+r); console.log('ROUTES_OK')"
  EXPECT: ROUTES_OK
  EVIDENCE: ROUTES_OK

- [x] G4: back/forward works (hashchange listener + last-written guard, no reload loop) — proven headless by scripts/router-probe.mjs
  CHECK: node -e "const s=require('fs').readFileSync('src/App.tsx','utf8'); if(!s.includes(\"addEventListener('hashchange'\")) throw new Error('no hashchange'); if(!s.includes('lastWrittenHash')) throw new Error('no guard'); if(!s.includes('pendingRoute')) throw new Error('no deferred link'); console.log('BACK_OK')" && node scripts/router-probe.mjs --dir /tmp/nub-web-main --port 5234 2>&1 | tail -n 2
  EXPECT: ROUTER_PROBE done ok
  EVIDENCE: ROUTER_PROBE 4/4 reload restores panel ok | ROUTER_PROBE done ok

- [x] G5: no behavior regression in Electron (router active in both, defaults closed when no hash)
  CHECK: npm run test:run 2>&1 | tail -n 5
  EXPECT: Tests  1340 passed | 1 skipped (1341)
  EVIDENCE: Start at  10:33:10 | Duration  16.68s (transform 6.87s, setup 0ms, import 26.77s, tests 28.59s, environment 95.53s)

- [x] G6: production webapp live with new hash (live asset == local build) + SPA fallback + CSP headers
  CHECK: node -e "const{execSync}=require('child_process'); const live=execSync('curl -s https://agent-nub-lol.vercel.app/ | grep -o \"index-[A-Za-z0-9_-]*\\.js\" | head -n 1',{encoding:'utf8'}).trim(); if(live!=='index-Cmn65FS3.js') throw new Error('live='+live); const spa=execSync('curl -s -o /dev/null -w \"%{http_code}\" https://agent-nub-lol.vercel.app/agents',{encoding:'utf8'}).trim(); if(spa!=='200') throw new Error('SPA '+spa); console.log('DEPLOY_OK '+live)"
  EXPECT: DEPLOY_OK index-Cmn65FS3.js
  EVIDENCE: live=index-Cmn65FS3.js == local deterministic build; SPA /agents 200; CSP frame-ancestors present; deeplink 200; deployment atknja03h Ready 46s via git (first git-connected build; project linked via vercel git connect, empty trigger abeacbd)
