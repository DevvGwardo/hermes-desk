# Gates: PR per issue (#16-#20 program)

Scope: one PR per issue; #19 ships a plan (its issue says plan-first), #20 gets a decision comment (no code exists to PR)

- [ ] G1: PR for #16 (secrets reveal/edit) — branch pushed, CI-green, reviewer-approved
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title,headRefName',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/16|secret/i.test(p.title)); if(!hit) throw new Error('no PR for #16'); console.log('PR16_OK #'+hit.number)"
  EXPECT: PR16_OK
  EVIDENCE: pending

- [ ] G2: PR for #17 (notify feed) — branch pushed, CI-green, reviewer-approved
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/17|notif/i.test(p.title)); if(!hit) throw new Error('no PR for #17'); console.log('PR17_OK #'+hit.number)"
  EXPECT: PR17_OK
  EVIDENCE: pending

- [ ] G3: PR for #18 (cross-session FTS) — branch pushed, CI-green, reviewer-approved
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/18|fts|search/i.test(p.title)); if(!hit) throw new Error('no PR for #18'); console.log('PR18_OK #'+hit.number)"
  EXPECT: PR18_OK
  EVIDENCE: pending

- [x] G4: PR for #19 (browser-use PLAN doc only — code explicitly deferred by the issue)
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/19|browser-use/i.test(p.title)); if(!hit) throw new Error('no PR for #19'); console.log('PR19_OK #'+hit.number)"
  EXPECT: PR19_OK
  EVIDENCE: PR19_OK #21

- [x] G5: #20 answered with a recorded decision (comment, close as decided — no PR exists for a decision)
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh issue view 20 --repo DevvGwardo/maiavm-desktop --json state,comments',{encoding:'utf8'}); const j=JSON.parse(out); if(!j.comments || !j.comments.length) throw new Error('no decision comment'); console.log('DEC20_OK')"
  EXPECT: DEC20_OK
  EVIDENCE: DEC20_OK
