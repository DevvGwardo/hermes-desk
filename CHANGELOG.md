# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Standardized open-source contributor documentation and community governance (`CONTRIBUTING.md`, `CHANGELOG.md`).
- Structured GitHub issue forms for bug reports and feature proposals, plus issue configuration and pull request template.

---

## [0.1.0] - 2026-11-02

### Added
- **Initial Public Release of Hermes Desk** — a local-first macOS desktop application for running and orchestrating Hermes autonomous agents.
- **Multi-Agent Workspace**:
  - Shared collaborative rooms enabling multiple specialist agents to converse and collaborate in a unified thread.
  - Chief coordinator workflow synthesizing cross-agent debate, delegate tasks, and settle action items.
  - Independent session isolation per room member with dedicated approval queues and `@mention` routing.
  - Per-human token budget limits (initially 64,000 tokens) with interactive pause and resume controls to avoid runaway model costs.
  - Durable native room state persistence stored in `local-rooms.json` within the Electron application data directory.
- **Local Chat Experience**:
  - Direct 1-on-1 conversations with local Hermes agent profiles over loopback.
  - Rich streaming Markdown rendering with GitHub Flavored Markdown (GFM), math equations via KaTeX, and structural diagrams via Mermaid.
  - Persistent composer state that preserves message drafts and file attachments across crashes, reconnects, and agent switches.
  - Chat model and profile configuration inspector with copyable CLI commands and live provider route diagnostics.
- **Native Browser Lanes**:
  - Agent-guided sidecar browser lanes enabling web research, verification, and inspection directly beside the conversation.
  - Bounded Generated UI (`render_ui`) protocol delivering validated, data-only interactive cards (`stat`, `table`, `bar_chart`, `checklist`) without arbitrary HTML, JavaScript, or remote asset loading.
- **HUD Mascot (Pip the Courier Owl)**:
  - Custom SVG character rig featuring Pip the courier owl in his winged helmet and messenger satchel.
  - Six native activity state poses reflecting agent runtime execution: ready, thinking, using tools, browsing, waiting with a letter, and resting.
  - Six built-in palette themes: blue (maia), sage, iris, honey, mint, and rose.
  - Full support for `prefers-reduced-motion` and accessibility profiles.
- **Sandboxed Tools & Local-First Security**:
  - Zero cloud dependencies, external telemetry, or analytics tracking — all conversations and tokens remain on your Mac.
  - Secure credential containment: API keys, bearer tokens, and credentials remain strictly inside the Electron main process and never reach renderer code.
  - Loopback-only authenticated process spawning and verification for `hermes serve`.
  - Comprehensive filesystem access guard (`fs-guard.cjs`) enforcing canonical realpaths, symlink defense, and directory containment.
  - Local Model Context Protocol (MCP) server integration (`mcp__hermes_desk__render_ui`).
- **Developer Tooling & Testing Infrastructure**:
  - Multi-project Vitest testing framework (`unit` for React components/hooks and `electron` for Node/IPC bridges).
  - Isolated End-to-End test harness running against a local fake-model server for zero-cost, deterministic verification.
  - Automated local build and install workflow (`npm run install:local`) deploying to `/Applications/Hermes Desk.app`.
