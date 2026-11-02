# Gates: mascot workbench improvement pass

Scope: take the workbench + engine integration from "works" to "exhaustive, polished, verified". Every gate below is a real outcome a stranger could judge.

- [x] G1: gaze demo updates WITHOUT remounting (rAF-throttled prop path, no innerHTML churn)
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/gates-check-helper.cjs gazeNoRemount
  EXPECT: /remounts:0/
  EVIDENCE: remounts:0

- [x] G2: perf section measures BOTH ungated and gated (IntersectionObserver) modes and shows the delta
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/gates-check-helper.cjs gatedPerf
  EXPECT: /gated rows: \d+, fps: [\d.\/]+/
  EVIDENCE: gated rows: 3, fps: 56.8/52.5/52.7

- [x] G3: state data table includes tzt blink schedule column, sortable by any column
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/gates-check-helper.cjs tableColumns
  EXPECT: /blink col: true.*reordered/
  EVIDENCE: blink col: true; sort: sleeping -> waking (reordered)

- [x] G4: all 14 fx patterns captured as looping GIFs on disk
  CHECK: ls /Users/devgwardo/maiavm-desktop/workbench/out/fx_gifs/*.gif | wc -l
  EXPECT: /14/
  EVIDENCE: 14

- [x] G5: full contact-sheet screenshot regenerated at retina scale with new sections
  CHECK: python3 -c "from PIL import Image; im=Image.open('/Users/devgwardo/maiavm-desktop/workbench/out/sheet_states.png'); print(im.size)"
  EXPECT: /\(2[0-9]{3}, /
  EVIDENCE: (2400, 2254)

- [x] G6: workbench README documents every section, the mount shim API, and how to re-run captures
  CHECK: grep -c "^##" /Users/devgwardo/maiavm-desktop/workbench/README.md
  EXPECT: /[5-9]|1[0-9]/
  EVIDENCE: 6

- [x] G7: main app test suite still fully green after workbench changes (engine untouched)
  CHECK: cd /Users/devgwardo/maiavm-desktop && npx vitest run src/lib/grok-orb 2>&1 | grep -E "Tests\s+[0-9]+ passed"
  EXPECT: /5 passed/
  EVIDENCE: Tests  5 passed (5)

- [x] G8: page loads with zero console/page errors across a scripted sweep of every interactive control
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/gates-check-helper.cjs errorSweep
  EXPECT: /errors:0/
  EVIDENCE: errors:0
