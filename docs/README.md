# Hermes Desk Documentation Index

Welcome to the Hermes Desk documentation library. This repository contains the complete architectural blueprints, security audits, runtime protocols, UI specifications, verification test ledgers, and historical records for **Hermes Desk**—a native, local-only macOS desktop companion for Hermes AI agents.

Hermes Desk evolved from the earlier `maiavm-desktop` / Nub Agent cloud-tethered architecture into a privacy-first, offline-capable desktop application. The system connects a React/TypeScript interface through an isolated Electron IPC bridge to a locally spawned, loopback-bound `hermes serve` Python daemon, providing native workspaces, multi-agent group rooms, autonomous browser lanes with user takeover, and bounded self-modification.

---

## Table of Contents

1. [Where to Start (Reading Order)](#where-to-start-reading-order)
   - [For New Contributors](#1-for-new-contributors)
   - [For Security Researchers & Red Teamers](#2-for-security-researchers--red-teamers)
   - [For UI / UX Engineers](#3-for-ui--ux-engineers)
2. [Project Glossary](#project-glossary)
3. [Documentation Catalog](#documentation-catalog)
   - [1. Architecture & Systems Overview](#1-architecture--systems-overview)
   - [2. Security Invariants, Red Team Findings & Hardening](#2-security-invariants-red-team-findings--hardening)
   - [3. Native Workspaces, Browser Lanes & CDP Engine](#3-native-workspaces-browser-lanes--cdp-engine)
   - [4. HUD, Mascot & Floating Window Architecture](#4-hud-mascot--floating-window-architecture)
   - [5. Self-Modification, Isolation & Safe Execution](#5-self-modification-isolation--safe-execution)
   - [6. Runtime, MCP & Protocol Specifications](#6-runtime-mcp--protocol-specifications)
   - [7. Verification Gates, Quality Assurance & Test Evidence](#7-verification-gates-quality-assurance--test-evidence)
   - [8. Historical Audits & Superseded Ledger (Nub era / Archive)](#8-historical-audits--superseded-ledger-nub-era--archive)
4. [Supplementary Directories & Visual Artifacts](#supplementary-directories--visual-artifacts)
5. [Documentation Maintenance Guidelines](#documentation-maintenance-guidelines)

---

## Where to Start (Reading Order)

### 1. For New Contributors
If you are new to the codebase and want to understand how Hermes Desk works end-to-end:
1. **[Hermes Local Desktop Spec](plans/2026-10-06-hermes-local-desktop-spec.md)**: The foundational document detailing the transformation from the cloud Nub architecture into a local-first Electron application.
2. **[Hermes Desk Contracts](plans/hermes-desk-contracts.md)**: Wave-1 cross-module contracts governing process boundaries, main/preload/renderer interfaces, and state isolation.
3. **[Hermes Serve Protocol](HERMES_SERVE_PROTOCOL.md)**: The wire specification describing how Electron communicates with the local `hermes serve` daemon over HTTP and WebSockets.
4. **[Hermes Capabilities](hermes-capabilities.md)**: Reference guide to the Hermes agent toolsets, profile models, skills, and memory systems.
5. **[Local Modules Refactor](plans/2026-10-10-local-modules.md)**: Architecture breakdown of how main-process modules (daemon lifecycle, MCP server, workspace lanes) are partitioned.
6. **[Hermes Desk Design System](plans/hermes-desk-design-system.md)**: Core UI component anatomy, theme palettes, and layout constraints.

### 2. For Security Researchers & Red Teamers
If you are auditing trust boundaries, IPC channels, sandbox policies, or network isolation:
1. **[Security Overview](SECURITY.md)**: Security policy, sandbox threat model, memory isolation rules, and baseline invariant checklist.
2. **[Hermes Desk Red Team Sweep (2026-10-06)](RED_TEAM_SWEEP_2026-10-06_HERMES_DESK.md)**: Dedicated vulnerability analysis covering daemon port-rebinding attacks, loopback token protection, and workspace escape vectors.
3. **[Security Acceptance Input](plans/hermes-desk-security-acceptance.md)**: Acceptance criteria for daemon verification, token handling, and renderer isolation.
4. **[RT-01 through RT-07 Remediation](RED_TEAM_REMEDIATION_RT01_RT07.md)**: Concrete code fixes and regression test proofs for critical attack surfaces (path traversal, token leaks, CSP bypasses).
5. **[Red Team Sweeps Series](RED_TEAM_ASSESSMENT.md)**: Read the historical progression of security sweeps: [Sweep 1 (2026-08-30)](RED_TEAM_SWEEP_2026-08-30.md), [Sweep 2 (2026-09-07)](RED_TEAM_SWEEP_2026-09-07.md), and [Sweep 3 (2026-09-28)](RED_TEAM_SWEEP_2026-09-28.md).
6. **[Proxy Hardening Spec](maiavm-proxy-hardening.md)**: Specification for strict HTTP route allowlists, WebSocket filtering, and token compartmentalization.

### 3. For UI / UX Engineers
If you are working on the interface, animations, responsive layout, or interactive widgets:
1. **[Hermes Desk Design System](plans/hermes-desk-design-system.md)**: Visual primitives, 6 core palettes (Maia, Sage, Iris, Honey, Mint, Rose), typography, and spacing tokens.
2. **[Mascot Character Contract](plans/hermes-desk-mascot-contract.md)**: State machine connecting agent states (thinking, tool use, browsing, resting) to Pip the courier owl's poses.
3. **[Mascot Motion v2](plans/hermes-desk-mascot-motion-v2.md)**: Vector flight mechanics, stage layout, particle bursts, and CSS/SVG animation pipelines.
4. **[Chat Load & Motion Spec](CHAT_LOAD_AND_MOTION_SPEC.md)**: Frame-rate budgets (60 FPS), streaming caret performance, and smooth transcript pinning during high-frequency token generation.
5. **[HUD Desktop Widget](HUD.md)**: Architecture of the floating, always-on-top compact companion strip window (`?win=hud`).
6. **[Bounded Generated UI Research](plans/hermes-desk-genui-research.md)** & **[GenUI Delivery](genui-delivery-2026-10-13.md)**: Rendering declarative, agent-generated widgets (stat chips, bar charts, checklists) securely without raw HTML injection.

---

## Project Glossary

- **Lanes**: Isolated browser and execution contexts maintained within the Native Workspace (`electron/local/workspace/lanes.cjs`). Each agent and the user operate in distinct lanes (e.g., the interactive `you` lane for the human user vs. dedicated `agent-<id>` lanes). Each lane enforces strict cookie, storage, and navigation isolation, with bounded tab limits (up to 8 tabs per agent, maximum 20 concurrent views) to prevent resource starvation and cross-context contamination.
- **Takeover**: The safety-critical mechanism (`electron/local/workspace/takeover.cjs`) that detects physical human interaction (mouse clicks, keystrokes, scroll gestures, or manual navigation) inside an agent-controlled browser tab. Upon detecting user intervention, Takeover instantly aborts in-flight Chrome DevTools Protocol (CDP) commands, rejects queued tool calls with the error code `user_took_control`, pauses agent execution, and transmits an optional steering prompt to notify the agent runtime. The human retains full control until explicitly choosing to resume the agent.
- **HUD (Heads-Up Display)**: A secondary, floating, always-on-top desktop window strip (`?win=hud`, `docs/HUD.md`). It reuses the core React renderer, Zustand stores, and IPC transport of the main window but renders an ultra-compact interface designed to hover along the screen perimeter during active coding sessions, keeping the agent and mascot accessible without obscuring the user's IDE or editor.
- **MCP Shim**: The Model Context Protocol bridge (`electron/local/mcp/shim/hermes-desk-mcp.cjs` and `electron/local/mcp/`). It acts as a standard stdio/socket MCP server that registers with the Hermes CLI profile configuration. When the Hermes model issues tool calls for browser automation or Generated UI display, the MCP shim intercepts them and forwards them across the Electron IPC layer to the main process for policy evaluation and native rendering.
- **Hermes Daemon (`hermes serve`)**: The background Python runtime process (`~/.hermes/hermes-agent/venv/bin/hermes serve`) powering the agent core. Hermes Desk orchestrates this process locally on loopback (ports 9120+ in auto or spawn mode). The authentication bearer token is held exclusively in Electron main-process memory; Desk cryptographically verifies that the listening loopback port matches the spawned child process before transmitting any credentials, preventing unauthorized local processes from hijacking sessions.
- **Egress Proxy**: A specialized loopback HTTP/CONNECT proxy (`electron/local/workspace/egress-proxy.cjs`) that gates all outbound network requests originating from agent browser lanes. It pins DNS lookups, strictly blocks RFC1918 private subnets, loopback addresses (`127.0.0.1`), and cloud metadata IP ranges (`169.254.169.254`), and enforces DNS rebinding defenses and hop-by-hop header scrubbing to prevent Server-Side Request Forgery (SSRF) and credential exfiltration.
- **GenUI (Bounded Generated UI)**: A constrained, declarative widget protocol (`electron/local/mcp/genui.mjs`). Agents can emit structured JSON schemas for summary cards, tables, bar charts, and interactive checklists. The frontend renders them with pure React components, prohibiting arbitrary HTML, raw CSS, external URLs, or unvetted JavaScript execution.
- **Preload IPC Bridge**: The context-isolated communication boundary (`electron/preload.cjs`) instantiated via `contextBridge.exposeInMainWorld('hermesDesk', ...)`. It strictly exposes allowlisted, parameter-validated RPC methods between the renderer and main process, preventing any direct access to Node.js built-ins or Electron internals from renderer code.
- **Pip (The Courier Owl)**: The official mascot and ambient state indicator for Hermes Desk, designed as an owl with a winged courier helmet and messenger satchel. Pip's SVG rig dynamically updates its poses, emotional states, flight physics, and stage effects to communicate agent activity (thinking, browsing, tool use, resting) across six built-in color palettes.
- **Flat Pairing**: The zero-friction cryptographic onboarding mechanism (`plans/2026-09-18-auth-flat-pairing.md`) used for linking companion clients over loopback or private networks without third-party authentication servers.

---

## Documentation Catalog

### 1. Architecture & Systems Overview
Foundational specifications, high-level system diagrams, UI/UX system design, layout plans, and multi-agent coordination frameworks.

| Document | Status | Description |
|---|---|---|
| [Hermes Local Desktop Spec](plans/2026-10-06-hermes-local-desktop-spec.md) | **Active Spec** | Master architectural blueprint for Hermes Desk: migrating from cloud Nub to a local-first Electron desktop app connected to `hermes serve`. |
| [Hermes Desk Contracts](plans/hermes-desk-contracts.md) | **Active Contract** | Wave-1 cross-module contracts defining interface boundaries, token lifetimes, and state isolation between Electron processes. |
| [Hermes Desk Design System](plans/hermes-desk-design-system.md) | **Active Spec** | Visual design architecture: 6 primary color palettes, typography scale, surface layering, and responsive layout breakpoints. |
| [Home Page Launch Screen](plans/2026-10-07-home-page.md) | **Implemented** | Functional specification for the startup screen: offline/online status, quick agent dispatch, recent sessions, and health checks. |
| [Local Modules Refactor](plans/2026-10-10-local-modules.md) | **Implemented** | Modular restructuring of Electron main logic into isolated modules: daemon boot, workspace manager, and MCP dispatch. |
| [Hermes Desk Phase 0 Findings](plans/hermes-desk-phase0-findings.md) | **Archival Baseline** | Initial technical reconnaissance of the repository, codebase audit, dependency mapping, and migration risks. |
| [Hermes Capabilities Map](hermes-capabilities.md) | **Active Reference** | Technical reference cataloging Hermes agent tools, profile management, local CLI flags, skills, and memory storage. |
| [Hermes SaaS Coverage Map](hermes-saas-coverage.md) | **Active Reference** | Feature-by-feature mapping analyzing which cloud services are superseded by local desktop execution vs. remote VM proxying. |
| [Subagents & Multi-Agent Design](SUBAGENTS_AND_MULTI_AGENT.md) | **Active Spec** | Clean-room architectural design for subagent spawning, supervisor delegation, turn isolation, and memory boundaries. |
| [Local Group Rooms](plans/2026-10-07-local-group-rooms.md) | **Implemented** | Architecture for multi-agent group chat sessions operating over `hermes serve`: participant routing, turns, and shared contexts. |
| [Local Group Rooms Checkpoint](plans/2026-10-09-local-group-rooms-checkpoint.md) | **Milestone Report** | Implementation audit, feature verification receipts, and UI wireframes for multi-agent room chat. |
| [Agent Orchestration Loop](plans/2026-10-10-agent-orchestration-loop.md) | **Active Spec** | Lifecycle management for agent chat loops: fan-out message dispatch, reply recovery, error barriers, and cancellation semantics. |
| [Design Presets](design-presets.md) | **Active Reference** | Visual theme specifications, typography variants, high-contrast modes, and dynamic theme switching rules. |
| [Files & Projects Design](files-projects-design.md) | **Active Spec** | Architecture for local file browsing, workspace project trees, disk access sandboxing, and file preview generation. |
| [Sidebar Top Consolidation](sidebar-top-consolidation-2026-10-11.md) | **Implemented** | Layout specification unifying navigation headers, active session stats, agent switcher, and workspace dock controls. |
| [Desktop Architecture Diagram](maiavm-desktop.architecture.html) | **Interactive Tool** | Interactive HTML visualization of application architecture, module boundaries, IPC channels, and external services. |
| [Desktop Architecture Schema](maiavm-desktop.architecture.json) | **Data Schema** | Machine-readable JSON specification defining the structural graph and dependencies visualized in the architecture tool. |

---

### 2. Security Invariants, Red Team Findings & Hardening
Security policies, red team penetration sweeps, vulnerability remediations, sandbox boundaries, and egress isolation controls.

| Document | Status | Description |
|---|---|---|
| [Security Policy & Baseline](SECURITY.md) | **Core Policy** | Primary security document: threat model, sandbox boundaries, invariant catalog, and vulnerability reporting procedures. |
| [Red Team Assessment (Full)](RED_TEAM_ASSESSMENT.md) | **Audit Report** | Comprehensive red-team audit of `maiavm-desktop`: IPC injection vectors, Electron renderer sandbox escape analysis, and protocol security. |
| [RT-01 through RT-07 Remediation](RED_TEAM_REMEDIATION_RT01_RT07.md) | **Verified Proof** | Remediation report and verification tests for critical vulnerabilities RT-01 through RT-07 (path traversal, token leak, CSP bypass). |
| [Red Team Sweep 1 (2026-08-30)](RED_TEAM_SWEEP_2026-08-30.md) | **Audit Report** | First comprehensive static sweep (commit `a1ed956`): 523 files analyzed via DeepSec methodology, supply-chain checks, and AST review. |
| [Red Team Sweep 2 (2026-09-07)](RED_TEAM_SWEEP_2026-09-07.md) | **Audit Report** | Second sweep evaluating delta changes: auto-updater code signing, browser-use runners, notification polling, and token storage. |
| [Red Team Sweep 3 (2026-09-28)](RED_TEAM_SWEEP_2026-09-28.md) | **Audit Report** | Third sweep focusing on TOFU pinning, shell command injection prevention, MCP execution boundaries, and fail-closed controls. |
| [Hermes Desk Red Team Sweep (2026-10-06)](RED_TEAM_SWEEP_2026-10-06_HERMES_DESK.md) | **Audit Report** | Dedicated Hermes Desk security sweep: port rebinding attacks, daemon credential extraction, bridge spoofing, and workspace sandbox. |
| [Security Acceptance Criteria](plans/hermes-desk-security-acceptance.md) | **Active Gate** | Formal security acceptance inputs: loopback token binding, sandbox escape protections, and verified process matching. |
| [Waitlist Red Team Remediation](plans/2026-09-17-waitlist-redteam-remediation.md) | **Verified Fix** | Security remediation plan for web endpoints, edge APIs, rate-limiting, and CORS configuration. |
| [MaiaVM Proxy Hardening Spec](maiavm-proxy-hardening.md) | **Active Spec** | Server-side proxy and VM image hardening spec: strict route allowlist (S1–S6), deny-first pattern, and token containment. |
| [Auth Flat Pairing Spec](plans/2026-09-18-auth-flat-pairing.md) | **Active Spec** | Cryptographic flat pairing specification: unboxed pairing codes, loopback key exchange, and anti-eavesdropping guarantees. |

---

### 3. Native Workspaces, Browser Lanes & CDP Engine
Automated browser management, Chrome DevTools Protocol execution, user takeover semantics, and lane isolation.

| Document | Status | Description |
|---|---|---|
| [Browser-Use Subagent Plan](BROWSER_USE_PLAN.md) | **Active Spec** | Architecture plan for browser automation runner: Playwright / CDP execution, browser lanes, session sandboxing, and cube runner. |
| [Hermes Desk MCP Route](plans/hermes-desk-mcp-route.md) | **Implemented** | Bridge connecting Hermes MCP tool invocations to native browser lanes via CDP session proxies and takeover listeners. |
| [Delete & Sync Audit](delete-sync-audit.md) | **Audit Report** | Analysis of workspace resource deletion, synchronization guarantees between local workspace storage and remote state. |

---

### 4. HUD, Mascot & Floating Window Architecture
Always-on-top HUD floating strip, mascot character design, state machines, vector motion engines, and frame budgets.

| Document | Status | Description |
|---|---|---|
| [HUD Architecture & Widget](HUD.md) | **Active Spec** | Design and implementation of the floating, always-on-top compact chat strip (`?win=hud`): shared store, IPC synchronization, compact mode. |
| [HUD Surface Protocol Note](hud-surface-note.md) | **Active Spec** | Protocol note specifying how `surface: "hud"` is transmitted to Hermes to adjust response formatting and persona style. |
| [Mascot Contract](plans/hermes-desk-mascot-contract.md) | **Active Contract** | Behavioral contract for Pip the courier owl: mapping agent state changes (idle, thinking, browsing, error) to mascot emotions. |
| [Mascot Motion v2](plans/hermes-desk-mascot-motion-v2.md) | **Implemented** | Pip motion engine v2: flight physics, SVG keyframe clips, mascot stage layout, dust particle bursts, and easing curves. |
| [Mascot Capture Blueprint](plans/2026-10-07-mascot-capture-blueprint.md) | **QA Spec** | Visual testing blueprint and screenshot harness for verifying mascot rendering across resolutions and theme palettes. |
| [Chat Load & Motion Spec](CHAT_LOAD_AND_MOTION_SPEC.md) | **Active Gate** | Frame-rate budgets and performance constraints: guaranteeing 60 FPS during chat opening, streaming, and mascot animation. |
| [Activity Presence Contract](ACTIVITY_PRESENCE.md) | **Active Contract** | Single source of truth mapping agent tool calls, streaming events, and idle states to mascot presence and icon states. |
| [Animation Fluency Gap Analysis](ANIMATION_FLUENCY_GAP.md) | **Historical Review** | Comparative evaluation of animation fluidity: Grok Bot mark vs. FatCat/Pip sprite engine, documenting retirement of `blob-fx`. |
| [Blob-FX Parity Report](blob-fx-parity-report.md) | **Historical Review** | Clean-room parity report evaluating the legacy canvas/SVG blob effect engine and performance benchmarks. |
| [Brand Assets Documentation](brand/README.md) | **Asset Guide** | Specifications and raster export guidelines for Hermes Desk and Nub Agent banners, avatars, and marks. |
| [Mascot Blueprint Testbench](blueprint/mascot-blueprint.html) | **Interactive Tool** | Standalone interactive HTML harness for previewing and stress-testing mascot poses, flight paths, and colorways. |
| [Mobile Mascot Blueprint](blueprint/nub-mobile-blueprint.html) | **Interactive Tool** | Interactive HTML layout tool for validating mascot responsiveness and touch targets on mobile screen sizes. |

---

### 5. Self-Modification, Isolation & Safe Execution
Self-editing agent workflows, declarative Generative UI rendering, AST transformation bounds, and approval dialogs.

| Document | Status | Description |
|---|---|---|
| [Self-Modification State Ledger](self-modification/STATE.md) | **Active Ledger** | Comprehensive implementation ledger tracking the 7-phase self-modification lifecycle, AST verification, and rollback safety. |
| [Self-Modification Update Spec](self-modification-update-spec-2026-10-26.md) | **Proposed Spec** | Specification for surfacing self-modification features in the UI: user confirmation dialogs, diff previews, and safe patching gates. |
| [Self-Editing Delivery Report](self-editing-delivery-2026-10-13.md) | **Delivery Receipt** | Frontend-only self-editing delivery report: guarded file transformation contracts, sandbox constraints, and synthetic DOM tests. |
| [Self-Editing & GenUI Scope](plans/2026-10-13-self-editing-genui-completion.md) | **Milestone Plan** | Roadmap defining the completion criteria for agent self-editing and bounded Generative UI components. |
| [Bounded GenUI Delivery](genui-delivery-2026-10-13.md) | **Implemented** | Implementation delivery for Generative UI v1: declarative schemas for stats, tables, and checklists without executable script injection. |
| [GenUI Local Install Repair](genui-local-install-repair-2026-10-13.md) | **Fix Procedure** | Troubleshooting and repair guide for resolving local npm dependency conflicts when installing GenUI rendering components. |
| [GenUI Research Report](plans/hermes-desk-genui-research.md) | **Research Report** | Deep research on safe Generative UI architectures, comparing server-driven UI, AST sandboxing, and declarative JSON constraints. |
| [Orchestrator & GenUI Loop](overnight/2026-10-14-orchestrator-genui-loop.md) | **Test Receipt** | Verification log of autonomous multi-agent runs validating GenUI tool calling, AST transformations, and guarded file edits. |

---

### 6. Runtime, MCP & Protocol Specifications
Wire protocols, process management, Server-Sent Events (SSE), WebSockets, and real-time streaming architectures.

| Document | Status | Description |
|---|---|---|
| [Hermes Serve Protocol](HERMES_SERVE_PROTOCOL.md) | **Frozen Contract** | Canonical wire protocol specification for `hermes serve`: REST endpoints, WebSocket `/api/ws`, auth headers, and event schemas. |
| [Plugin Host Implementation Plan](PLUGIN_HOST_IMPLEMENTATION_PLAN.md) | **Implemented** | Architecture for hosting Hermes plugins within Electron: SDK shims, pane registries, manifest loading, and IPC dispatch. |
| [Plugin Host Gap Analysis](MAIA_PLUGIN_HOST_GAP.md) | **Historical Review** | Gap analysis that preceded the plugin host implementation, documenting required SDK shims and registry hooks. |
| [Deploy Transport Wiring Plan](DEPLOY_TRANSPORT_WIRING_PLAN.md) | **Superseded Plan** | Dual-stream transport wiring plan for transitioning between remote VM deploy stream and local Hermes streams. |
| [Production-Only VM Transport Plan](plans/2026-08-16-maiavm-prod-only-transport.md) | **Implemented** | Technical plan for eliminating development mock transports and enforcing strict production VM communication. |
| [Realtime Chat Synthesis](realtime-chat/SYNTHESIS.md) | **Master Spec** | Comprehensive synthesis of real-time chat streaming layers (L1–L5), performance measurements, and cross-device sync. |
| [L1: Desktop Stream Render](realtime-chat/L1-desktop-render.md) | **Component Spec** | Layer 1: Desktop streaming renderer, token coalescing, smooth scroll pinning, and caret rendering. |
| [L2: Android Chat Surface](realtime-chat/L2-android-surface.md) | **Component Spec** | Layer 2: Android mobile chat surface, polling vs. streaming trade-offs, and background synchronization. |
| [L3: Deploy SSE & Turn Identity](realtime-chat/L3-deploy-sse.md) | **Protocol Spec** | Layer 3: Server-Sent Events (SSE) transport, turn identity, and message framing over remote tunnels. |
| [L4: Local Hermes Stream](realtime-chat/L4-hermes-local.md) | **Protocol Spec** | Layer 4: Local Hermes streaming protocol, loopback IPC bridges, and backpressure handling. |
| [L5: Cross-Device Live Sync](realtime-chat/L5-cross-device.md) | **Protocol Spec** | Layer 5: Cross-device state synchronization, latency measurements, and conflict resolution. |
| [Avatar Prompt Specification](plans/2026-09-13-avatar-prompt.md) | **Active Spec** | Specification for chat-prompted avatar generation, metadata storage, and profile image caching. |
| [Memory Viewer Plan](plans/2026-09-13-memory-viewer.md) | **Active Spec** | Architecture for per-agent memory inspection: key-value storage browsing, semantic search, and TTL visualization. |
| [System Stats Draft](plans/2026-10-07-system-stats-draft.md) | **Proposed Spec** | Draft specification for streaming system telemetry (CPU, memory, disk usage) over the daemon protocol. |
| [Hermes Deploy Server Brief](hermes-deploy-server-brief.md) | **Service Brief** | Overview of backend server infrastructure in `hermes-deploy` (www.maiavm.com), routing rules, and auth verification. |
| [Routine Origin Fix Plan](ROUTINE_ORIGIN_FIX_PLAN.md) | **Bugfix Plan** | Remediation plan resolving host cron schedules being misclassified as VM-agent routine tasks in the scheduler. |
| [Background Process Notices](background-process-notices.md) | **UI Spec** | Notification and status pill specifications for background daemon tasks, long-running tools, and subagents. |

---

### 7. Verification Gates, Quality Assurance & Test Evidence
End-to-end test harnesses, visual regression suites, memory benchmarks, and automated QA execution logs.

| Document | Status | Description |
|---|---|---|
| [Hermes Desk Isolated E2E](plans/hermes-desk-e2e.md) | **Active Harness** | Isolated End-to-End testing strategy: headless Electron fixtures, mock daemons, and deterministic assertions. |
| [Local Room Acceptance](plans/2026-10-10-local-room-acceptance.md) | **Test Receipt** | Acceptance test report for local room shells, multi-agent switching, and native focus handling. |
| [Packaged Smoke Acceptance](packaged-smoke-2026-10-11.md) | **Test Receipt** | Packaged application smoke test verification: dmg/zip installer validation, code-signing bypass audit, launch benchmarks. |
| [Hermes Desk Gap Analysis (2026-10-07)](hermes-desk-gap-analysis-2026-10-07.md) | **Audit Report** | Read-only gap analysis of Hermes Desk: comparing requirements against implementation state. |
| [Hermes Desk Gap Remediation (2026-10-07)](hermes-desk-gap-remediation-2026-10-07.md) | **Verification Log** | Remediation ledger verifying fixes for gaps identified in the 2026-10-07 audit. |
| [Hermes Desk Gap Spec (2026-10-25)](hermes-desk-gap-spec-2026-10-25.md) | **Active Spec** | Specification for verification-layer remediation, test harness repairs, and gate enforcement. |
| [Hermes Desk Gap Sweep (2026-10-16)](hermes-desk-gap-sweep-2026-10-16.md) | **Verification Log** | Follow-up sweep verifying UI, performance, and test stability across platforms. |
| [Hermes Desk Small Gaps (2026-10-14)](hermes-desk-small-gaps-2026-10-14.md) | **Verification Log** | Audit and test receipts for minor UI anomalies, focus quirks, and styling inconsistencies. |
| [Small-Gap Improvement Loop (2026-10-07)](hermes-desk-small-gap-loop-2026-10-07.md) | **Verification Log** | Verification ledger for iterative small-gap resolution loop. |
| [Hermes Desk Improvements (2026-10-07)](hermes-desk-improvements-2026-10-07.md) | **Delivery Receipt** | Test evidence and delivery report for early Hermes Desk UI polish batch. |
| [Improvement Loop (2026-10-12)](hermes-desk-improvement-loop-2026-10-12.md) | **Verification Log** | Detailed test receipts and test runs from the October 12 improvement cycle. |
| [Hermes Capability Improvement Ledger](hermes-capability-cycles-2026-10-11.md) | **Verification Log** | Verification receipts for Hermes tool invocation capabilities, profile switches, and recovery handling. |
| [Priority Remediation (2026-10-14)](priority-remediation-2026-10-14.md) | **Verification Log** | Verification report for high-priority UI and state-management bug fixes. |
| [Media Follow-Up Evidence](media-follow-up-evidence-2026-10-12.md) | **Test Receipt** | Evidence receipts for native file selection, media imports, and large file streaming. |
| [Video Playback Evidence](video-playback-evidence-2026-10-12.md) | **Test Receipt** | Verification suite for native video player integration, codec support, and IPC streaming. |
| [UI Refinement Evidence](ui-refinement-evidence-2026-10-11.md) | **Test Receipt** | UI refinement acceptance report: modal keyboard trapping, hover label alignment, and theme switching. |
| [Hover Label Polish](hover-label-polish-2026-10-11.md) | **Test Receipt** | Verification notes and visual audit for tooltips and hover labels. |
| [Agent Two Compaction Review](agent-two-compaction-review-2026-10-11.md) | **Benchmark Report** | Performance review and memory benchmarks for context compaction and message history cleanup. |
| [Compaction Recovery Receipt](agent-two-compaction-recovery-2026-10-11.json) | **Benchmark Data** | Quantitative JSON benchmark recording memory recovery metrics during agent compaction. |
| [Memory Optimization Benchmark](agent-two-memory-optimization-benchmark-2026-10-11.json) | **Benchmark Data** | First-pass memory benchmark data capturing heap allocation across agent conversation lengths. |
| [Memory Third-Pass Benchmark](agent-two-memory-third-pass-benchmark-2026-10-11.json) | **Benchmark Data** | Third-pass optimization data validating reduced heap retention during concurrent tool execution. |
| [Memory Live Receipt](agent-two-memory-third-pass-live-receipt-2026-10-11.json) | **Benchmark Data** | Live session memory consumption telemetry validating stability under load. |
| [Compaction Fixes Patch](agent-two-hermes-compaction-fixes-2026-10-11.patch) | **Code Patch** | Git patch recording critical compaction fix implementation for the Hermes agent engine. |
| [Uniichat Optimizations Patch](agent-two-uniichat-optimizations-2026-10-11.patch) | **Code Patch** | Git patch containing rendering optimization diffs for the Uniichat chat component. |
| [Educated Route Implementation](plans/2026-10-08-educated-route-implementation.md) | **Verification Log** | Evidence-led implementation follow-up verifying route selection stability. |
| [Fable 5 Second Opinion](plans/2026-10-08-fable-5-second-opinion.md) | **External Audit** | Independent external code audit and UX review evaluating codebase robustness and ergonomic gaps. |
| [Fable 5 Improvement Plan](plans/2026-10-08-fable-5-improvement-plan.md) | **Action Plan** | Actionable engineering plan addressing findings raised in the Fable 5 second-opinion review. |
| [Overnight Final Summary (2026-10-06)](overnight/2026-10-06-final-summary.md) | **QA Summary** | Summary of automated overnight test batch runs, passing suites, and remaining gaps from October 6. |
| [Overnight Improvement Log (2026-10-06)](overnight/2026-10-06-improvement-log.md) | **QA Log** | Detailed log of automated test iterations and iterative fixes applied during the October 6 batch. |
| [Overnight Improvement Prompt (2026-10-06)](overnight/2026-10-06-improvement-prompt.md) | **Test Prompt** | Standardized prompt configuration used to drive the October 6 autonomous testing run. |
| [Overnight Final Summary (2026-10-08)](overnight/2026-10-08-final-summary.md) | **QA Summary** | Final delivery and verification summary from the October 8 automated improvement batch. |
| [Overnight Improvement Log (2026-10-08)](overnight/2026-10-08-improvement-log.md) | **QA Log** | Detailed execution log of automated UI and stability repairs executed on October 8. |
| [Overnight Improvement Prompt (2026-10-08)](overnight/2026-10-08-improvement-prompt.md) | **Test Prompt** | Execution rubric and instructions guiding the October 8 autonomous test execution. |
| [Session Errors Follow-up](overnight/2026-10-08-followup-session-errors.md) | **Test Receipt** | Investigation and fix receipts for session restoration failures and IPC timeout errors. |
| [Continuous Improvement Prompt](prompts/hermes-desk-loop.md) | **Automation Rubric** | Bounded prompt template for running continuous, evidence-led quality improvement cycles. |
| [Small-Gap Improvement Prompt](prompts/hermes-desktop-small-gap-loop.md) | **Automation Rubric** | Prompt template focused on diagnosing and fixing isolated, small-surface UI and styling regressions. |
| [Bounded Improvement Loop Prompt](prompts/hermes-desk-improvement-loop-2026-10-12.md) | **Automation Rubric** | Structured prompt driving the October 12 multi-pass quality improvement loop. |
| [Loop Ledger](loop-ledger.md) | **Master Ledger** | Master tracking ledger recording historical iterations, automated test sweeps, and remediation cycles. |

---

### 8. Historical Audits & Superseded Ledger (Nub era / Archive)
Historical documentation, superseded plans, legacy Nub Agent cloud features, and retired mobile/web builds.

| Document | Status | Description |
|---|---|---|
| [Nub-Era Canonical CORS Fix Plan](archive/nub-era/PLAN.md) | **Archived** | Canonical plan for resolving web-pairing CORS issues on `hermes-deploy` during the Nub Agent era. |
| [Nub-Era Safe Batch Plan](archive/nub-era/PLAN-next.md) | **Archived** | Triage ledger and orchestration plan for executing safe batch repairs on legacy Nub infrastructure. |
| [Dashboard Fold-In Spec](DASHBOARD_FOLD_IN_SPEC.md) | **Superseded** | Plan retiring external `maiavm.com` dashboard pages and embedding settings natively into the desktop app. |
| [Reverse-Engineering UX Map](REVERSE_ENGINEERING.md) | **Archival Research** | Early reverse-engineering maps of proprietary agent interfaces, establishing UX component taxonomies. |
| [Webapp Optimization Plan](WEBAPP_PLAN.md) | **Superseded** | Early roadmap for optimizing a browser-only web client build before the pivot to native desktop. |
| [Webapp Improvement Audit](webapp-improve-2026-08-29.md) | **Archived Audit** | Read-only audit and ranking of findings for the legacy hosted web client (`agent-nub-lol.vercel.app`). |
| [Sidebar Desktop UX (Nub Era)](plans/2026-09-16-sidebar-desktop-ux.md) | **Superseded** | UI specification for legacy sidebar interactions in the older Nub Agent desktop client. |
| [Hermes Desk Redesign Plan](hermes-desk-ui-ux-redesign-plan-2026-10-07.md) | **Superseded Plan** | Original UI/UX audit and comprehensive proposal that initiated the transition from Nub Agent to Hermes Desk. |
| [Hermes Desk Redesign Delivery](hermes-desk-ui-ux-redesign-delivery-2026-10-07.md) | **Delivery Receipt** | Formal sign-off and delivery receipt confirming completion of the initial Hermes Desk redesign. |
| [Hermes Desk UX Review](plans/hermes-desk-ux-review.md) | **Design Review** | Evaluative UX review analyzing early desktop wireframes, navigation flow, and agent profile cards. |
| [Windows ZIP Extraction Plan](WIN_ZIP_INVALID_PLAN.md) | **Bugfix Spec** | Investigation and packaging fix plan resolving Windows Explorer zip extraction corruption errors. |
| [macOS Distribution Workaround](no-apple-developer-account.md) | **Distribution Guide** | Procedures for ad-hoc signing, quarantine removal (`xattr -dr`), and distribution without an Apple Developer ID. |
| [Google Play Console Deployment](play-store.md) | **Archived Guide** | Release checklist and deployment guide for the legacy Nub Agent Android companion app. |
| [Android Splashscreen Plan](splashscreen-plan.md) | **Archived Spec** | Design specification for Android cold-start splash screens featuring the legacy Nub mascot. |
| [Platform Cost Reduction](platform-cost-reduction.md) | **Infrastructure Plan** | Cost optimization study detailing Vercel Active CPU and Upstash Redis quota reductions for the cloud tier. |
| [Campaign Composer Plan](MARKETING_COMPOSER_PLAN.md) | **Retired Feature** | Architecture and compiler specification for the retired Grokorb automated campaign composer. |

---

## Supplementary Directories & Visual Artifacts

In addition to markdown specifications, the `docs/` tree contains supporting visual test benches, media archives, and automated test output:

- **`docs/blueprint/`**: Contains interactive HTML harnesses (`mascot-blueprint.html`, `nub-mobile-blueprint.html`) and associated visual progression media (`blueprint/media/`) illustrating before-and-after UI milestones and mascot capture runs.
- **`docs/brand/`**: Contains official vector and raster artwork (`nub-agent-banner-1920.jpg`, `og-image.html`) and asset export specifications.
- **`docs/readme/`**: Source images, state pose diagrams, palette charts, and architectural illustrations embedded in the top-level repository `README.md`.
- **`docs/play-store/`**: Icons, feature graphics, app screenshots, and signature certificates associated with Android releases.
- **`docs/overnight/`**: Automated QA run artifacts, including standalone Node/Playwright test runners (`.mjs`), raw test execution logs (`.txt`), and structured test suite reports (`report.json`).

---

## Documentation Maintenance Guidelines

To maintain documentation integrity across the Hermes Desk project:
1. **Always Use Relative Links**: All document links must use relative file paths so they resolve correctly across local checkouts, IDE markdown previews, and git web viewers.
2. **Document Status**: When adding or updating specifications, clearly record the document status (e.g., `Active Spec`, `Implemented`, `Superseded`, or `Archival Report`) at the top of the file.
3. **No Spec Deletions**: Historical audit reports, red-team assessments, and superseded plans should be preserved as permanent architectural ledgers rather than deleted.
4. **Link Back to the Index**: When creating new feature plans in `docs/plans/` or security assessments, ensure they are indexed in this `docs/README.md`.
