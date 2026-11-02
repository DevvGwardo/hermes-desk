# Security policy

Hermes Desk is a local-only macOS app: it runs on your machine, talks to
`hermes serve` over loopback, and keeps agent tokens in the Electron main
process. There is no hosted service, account or backend to attack, so the
interesting surface is the desktop app itself — the preload bridge, the renderer
sandbox, filesystem and VM path boundaries, the plugin host, and anything that
turns agent output into something executable or navigable.

## Reporting

Please report vulnerabilities privately, not in a public issue:

- GitHub Security Advisories: **Security → Report a vulnerability** on this
  repository (preferred — it gives us a private thread and a CVE path).
- Or email `torreykimbrough@gmail.com` with "hermes-desk security" in the
  subject.

Include the version (`package.json`), macOS version, what you did, and what
happened. A reproduction beats a theory; if it needs a live Hermes backend, say
so and describe the setup.

What to expect: an acknowledgement within a few days, an assessment with a
severity call, and credit in the advisory unless you ask otherwise. This is a
single-maintainer project, not a funded security team — please don't publish a
working exploit before we've had a chance to ship a fix.

## Supported versions

Only `main` is supported. The project is at `0.1.0` and has no release channel
yet, so fixes land on `main` and nowhere else. Older commits, the `archive/*`
branches and third-party forks are not maintained.

## Scope notes

- **In scope:** auth/token handling in the main process, IPC and preload
  boundary escapes, `file://`/`vmPath` traversal, plugin trust and auto-load
  rules, sandbox and CSP weaknesses, prompt-injection paths that reach a
  privileged tool, and anything that lets agent output execute code.
- **Out of scope:** findings that require the attacker to already own your
  macOS user account or your `~/.hermes` directory, model-quality issues, and
  dependency advisories with no reachable path in this app (open a normal issue
  for those — `npm audit` output is already tracked in
  `docs/hermes-desk-gap-spec-2026-10-25.md`).

## For contributors

Never commit credentials, tokens, keys or real session data. The repository
runs a secret scan on pull requests, and the local pre-commit hook checks
staged changes; both are backstops, not permission to be careless. Fixtures
must use obviously synthetic values (`FAKE`, `test-token`) and the E2E harness
only ever talks to a fake local model.
