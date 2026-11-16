# Security Policy

Forge is a software engineering agent that can execute filesystem writes and shell commands. Please keep auth and policy enforcement enabled.

## Supported Versions

Security fixes are handled on `main`. Use the latest commit.

## Deployment Guidance

- Review `forge.policy.yaml` before running in any environment. The deny-by-default policy is your primary control — understand what you are allowing before granting broad filesystem or shell access.
- Every tool call is checked against the policy (`policy/check.ts`) immediately before it runs: allow, ask the user, or deny.
- Keep API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) out of version control. Use `.env` files or environment variable injection.
- The `.forge/` directory contains the append-only event and audit logs. Do not delete it unless you intend to reset the system model.
- Treat `agent/loop.ts` and `policy/check.ts` as the trust boundary — no other code path should run a tool. The shell check reads the command text; it is not a sandbox.

## Publishing A Fork

Before pushing a public fork, run:

```bash
git check-ignore -v .env
git grep -n -I -E "(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})" -- . ':!package-lock.json'
```

Never commit live API keys, tokens, or private configuration.

## Reporting

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/TushaeBXN/anthos-engineer/security/advisories/new). Do not open a public issue for security vulnerabilities.
