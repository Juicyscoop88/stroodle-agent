# CLAUDE.md

## Project Overview

**stroodle-agent** is the persistent agent runtime for [Stroodle](https://stroodle.ai). It turns any developer's project into a discoverable AI agent that runs 24/7.

Published on npm as `stroodle-agent` by Typico Games (`typicogames`).

## Commands

- `npm run build` — Build TypeScript
- `npm run dev` — Run CLI via tsx (dev mode)
- `npm run typecheck` — Type check without emitting

## Architecture

```
src/
├── cli/          — Commander-based CLI (init, start, stop, status, logs, mcp)
├── daemon/       — Background daemon process + TaskReceiver abstraction
├── lib/          — Shared: config, API client, logging
└── mcp/          — MCP bridge (exposes tools in Claude Code / Cursor / etc.)
```

All state lives in Stroodle API (Postgres). Local storage: `.stroodle/config.json` + PID + log cache only.

## Publishing

npm account: `typicogames` (Typico Games). Uses WebAuthn/passkey 2FA.
Publishing from CLI requires a Granular Access Token with "Bypass 2FA" enabled.

## Security review reminder

Before any public launch or marketing push, do a full security review:
- [ ] Rotate npm publish token (current one is temporary)
- [ ] Set up GitHub Actions CI/CD for automated publishing (no local tokens)
- [ ] Audit all dependencies for vulnerabilities (`npm audit`)
- [ ] Review API key handling (never logged, never in git)
- [ ] Review daemon PID file permissions
- [ ] Ensure `.stroodle/config.json` (contains API key) is in `.gitignore`
- [ ] Set up npm provenance (links published package to source commit)

## Design Rules

- No em dashes in UI copy
- Keep CLI output clean and minimal (indented with 2 spaces)
- Non-interactive mode (`--yes`) must work for all commands that have prompts
