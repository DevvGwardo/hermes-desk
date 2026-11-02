# Gates: post-sign-in loading experience (web app)

Scope: improve everything the user sees after pairing succeeds on the web shell —
remove the post-pairing cold-boot reload, add a dedicated boot surface with staged
progress, richer sidebar skeleton, and parallel group transcript hydration.

- [x] G1: No `window.location.reload()` on the web pairing success path
  CHECK: grep -n "window.location.reload" src/App.tsx
  EXPECT: only the defensive fallback inside handleWebLinked (no-session branch)
  EVIDENCE: single hit is the `if (!session)` fallback; the normal path calls
  `resetActiveTransport()` + `setWebSession(session)` + `runHydrate()` in place.

- [x] G2: Boot hydration is re-runnable and re-runs after an in-place link
  CHECK: grep -n "runHydrate" src/App.tsx | head
  EXPECT: defined via useCallback, invoked from the boot effect, handleNubLinked,
  and handleWebLinked
  EVIDENCE: all four call sites present; effect deps `[runHydrate]`.

- [x] G3: Dedicated boot surface renders during first hydrate
  CHECK: grep -n "data-testid=\"boot-panel\"" src/components/BootPanel.tsx
  EXPECT: /boot-panel/
  EVIDENCE: BootPanel swaps in for ChatPanel when hydrating && no conversations &&
  none selected; live-verified in the prod build via a fetch-hang shim:
  stage 1 "Waking your agent… / Connecting to your private VM…", stage 2
  "Syncing your conversations… / Your agents are here — pulling your threads…".

- [x] G4: Boot surface ignores the synthesized placeholder agent
  CHECK: grep -n "ensureNubAgent" src/lib/agents/hermes-deploy-transport.ts | head -1
  EXPECT: deploy transport creates the stub "Nub" agent before roster lands, so
  bootSurface must not gate on agents.length
  EVIDENCE: gate is `(rosterHydrating || conversationsHydrating) && conversations.length === 0 && !selectedConversation`
  — caught during the live smoke when the first condition (agents.length === 0)
  never fired.

- [x] G5: Slow-roster escalation copy after 12s (no silent skeleton)
  CHECK: grep -n "12_000" src/components/BootPanel.tsx
  EXPECT: /12_000/
  EVIDENCE: fades in "First connection can take up to a minute — your agents are
  on their way."; aria-live copy announces stage changes; progress bar is
  decorative (aria-hidden) to avoid an indeterminate-progressbar a11y smell.

- [x] G6: Hydration failure stays honest (error card + Retry, no eternal skeleton)
  CHECK: grep -n "rosterHydrateError" src/components/BootPanel.tsx src/components/Sidebar.tsx | wc -l
  EXPECT: >= 2
  EVIDENCE: live-verified with a non-routable session host — sidebar alert
  "Couldn't load agents from the VM." + Retry rendered immediately; BootPanel
  mirrors the same error card when it is the visible surface.

- [x] G7: Group transcript hydration is parallel, not sequential
  CHECK: sed -n '1355,1380p' src/lib/agents/hermes-deploy-transport.ts
  EXPECT: /Promise\.all/ inside the group-room branch of getMessages
  EVIDENCE: member sessions hydrate via Promise.all with per-member catch
  (keep store — next poll retries); replaces the serial for-await loop.

- [x] G8: Sidebar skeleton resembles real rows (avatar + two-line stub, staggered)
  CHECK: grep -n "animationDelay" src/components/Sidebar.tsx
  EXPECT: /animationDelay/
  EVIDENCE: three pulse rows with 7x7 avatar circle + title/subtitle bars,
  160ms stagger; placeholder logic unchanged (sidebar-status.test.ts green).

- [x] G9: Full gate suite at HEAD
  CHECK: npx tsc -b && npm run test:run 2>&1 | tail -3 && npm run build:web 2>&1 | tail -1
  EXPECT: TSC clean, tests green, build ok
  EVIDENCE: tsc 0 errors; Test Files 200 passed (200), 1763 passed | 1 expected
  fail | 1 skipped; web build ✓ built in 9.53s.

Notes:
- Live smoke ran against `npm run preview` (prod bundle) with an injected
  `nub:mobile-session` and a same-origin fetch-hang shim injected into
  dist/index.html (gitignored, rebuilt clean afterwards). The prod CSP
  `connect-src` allowlist correctly blocks non-allowlisted hosts, which is why
  the shim was needed to simulate a slow VM.
- TopBar hydrating title changed 'Loading…' → 'Waking your agent…' to match
  BootPanel stage 1 copy. No test asserted the old string.

## Follow-up round: no placeholder content + shine skeletons (same day)

User feedback: placeholder content (fake "Nub" agent + synthesized
"New conversation" thread) flashed during the boot window, and skeletons
should shine, not pulse.

- [x] G10: Synthesized thread is flagged, not indistinguishable
  CHECK: grep -n "placeholder: true" src/lib/agents/vm-roster.ts
  EXPECT: /placeholder: true/
  EVIDENCE: `Conversation.placeholder?: boolean` added (types.ts); the
  `conv_<instanceId>` forever-chat synthesized by mergeVmRosterIntoState
  carries it; auto-select prefers a non-placeholder thread.

- [x] G11: Placeholder hidden + selection masked while hydrating
  CHECK: grep -n "placeholder" src/lib/agents/useAgentRuntime.ts | head
  EXPECT: /placeholder/
  EVIDENCE: conversations filter drops `placeholder && hydrating`;
  selectedConversation returns null for a selected placeholder while
  hydrating — live-verified: boot shows sidebar skeletons + BootPanel +
  "Waking your agent…" TopBar, zero fake content; after settle the
  forever-chat row appears and auto-selects (legitimate).

- [x] G12: Shine skeleton utility (theme-aware, reduced-motion safe)
  CHECK: grep -n "skeleton-shine" src/index.css | head -3
  EXPECT: /@keyframes skeleton-shine/ + prefers-reduced-motion override
  EVIDENCE: `.skeleton-shine` sweeps a `color-mix` ink sheen over the card
  surface via background-position (no new theme tokens); disabled under
  prefers-reduced-motion. Applied to sidebar rows (avatar + two bars,
  160ms stagger via --stagger) and BootPanel transcript bubbles + shimmer
  progress bar.

- [x] G13: Boot mascot visible on the blue wall
  CHECK: grep -n "expression=\"working\"" src/components/BootPanel.tsx
  EXPECT: /working/
  EVIDENCE: 'loading' is an FX-only orb state (face springs away, whirl
  plays) — read as a faint blob on the sky wall. Now sits in a soft card
  disc using 'working' (mascot visible, belts animate). Caught by screenshot.

- [x] G14: Gate suite still green after the follow-up round
  CHECK: npx tsc -b && npm run test:run 2>&1 | tail -3
  EXPECT: TSC 0, all tests pass
  EVIDENCE: tsc 0 errors; 200 files / 1763 passed | 1 expected fail | 1 skipped.
