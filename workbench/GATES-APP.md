# Gates: whole-app workbench (maiavm-desktop)

Scope: a component workbench + QA screenshot harness for the entire app. Three deliverables: (1) in-app dev-mode Mascot/UI Lab panel, (2) npm-scripted standalone component gallery, (3) scripted screenshots of every screen/state into out/. All verified.

- [x] G1: inventory of every renderable surface exists with real file paths
  CHECK: python3 -c "import json;d=json.load(open('/Users/devgwardo/maiavm-desktop/workbench/app/inventory.json'));print(len(d['components']),'components,',len(d['screens']),'screens');assert len(d['components'])>=15 and len(d['screens'])>=5"
  EXPECT: /(\d+) components, \d+ screens/
  EVIDENCE: 21 components, 14 screens

- [x] G2: dev-mode Lab panel reachable in the running app behind a DEV gate, rendering live components
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-lab.cjs lab-panel
  EXPECT: /lab renders:\d+ surfaces/ 
  EVIDENCE: lab renders:9 surfaces

- [x] G3: standalone gallery page renders app components from real source (no mocks of visuals)
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-lab.cjs gallery
  EXPECT: /gallery surfaces rendered:\d+/
  EVIDENCE: gallery surfaces rendered:35

- [x] G4: QA harness captures >=12 distinct screens/states as PNGs on disk
  CHECK: ls /Users/devgwardo/maiavm-desktop/workbench/out/app_screens/*.png | wc -l
  EXPECT: /(1[2-9]|[2-9][0-9])\s*$/m
  EVIDENCE: 14

- [x] G5: each captured PNG is non-blank (pixel variance check)
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-lab.cjs verify-shots
  EXPECT: /blank:0/
  EVIDENCE: shots:4 blank:0

- [x] G6: npm script `npm run workbench` opens the gallery; documented in README
  CHECK: cd /Users/devgwardo/maiavm-desktop && node -e "console.log(require('./package.json').scripts.workbench||'MISSING')"
  EXPECT: /^(?!MISSING).+/
  EVIDENCE: open workbench/app/gallery.html && node workbench/app/capture-app.cjs

- [x] G7: main test suite + tsc still green after all changes
  CHECK: cd /Users/devgwardo/maiavm-desktop && npx tsc --noEmit && echo TSC_OK
  EXPECT: /TSC_OK/
  EVIDENCE: TSC_OK

- [x] G8: lab panel is hard-gated out of prod bundles (grep of built renderer proves absence)
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-lab.cjs prod-gate
  EXPECT: /lab-in-prod:false/
  EVIDENCE: lab-in-prod:false
