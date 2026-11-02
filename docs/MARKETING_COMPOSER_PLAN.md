# Grokorb Campaign Composer

## Status

**Phases 1–3 implemented · Phases 4–6 pending**

Implemented 2026-09-16 in `maiavm-desktop`: campaign model + compiler + storage +
validation (`src/lib/marketing/`), guided composer shell with Story / Look /
Deliver (`src/components/marketing/`), dev-only `?marketing=1` route alongside
legacy `?studio=1` LoopStudio. Preview/export reuse the authentic GrokOrb engine
and the shared LoopStudio export painter so preview = export by construction.
Full suite 1779 passed + 1 expected fail + 1 skipped; `tsc -b` clean.

This plan replaces the current timeline-first Loop Studio with a guided marketing authoring product. The existing Studio exposes animation-engine concepts too early: tracks, banks, templates, pose values, face topology, effects, and export mechanics. The replacement should help an admin create a polished marketing asset by thinking about the campaign message, audience, proof, call to action, and destination format.

## Product direction

Build a guided **Marketing Composer** around the authentic GrokOrb engine.

The user should be able to:

1. Define what they are promoting and who it is for.
2. Build a clear marketing message.
3. Arrange a small number of understandable campaign scenes.
4. Apply brand and visual direction without tuning renderer internals.
5. Preview the result with real GrokOrb movement.
6. Resolve production warnings.
7. Export a destination-ready marketing asset.

The primary interface must not require knowledge of the GrokOrb renderer, animation timelines, or video editing terminology.

## Product name and vocabulary

Use marketing vocabulary in the primary UI:

- Campaign
- Story
- Scene
- Hook
- Value
- Proof
- Call to action
- Brand kit
- Look
- Deliver
- Ready to export

Avoid exposing these as primary concepts:

- Loop Studio
- Shape Lab
- Preset
- Template
- Caption bank
- Track
- Pose degrees
- Face topology
- Effect envelope
- Codec/export internals

An advanced timing/debug drawer may expose technical controls later, but it must not be the default workflow.

## Campaign data model

```ts
interface MarketingCampaign {
  id: string
  name: string
  goal: CampaignGoal
  audience: string
  productName: string
  productDescription: string
  keyMessage: string
  proofPoints: string[]
  callToAction: string
  tone: CampaignTone
  format: OutputFormat
  scenes: MarketingScene[]
  brand: BrandKit
  status: 'draft' | 'ready' | 'exported'
  createdAt: string
  updatedAt: string
}

interface MarketingScene {
  id: string
  role: 'hook' | 'problem' | 'value' | 'proof' | 'cta'
  headline: string
  supportingText?: string
  orbAction: OrbAction
  durationMs: number
  background: SceneBackground
  emphasis: 'quiet' | 'normal' | 'hero'
  asset?: SceneAsset
}
```

The UI edits this campaign model. The renderer receives a compiled timeline through:

```ts
compileCampaignToTimeline(campaign): Timeline
```

This preserves the current deterministic preview/export engine while preventing the marketing user from editing raw timeline structures.

## Guided workflow

### 1. Campaign brief

Ask only questions that affect the marketing output:

- What are you promoting?
- Who is it for?
- What should people understand?
- What action should they take?
- Where will this be published?

Campaign goals:

- Launch something new
- Announce an update
- Explain a feature
- Drive signups
- Promote an event
- Share proof or results
- Make a social announcement

Output formats:

- Vertical social video
- Square social video
- Landscape presentation/video
- Static animated post

The destination format is selected before scene editing so layout, safe areas, and duration defaults are correct from the beginning.

### 2. Message builder

Show four large, editable message cards:

```text
Hook       What should stop the scroll?
Value      Why should someone care?
Proof      What makes this believable?
CTA        What should they do next?
```

Each card includes:

- Short headline
- Optional supporting line
- Character count
- Readability indicator
- Live scene preview

### 3. Campaign draft

Create a clear 4–5 scene structure from the message:

1. Hook
2. Problem or opportunity
3. Product value
4. Proof or differentiator
5. Call to action

These are generated campaign scenes, not reusable animation templates. The user can:

- Reorder scenes
- Duplicate a scene
- Remove a scene
- Edit copy
- Change a scene role
- Add a scene

### 4. Look

The Look workspace contains understandable brand and visual controls.

Brand kit:

- Brand name
- Primary color
- Accent color
- Background color
- Logo upload
- Font choice
- Light/dark preference

Visual directions:

- Clean product
- High-energy launch
- Editorial announcement
- Technical proof
- Warm community
- Minimal premium

A direction changes compiler defaults for spacing, typography, caption placement, background treatment, orb scale, motion intensity, and transitions. It is not presented as a template browser.

Scene-level controls:

- Background color or image
- Orb scale: small / standard / hero
- Caption position: top / center / bottom
- Caption treatment: plain / badge / statement
- Visual emphasis: quiet / normal / hero

### 5. Deliver

The user chooses a destination rather than a codec:

```text
Export for:
[ Instagram / TikTok ] [ YouTube ] [ Presentation ] [ Download master ]
```

The system determines aspect ratio, canvas size, safe zones, caption placement, duration recommendations, output format, and filename. Advanced export settings remain behind a disclosure.

## GrokOrb authoring model

The GrokOrb remains the campaign's actor. The primary UI uses plain-language actions mapped to native engine states:

| Marketing action | Native state |
| --- | --- |
| Calm introduction | `idle` |
| Draw attention | `excited` |
| Celebrate a benefit | `happy` / `celebrate` |
| Think through a problem | `thinking` |
| Show work in progress | `working` |
| Signal success | `proud` |
| Ask a question | `curious` |
| Create urgency | `alerting` |
| Transition | `orbit` |
| Finish confidently | `proud` / `idle` |

Simple motion controls compile to existing native state, trick, and effects:

- Presence: subtle / balanced / energetic
- Entrance: fade / pop / rise / spin
- Emphasis: quiet / normal / hero
- Exit: settle / bounce / dissolve

Raw state names and renderer controls may exist in a developer drawer only.

## Interface structure

### Campaign home

- New campaign
- Recent campaigns
- Draft status
- Last export
- Duplicate campaign
- Continue editing

### Main editor

Use three top-level workspaces:

1. **Story** — brief, message cards, scene rail, scene editing.
2. **Look** — brand kit and visual direction.
3. **Deliver** — readiness checks, preview, format, and export.

Recommended layout:

```text
┌─────────────────────────────────────────────┐
│ Campaign name       Story  Look  Deliver    │
├─────────────┬───────────────────┬───────────┤
│ Scene rail  │ Large live stage  │ Inspector │
│             │                   │           │
│ 01 Hook     │     GrokOrb       │ Copy      │
│ 02 Value    │                   │ Action    │
│ 03 Proof    │                   │ Timing    │
│ 04 CTA      │                   │ Background│
├─────────────┴───────────────────┴───────────┤
│ Play / scrub / scene duration / preview      │
└─────────────────────────────────────────────┘
```

The raw timeline is removed from the primary view. A compact scene duration strip may remain at the bottom. An advanced timing drawer can expose the existing timeline for expert users.

## Readiness and admin tooling

The Deliver workspace should report actionable production checks:

- Campaign has a clear CTA
- Hook is not too long
- Scene text fits the selected safe area
- Text contrast passes
- No scene is empty
- Duration fits platform recommendations
- Final scene contains a CTA
- Logo is not clipped
- Required brand fields are complete
- Export format is selected
- Preview has been viewed

Example state:

```text
READY TO EXPORT

✓ Hook is readable
✓ CTA included
✓ 9:16 safe area passed
✓ Contrast passed
✓ 18-second duration is platform-safe
✓ All scenes contain content
```

Warnings must link directly to the affected scene or field.

Admin actions:

- Save campaign
- Duplicate campaign
- Rename campaign
- Export project JSON
- Import project JSON
- Create alternate output format
- Restore previous version
- Mark approved
- Export final asset
- Copy campaign summary

## Replacement architecture

```text
src/components/marketing/
  MarketingComposer.tsx
  CampaignHome.tsx
  CampaignBrief.tsx
  MessageBuilder.tsx
  SceneRail.tsx
  SceneEditor.tsx
  LookEditor.tsx
  DeliverPanel.tsx
  ReadinessPanel.tsx
  MarketingPreview.tsx

src/lib/marketing/
  campaign-types.ts
  campaign-defaults.ts
  campaign-storage.ts
  campaign-validation.ts
  scene-compiler.ts
  orb-actions.ts
  format-presets.ts
  copy-rules.ts
```

Existing systems to retain behind the compiler:

- `GrokOrb`
- Cat-only renderer boundary
- Native GrokOrb states
- Stage rendering
- Caption painter
- Background image support
- Deterministic timeline compiler output
- GIF/MP4 export
- Local persistence and JSON portability
- Undo/history mechanics

## Migration strategy

1. Add the new marketing campaign model without deleting LoopStudio.
2. Add `compileCampaignToTimeline()` and verify preview/export parity.
3. Add a new dev-only marketing route alongside the existing Studio.
4. Migrate the existing `Timeline.mascot` values into a simple campaign Look/Brand representation.
5. Keep old LoopStudio available at a hidden legacy route during validation.
6. Make the new Marketing Composer the `?studio=1` entry point after it passes usability and export gates.
7. Remove old Studio imports, banks, template browsing, and raw controls only after migration is proven.

Existing saved projects should remain load-safe. Unsupported legacy fields can be ignored or converted into neutral campaign defaults.

## Implementation phases

### Phase 1: Replace the shell

- Add `MarketingComposer`
- Add campaign home and new-campaign flow
- Add Story / Look / Deliver navigation
- Keep LoopStudio temporarily available as legacy/dev-only

### Phase 2: Campaign model and compiler

- Add campaign types
- Add local persistence
- Add project migration
- Add scene-to-Timeline compiler
- Preserve preview/export parity

### Phase 3: Story editor

- Add campaign brief
- Add message builder
- Add scene rail
- Add plain-language orb actions
- Add simple scene timing controls

### Phase 4: Brand and Look

- Add brand kit
- Add visual direction
- Add scene backgrounds and caption positions
- Add format-aware safe areas

### Phase 5: Delivery and admin quality

- Add readiness checks
- Add destination-specific exports
- Add duplication and versioning
- Add import/export
- Add approval status

### Phase 6: Optional assisted authoring

After the deterministic workflow is stable, add assistance for:

- Rewriting a hook
- Shortening copy
- Suggesting a CTA
- Suggesting a scene outline
- Detecting missing proof
- Adapting a campaign to another format

Assistance should edit the campaign model, never directly manipulate renderer internals.

## Success criteria

The replacement is successful when a new admin can:

1. Start a campaign without knowing what GrokOrb is internally.
2. Create a coherent 4–5 scene marketing video in under five minutes.
3. Understand every primary control without documentation.
4. Change copy without touching timeline mechanics.
5. Select a destination format before editing.
6. Receive actionable quality warnings.
7. Export a polished result without manually tuning renderer parameters.
8. Still receive authentic GrokOrb movement and expression through the existing engine.

## Recommended first implementation slice

Implement Phases 1–3 together:

- New Marketing Composer shell
- Campaign model
- Story / Look / Deliver navigation
- Guided brief
- Message builder
- Scene rail
- Plain-language GrokOrb actions
- Scene-to-Timeline compiler
- Existing preview/export integration

Do not begin with AI copy generation, advanced renderer controls, or a new rendering engine. The primary value is replacing the mental model of the Studio while preserving the proven rendering foundation.
