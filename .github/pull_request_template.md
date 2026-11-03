## Description

<!-- Describe the changes introduced by this pull request. Explain the motivation and context behind the change. -->

## Related Issues

<!-- Link related issues, e.g. Fixes #123, Closes #456. -->
Closes #

## Type of Change

- [ ] `fix`: Bug fix (non-breaking change which fixes an issue)
- [ ] `feat`: New feature (non-breaking change which adds functionality)
- [ ] `perf`: Performance enhancement
- [ ] `refactor`: Code refactoring without behavioral changes
- [ ] `docs`: Documentation updates or additions
- [ ] `test`: New or updated tests / test harness improvements
- [ ] `ci` / `chore`: CI workflow, build script, or dependency update
- [ ] **BREAKING CHANGE**: Any change that alters existing interfaces, schemas, or stored state formats

## Areas Impacted

- [ ] Multi-Agent Workspace & Shared Rooms
- [ ] Local Chat, Composer & Rendering (Markdown, KaTeX, Mermaid)
- [ ] Native Browser Lanes & Generated UI (`render_ui`)
- [ ] Pip Mascot Rig, Palettes & Motion Engine
- [ ] Electron Main Process, Preload IPC & Process Lifecycle
- [ ] Security Boundaries & Filesystem Guards (`fs-guard.cjs`)
- [ ] Build System, Packaging (`install:local`) & Tooling
- [ ] Documentation (`README.md`, `CONTRIBUTING.md`, etc.)

## How Has This Been Tested?

<!-- Describe the tests you ran to verify your changes. Include commands executed and any specific setup. -->

- [ ] TypeScript & syntax checks: `npm run lint`
- [ ] Unit test suite: `npm run test:unit`
- [ ] Electron test suite: `npm run test:electron`
- [ ] End-to-end / integration harnesses (e.g. `npm run test:rooms`, `npm run test:genui`, `npm run test:runtime`)
- [ ] Manual verification in local desktop app (`npm run dev:local`)

<!-- If your changes affect the UI or Pip mascot, please attach before/after screenshots or GIFs. -->

## Contributor Checklist

- [ ] My code adheres to the project's standards outlined in [CONTRIBUTING.md](CONTRIBUTING.md).
- [ ] Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) convention (e.g., `feat(workspace): ...`, `fix(a11y): ...`).
- [ ] `npm run lint` passes without errors (types and Node syntax checks clean).
- [ ] All new and existing tests pass (`npm run test:run`).
- [ ] New unit or integration tests have been added where appropriate, with boundary/mutation coverage considered.
- [ ] **No credentials or secrets:** Verified that no API keys, private tokens, or live credentials are included.
- [ ] Documentation and [CHANGELOG.md](CHANGELOG.md) have been updated if this introduces user-facing changes.
