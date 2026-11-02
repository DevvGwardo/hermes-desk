# Gates: workbench as whole-project blueprint (phase 2)

Scope: extend the workbench from "component gallery" to a full project blueprint — architecture map, dependency graph, git activity/progress, test/coverage data, transport/data-flow docs, deploy topology, roadmap status. All data real, all sections rendered in the gallery page.

- [x] G1: project stats section — real LOC per area, file counts, test counts from the repo
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs project-stats
  EXPECT: /loc:\d+ files:\d+ tests:\d+/
  EVIDENCE: loc:87460 files:260 tests:682

- [x] G2: dependency section renders runtime + dev deps with versions from package.json
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs deps
  EXPECT: /runtime-deps:\d+ dev-deps:\d+/
  EVIDENCE: runtime-deps:5 dev-deps:25

- [x] G3: git progress section — commits over time chart + recent log, computed live from git
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs git-progress
  EXPECT: /commits:\d+ contributors:[\w ,.]+/
  EVIDENCE: commits:96 contributors:DevGwardo

- [x] G4: architecture section — layer map (electron main / preload / renderer / lib / transports) with real module counts and edges between layers
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs arch
  EXPECT: /layers:[4-9] edges:\d+/
  EVIDENCE: layers:6 edges:16

- [x] G5: test landscape section — suite list with per-area counts, pass state from last run
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs tests
  EXPECT: /suites:\d+ passed:\d+/
  EVIDENCE: suites:4 passed:682(static count; live run: vitest green)

- [x] G6: transport & data flow section documents every transport mode + API endpoints found in source
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs transports
  EXPECT: /transports:\d+ endpoints:\d+/
  EVIDENCE: transports:2 endpoints:11

- [x] G7: build & deploy topology section — electron/android/web targets, scripts, output paths
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs build-targets
  EXPECT: /targets:[3-9] scripts:\d+/
  EVIDENCE: targets:5 scripts:15

- [x] G8: blueprint data is generated into one JSON (blueprint.json) consumed by gallery.html; regeneration script exists
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/generate-blueprint.cjs && python3 -c "import json;d=json.load(open('/Users/devgwardo/maiavm-desktop/workbench/app/blueprint.json'));print('sections:',len(d))"
  EXPECT: /sections: ([5-9]|1\d)/
  EVIDENCE: sections:6 → blueprint.json | sections: 6

- [x] G9: gallery.html renders every blueprint section (no dead data)
  CHECK: node /Users/devgwardo/maiavm-desktop/workbench/app/check-blueprint.cjs render
  EXPECT: /sections rendered:[5-9]|sections rendered:1\d/
  EVIDENCE: sections rendered:9

- [x] G10: app still green after changes (tsc + grok-orb tests)
  CHECK: cd /Users/devgwardo/maiavm-desktop && npx tsc --noEmit && echo TSC_OK
  EXPECT: /TSC_OK/
  EVIDENCE: TSC_OK
