# Contributing to Hermes Desk

Welcome to Hermes Desk! We are thrilled you want to help make Hermes Desk the premier local-first desktop workspace for autonomous agents on macOS.

This document outlines how to set up your local development environment, run the test suites, follow our code standards, and submit pull requests.

---

## Table of Contents

1. [Project Overview & Architecture](#project-overview--architecture)
2. [Prerequisites & Development Setup](#prerequisites--development-setup)
3. [Running and Building the App](#running-and-building-the-app)
4. [Testing & Verification](#testing--verification)
   - [Vitest Suites (Unit & Electron)](#vitest-suites-unit--electron)
   - [End-to-End & Integration Probes](#end-to-end--integration-probes)
   - [Test Isolation & Fake Models](#test-isolation--fake-models)
5. [Code Style & Standards](#code-style--standards)
   - [TypeScript & Type Checking](#typescript--type-checking)
   - [Linting & Node Syntax Checks](#linting--node-syntax-checks)
   - [ESLint Rules](#eslint-rules)
   - [Security & Architectural Boundaries](#security--architectural-boundaries)
6. [Git Conventions & Pull Request Guidelines](#git-conventions--pull-request-guidelines)
   - [Branch Naming](#branch-naming)
   - [Conventional Commits](#conventional-commits)
   - [Pull Request Checklist](#pull-request-checklist)
   - [CI Workflows](#ci-workflows)
7. [Reporting Issues & Security](#reporting-issues--security)

---

## Project Overview & Architecture

Hermes Desk is a local-only macOS desktop application designed to interact with Hermes agents running on your machine. Built with Electron, React, Vite, and Tailwind CSS, it connects to a local `hermes serve` instance over loopback.

Key architectural boundaries:
- **Local-first & privacy preserving:** No cloud telemetry, external tracking, or remote phone-home services.
- **Token isolation:** All model provider credentials, authentication tokens, and keys stay in the Electron main process and are never exposed to the renderer context.
- **Secure sandbox:** Preload IPC bridges strictly validate channels and arguments; file access is validated via path boundaries (`fs-guard.cjs`).
- **Bounded UI:** Custom agent visualizations (Generated UI) are strictly data-driven without arbitrary HTML, JavaScript, or external web asset execution.
- **Pip Mascot:** Pip the courier owl provides native visual feedback for agent presence and tool execution states.

---

## Prerequisites & Development Setup

Before contributing, verify your system meets the requirements:

1. **Operating System:** macOS (macOS 13+; Apple Silicon arm64 recommended; Intel supported in development).
2. **Node.js:** Node.js 22 LTS (recommended: `v22.x`) and `npm` 10+.
3. **Hermes CLI & Python Runtime:**
   - A trusted installation of Hermes CLI (`hermes`) accessible on your `$PATH` or located at `~/.hermes/hermes-agent/venv/bin`.
   - Python 3.11+ virtual environment containing the Hermes dependencies.

### Installation Steps

1. Clone the repository:
   ```sh
   git clone https://github.com/DevvGwardo/hermes-desk.git
   cd hermes-desk
   ```

2. Install dependencies:
   ```sh
   npm ci
   ```

---

## Running and Building the App

### Local Desktop Development

Launch the Electron application in local development mode:
```sh
npm run dev:local
```
*(Alias: `npm run electron:dev`)*

This script:
1. Spawns an isolated `hermes serve` on an available loopback port starting from `9120`.
2. Starts the Vite development server for the React UI with Hot Module Replacement (HMR).
3. Launches Electron and connects securely to the local backend.

### Web Renderer Only

To iterate purely on renderer UI components without launching Electron or the backend:
```sh
npm run dev
```
Open `http://localhost:5173` in your browser. (Note: Features requiring native Electron bridges or Hermes IPC will be stubbed or unavailable.)

### Production Build & Local Install

To produce a production build and install it to `/Applications/Hermes Desk.app`:
```sh
npm run build           # Build renderer assets (Vite + TypeScript)
npm run electron:build  # Compile Electron bundle
npm run install:local   # Package and install to /Applications (backs up existing install)
```

---

## Testing & Verification

We maintain comprehensive automated test coverage across renderer components, Electron main processes, IPC bridges, and end-to-end integration flows.

### Vitest Suites (Unit & Electron)

Hermes Desk uses [Vitest](https://vitest.dev/) with two primary project configurations:

- **Unit tests (Renderer & Lib):**
  ```sh
  npm run test:unit
  ```
  Runs tests in a `jsdom` environment covering React components, hooks, formatting utilities, and UI state.

- **Electron tests (Main & Node scripts):**
  ```sh
  npm run test:electron
  ```
  Runs tests in a `node` environment covering IPC bridges, file guards, socket ownership, and background process management.

- **Full test suite:**
  ```sh
  npm run test:run
  ```

- **Coverage check:**
  ```sh
  npm run test:coverage
  ```
  Measures V8 test coverage against established thresholds (minimum 70% lines, 60% branches).

### End-to-End & Integration Probes

Integration tests verify multi-agent workflows, room dynamics, and error recovery:

| Command | Purpose |
| --- | --- |
| `npm run test:e2e` | End-to-end golden path running against an isolated fake-model server. |
| `npm run test:rooms` | Multi-agent shared room tests: specialist turns, Chief wrap, DM isolation, and token budget pauses. |
| `npm run test:genui` | Validates bounded Generated UI (`render_ui`) schema adherence and sanitization. |
| `npm run test:runtime` | Production renderer stability under repeated chat, switches, and mock clipboard interactions. |
| `npm run test:runtime:dev` | Same runtime checks executed with React development diagnostics enabled. |
| `npm run test:hover` | Verifies message hover geometry and keyboard accessibility at multiple viewports. |
| `npm run test:all-e2e` | Sequential execution of all specialized E2E probes. |

### Test Isolation & Fake Models

Integration tests are designed to be completely safe and cost-free:
- **No real API requests:** Tests execute against a local loopback fake model server (`tests/fake-model/`), avoiding any model provider API consumption or token costs.
- **Sandbox containment:** The test harness utilizes temporary directories and temporary profiles; your personal `~/.hermes` configuration and active chats are never modified.
- **Custom runtime source:** You can override the Hermes backend path under test with the `HERMES_E2E_SOURCE` environment variable:
  ```sh
  HERMES_E2E_SOURCE=/path/to/hermes-agent npm run test:rooms
  ```

---

## Code Style & Standards

### TypeScript & Type Checking

- **Strict Mode:** TypeScript is configured with strict type safety across both frontend and backend (`tsconfig.app.json` and `tsconfig.electron.json`).
- **Explicit Types:** Avoid `any` or `as any`. Use discriminated unions, type guards, and narrow unknown data structures.
- **Run Type Checks:**
  ```sh
  npm run typecheck
  ```

### Linting & Node Syntax Checks

The primary lint check in Hermes Desk enforces strict typing and valid Node syntax:
```sh
npm run lint
```
This runs:
1. `npm run typecheck` — Full TypeScript type checks for renderer and Electron main process.
2. `npm run check:node` — Fast syntax parsing (`node --check`) for all tracked JavaScript, CommonJS, and ES module files across `electron/`, `scripts/`, `tests/`, and tooling.

### ESLint Rules

Advisory linting checks are configured in `eslint.config.mjs`:
```sh
npm run lint:advisory
```

Key linting practices:
- **Unused variables:** Intentionally unused variables or callback arguments must be prefixed with an underscore (e.g., `_event`, `_index`).
- **React Hooks:** Adhere strictly to the Rules of Hooks and exhaustive dependency declarations.
- **Security plugin:** Warnings from `eslint-plugin-security` highlight areas handling file paths and object lookups. Ensure file operations pass through runtime guard assertions (`fs-guard.cjs`).

### Security & Architectural Boundaries

Contributors must adhere to these non-negotiable security principles:
1. **Never commit secrets:** Never commit API keys, authentication tokens, passwords, or live session exports. Secret scanning and push protection are active on the repository.
2. **Main-process credential boundary:** The renderer process must never possess direct access to model credentials or local filesystem write permissions outside safe preloaded bridges.
3. **Filesystem path traversal prevention:** All file operations initiated via IPC must validate paths with `realpath`, boundary checks, and symlink guards (`fs-guard.cjs`).
4. **Content Sanitization:** Markdown and KaTeX rendering use strict HTML sanitization via `DOMPurify`. Never disable HTML sanitization or introduce raw `dangerouslySetInnerHTML` with untrusted agent output.

---

## Git Conventions & Pull Request Guidelines

### Branch Naming

Use descriptive branch names with appropriate prefixes:
- `feat/feature-name` (e.g., `feat/room-token-indicator`)
- `fix/bug-description` (e.g., `fix/transcript-auto-scroll`)
- `docs/documentation-topic` (e.g., `docs/add-plugin-guide`)
- `chore/task-name` (e.g., `chore/bump-deps`)
- `test/test-scope` (e.g., `test/mascot-motion-states`)

### Conventional Commits

We follow the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) specification. Each commit message must follow this structure:

```
<type>(<scope>): <short imperative summary>

[optional body explaining context, motivation, and solution]

[optional footer(s), e.g., Closes #123, BREAKING CHANGE: ...]
```

#### Commit Types
- `feat`: A new user-facing feature or enhancement.
- `fix`: A bug fix.
- `docs`: Documentation updates only.
- `style`: Changes that do not affect the meaning of the code (formatting, missing semi-colons, whitespace).
- `refactor`: Code changes that neither fix a bug nor add a feature.
- `perf`: Performance improvements.
- `test`: Adding or correcting tests.
- `ci`: Changes to CI/CD workflows and configuration scripts.
- `chore`: Maintenance tasks, dependency updates, build tooling.

#### Examples
- `feat(mascot): add resting state animation for Pip`
- `fix(a11y): improve keyboard navigation within room member list`
- `docs(contributing): document fake-model testing workflow`
- `test(electron): add socket ownership verification tests`
- `chore(deps): update framer-motion to 12.23.12`

Breaking changes should include `!` after the type/scope or declare `BREAKING CHANGE:` in the footer:
- `feat(ipc)!: replace legacy channel protocol with typed request-response schema`

### Pull Request Checklist

Before submitting a Pull Request, please ensure:
- [ ] Code compiles and typechecks cleanly: `npm run typecheck`
- [ ] Node syntax checks pass: `npm run check:node`
- [ ] Unit and Electron tests pass: `npm run test:run`
- [ ] Code style and formatting match project conventions
- [ ] Commit history follows Conventional Commits
- [ ] Documentation has been updated to reflect any user-visible changes or new options
- [ ] PR description clearly explains the **what**, **why**, and **how**, including reproduction steps for bug fixes or screenshots for visual changes

### CI Workflows

Our GitHub Actions CI runs in tiers to maximize efficiency:
- **Pull Requests (Ubuntu):** Runs a quick gate checking types, Node syntax (`npm run lint`), and tests affected by the diff (`vitest --changed`).
- **Nightly / Release Branches (macOS):** Runs the comprehensive macOS verification suite including full Vitest execution and renderer build.

---

## Reporting Issues & Security

- **Bug Reports:** If you discover a bug, please file a report using our [Bug Report Form](.github/ISSUE_TEMPLATE/bug_report.yml). Provide exact reproduction steps, macOS version, and relevant terminal/console logs.
- **Feature Requests:** Have an idea to improve Hermes Desk? Submit a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) with your proposal and rationale.
- **Security Vulnerabilities:** **DO NOT** report security vulnerabilities in public GitHub issues. Please review [SECURITY.md](SECURITY.md) and report privately via GitHub Security Advisories or by emailing `torreykimbrough@gmail.com`.

---

Thank you for contributing to Hermes Desk! Pip salutes you! 🦉
