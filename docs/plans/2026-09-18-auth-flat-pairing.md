# Auth pairing — flat unboxed code spec

Date: 2026-09-18. Status: verified (working tree, tests pass — screenshots still manual).
Origin: pairing screenshot review ("Link to your agent" H3SE-2TXR card) —
request was to take the code out of its box div, apply to every div like
it, and remove the gradients.

## 1. Goal

Pairing / invite codes render as plain centered type, not inside a bordered
box. Auth screens are flat: no card border/shadow, no wallpaper gradients
behind them. Same treatment everywhere the pattern appears (web + modal +
mobile), with copy behavior and accessibility unchanged.

## 2. Non-goals

- No change to pairing logic (start/poll/TTL/countdown/ кто copy timer).
- No change to primary buttons (Open Telegram / Try again stay solid
  `var(--ca-primary-fill)` fills, white text).
- No global wallpaper redesign: chat walls keep their gradients.
- No change to functional gradients: sidebar title fade mask, linen dot
  pattern, mascot shadow/vignette/orb lighting, LoopLab transparency
  checker, LoopStudio beat grid, mascot `inkGradient` toggle.

## 3. Verified before-state

- `src/components/WebConnect.tsx:229` — outer
  `rounded-[var(--ca-radius)] border bg-[var(--ca-card)] shadow`; inner code
  button `:264` — `rounded border bg-[var(--ca-primary-soft)]` with
  `hover:border-[var(--ca-primary)]/30`.
- `src/components/WaitlistCapture.tsx:138,170` — identical outer card +
  inner invite-code box.
- `src/components/InviteRedeem.tsx:141` — identical outer card (no code
  box, flattened for consistency).
- `src/components/TelegramConnect.tsx:271` — code `<p>` with
  `rounded-xl bg-[var(--ca-primary-soft)]` inside the modal dialog (dialog
  card itself kept — it needs separation from the scrim).
- `src/mobile/mobile.css:976` — `.nub-mobile-code` card (`var(--gm-card)` +
  `var(--gm-shadow)` + radius); `:1034` — `.nub-mobile-code-skel`
  `linear-gradient` sweep.
- `src/index.css:127` — `.nub-root` canvas wash (2x radial + linear). Dark
  theme re-points the same tokens (near-black), so the wash persists in
  dark mode.

## 4. Changes (this pass)

- `src/index.css:217` — `.nub-auth-flat`: transparent, no border/shadow.
  Applied to WebConnect, WaitlistCapture, InviteRedeem outer wrappers.
- `src/index.css:226` — `.nub-root:has(.nub-auth-flat)`:
  `background: var(--ca-canvas)`. Flat solid canvas behind auth screens
  only; chat walls and all other surfaces keep their gradients.
- `src/index.css:232` — `.nub-code-plain`: transparent, no border/radius/
  shadow. Applied to WebConnect + WaitlistCapture code buttons;
  TelegramConnect code `<p>` drops `rounded-xl bg-[var(--ca-primary-soft)]`
  (plain type, same mono/tracking).
- `src/mobile/mobile.css:976` — `.nub-mobile-code`: transparent, no radius/
  shadow. `:1029` — `.nub-mobile-code-skel`: flat `var(--gm-skel-a)` +
  `nub-skel-flat` opacity pulse (replaces `linear-gradient` sweep +
  `background-position` animation).
- Preserved: button `disabled:opacity-60`, `aria-label="Pairing code ….
  Click to copy."`, `data-testid="code-countdown"` / `"pairing-url"` /
  `"pairing-error"`, error `role="alert"`, Enter-to-submit paste flow.

## 5. Other gradients inventoried (no change, per decision)

Safe to flatten later, decorative only:
- Chat walls `src/index.css:140-171` (+ dark `:1407-1430`) — flat = solid
  base; improves contrast, loses sky brand.
- `.status-shimmer` `:428`, `.skeleton-shine` `:484` — flat fill + opacity
  pulse (mobile already uses this pattern).
- `.faux-desktop` `:621` mock — flat `#1e3f66`.
- `ProjectArtifactCard.tsx:27` thumb `bg-gradient-to-br` — flat
  `bg-neutral-800`.
- `BootPanel.tsx:79` boot sheen — flat + pulse.
- `lab/studio/studio.css:90` lab panel — flat `#0d1117`.

Load-bearing, do not remove:
- `index.css:321` title-fade mask (text-overflow, not color).
- `index.css:175` linen dot pattern (texture, not wash).
- `lab/studio/stage.ts:162,172`, `grok-orb/core.js:257` mascot lighting.
- `lab/LoopLab.tsx:316` conic transparency checker; `LoopStudio.tsx:733`
  beat grid; mascot `inkGradient` toggle `:1061` (user-controlled).

## 6. Acceptance

- [x] WebConnect/WaitlistCapture/InviteRedeem: centered content on flat
  canvas, no card edge, no shadow ring, light + dark.
- [x] Code (H3SE-2TXR style): large mono plain type, no box; click still
  copies; hint still flips to "Copied"; skeleton while loading is a flat
  pulse, no sweep.
- [x] TelegramConnect modal: dialog card remains; only the code line is
  unboxed.
- [x] MobileConnect: code block transparent, no card/shadow; skeleton flat
  pulse.
- [x] Chat + all other screens: gradients unchanged.

## 7. Verification

- `npx vitest run src/components/__tests__/web-connect-login.test.tsx
  src/components/__tests__/invite-waitlist.test.tsx
  src/lib/__tests__/fill-token-usage.test.ts
  src/lib/__tests__/tokens-a11y.test.ts` — 16 passed.
- `npx vitest run src/mobile/__tests__/mobile-web-shell.test.ts` — 13
  passed.
- Re-verified 2026-09-18: same 16 + 13 passed, `npx tsc --noEmit` clean.
  Code inspection confirms acceptance above (flat canvas via
  `.nub-root:has(.nub-auth-flat)`, unboxed `.nub-code-plain` /
  `.nub-mobile-code`, dialog card kept, chat walls untouched).
  Still needs: eyeball light + dark screenshots of WebConnect,
  WaitlistCapture, InviteRedeem, TelegramConnect modal, MobileConnect.

## 8. JEV smoke test (2026-09-18, calibrated `--head jev`)

- Ran all 5 states, `fallback: false`: prod preview `:4173/`
  (WebConnect gate, real code + countdown, zero console errors), dev
  `:5174/#/waitlist`, `:5174/#/invite/FARU-6SE3`, dev `390x844`
  (MobileConnect phone shell), Telegram modal via state fixture
  (unrouted transient, needs the Electron bridge).
- Picks: waitlist → label inputs 80% (conf 78%); mobile → CTA 77%
  (conf 72%); telegram → CTA 69% (conf 64%); webconnect → tighten H1
  64% (conf 59%); invite → async states 54% vs CTA 42% (conf 47%,
  close race — captured in the dev CORS-error state, so confounded).
- Human verdict: ship the waitlist label fix (`aria-label` on the
  email input) — done (`WaitlistCapture.tsx:147`, tests + tsc green). CTA-contrast picks are suspect — primary fills already
  clear AA (`--ca-primary-fill` 4.80:1 light, 4.54:1 dark). H1 pick is
  a marketing lens on a functional pairing screen — no change. CHECKS
  all read violated at the 0.9 threshold (`ready` 0.46–0.69), so none
  of this counts as final verification.
- Not covered: dark-mode screenshots, `--deep` axe probes.
