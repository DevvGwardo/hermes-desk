# Gates: D-07..D-11 closeout (docs + hygiene + commit)

Scope: record the low batch as FIXED, keep 83MB bake binaries off main, commit — no release, no deploy

- [x] G1: sweep doc marks D-07..D-11 FIXED 2026-09-04 (table + per-finding notes)
  CHECK: node -e "const s=require('fs').readFileSync('docs/RED_TEAM_SWEEP_2026-08-30.md','utf8'); const parts=s.split(/^## /m); for(const id of ['D-07','D-08','D-09','D-10','D-11']){const p=parts.find(x=>x.indexOf(id+' ')==0); if(!p||p.indexOf('FIXED 2026-09-04')<0) throw new Error(id+' missing FIXED');} console.log('SWEEP_FIXED_5/5')"
  EXPECT: SWEEP_FIXED_5/5
  EVIDENCE: SWEEP_FIXED_5/5

- [x] G2: STATE.md ledger records the closeout + open-failures line updated
  CHECK: node -e "const s=require('fs').readFileSync('STATE.md','utf8'); if(s.indexOf('Sweep-5 closeout D-07..D-11')<0) throw new Error('no closeout entry'); if(s.indexOf('D-07..D-11 closed 2026-09-04')<0) throw new Error('open failures stale'); console.log('STATE_CLOSEOUT_OK')"
  EXPECT: STATE_CLOSEOUT_OK
  EVIDENCE: STATE_CLOSEOUT_OK

- [x] G3: orb-bake hygiene — binaries ignored, harness + manifest tracked in the commit
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('git check-ignore stream-assets/grok-orb-hype-loop-30s.mov stream-assets/grok-orb-hype-loop-30s.webm',{encoding:'utf8'}); if(out.indexOf('.mov')<0||out.indexOf('.webm')<0) throw new Error('binaries not ignored'); const t=execSync('git ls-files scripts/capture-orb-sequence.mjs docs/orb-video-sequences.md stream-assets/grok-orb-hype-loop-30s.manifest.json',{encoding:'utf8'}); for(const f of ['capture-orb-sequence.mjs','orb-video-sequences.md','.manifest.json']){if(t.indexOf(f)<0) throw new Error(f+' not tracked');} console.log('HYGIENE_OK')"
  EXPECT: HYGIENE_OK
  EVIDENCE: HYGIENE_OK

- [x] G4: no regression — full suite 1260 + tsc clean
  CHECK: npm run test:run 2>&1 | grep -q "Tests  1260 passed" && npx tsc -b && echo VERIFY_OK
  EXPECT: VERIFY_OK
  EVIDENCE: VERIFY_OK

- [x] G5: batch committed on main, working tree clean (ignored binaries excluded)
  CHECK: node -e "const{execSync}=require('child_process'); const m=execSync('git log --oneline -1',{encoding:'utf8'}); if(m.indexOf('fix(security): sweep-5 D-07..D-11')<0) throw new Error('wrong head: '+m.trim()); const st=execSync('git status --porcelain',{encoding:'utf8'}).trim(); if(st) throw new Error('dirty tree: '+st.slice(0,200)); console.log('COMMIT_OK')"
  EXPECT: COMMIT_OK
  EVIDENCE: COMMIT_OK
