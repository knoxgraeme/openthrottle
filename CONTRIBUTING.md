# Contributing to OpenThrottle

Thanks for helping improve OpenThrottle. Bug reports, focused fixes,
documentation corrections, and well-scoped design proposals are welcome.

## Before you start

- Read [AGENTS.md](AGENTS.md) for repository architecture and conventions.
- Read [docs/SPEC.md](docs/SPEC.md) before changing a contract.
- Open an Issue before large architectural changes so scope can be agreed
  before implementation.
- Report security issues privately using [SECURITY.md](SECURITY.md).

Node.js 22 is required. This repository has four independent npm projects and
no root `package.json`:

```bash
npm ci --prefix contracts
npm ci --prefix supervisor
npm ci --prefix cli
npm ci --prefix sandbox
```

## Validate a change

Run the checks relevant to your change. Before requesting review, run the full
non-live suite when practical:

```bash
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run build --prefix supervisor
npm run typecheck --prefix cli && npm run build --prefix cli
npm test --prefix contracts
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
bats sandbox/tests/inbox-drain.bats
```

The complete non-live image and harness proof is slower, but required before a
release and for changes to sandbox, supervisor-image, or execution boundaries:

```bash
docker build -f supervisor/Dockerfile -t openthrottle-supervisor:test .
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
node supervisor/scripts/kernel-sandbox-e2e.mjs openthrottle:test
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test
```

These local harnesses use stubbed or local boundaries. They do not prove live
exact-subject publication, trusted-producer GitHub provider wait, real
semantic-remediation efficacy, provider-backed terminal cleanup, or acceptance
of a Fly/SQLite epoch. Those boundaries are exercised by live dogfood and must
not be claimed from local harness results.

When correction or remediation behavior changes, test them separately: result
correction preserves the same Attempt, checkpoint, subject, and native session;
semantic remediation starts a distinct edit Attempt with an unbound fresh
session and exact prior evidence.

## Pull requests

Keep changes focused, add tests for behavior changes, and update the normative
specification when a contract changes. Pull requests should explain the user
impact, security implications, validation performed, and any remaining rollout
risk. Do not commit credentials, local agent configuration, generated `dist/`
content, databases, or `.env` files.
