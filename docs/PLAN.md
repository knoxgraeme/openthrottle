# OpenThrottle delivery plan

OpenThrottle's current delivery boundary is a filesystem-authored software
factory running on one durable execution kernel. The normative contracts are in
[`SPEC.md`](SPEC.md); detailed design history remains under [`plans/`](plans/).

## Product outcome

Given a registered Linear ticket or GitHub Issue and an exact repository
subject, OpenThrottle can:

1. choose and compile a pipeline plus its transitive definitions into one
   immutable DefinitionBundle;
2. compose each agent action from stable instructions, a sealed task prompt,
   and a selectively disclosed skill set;
3. execute ordinary or structured work through the same Attempt, Record,
   Effect, and Checkpoint primitives;
4. preserve completed code work when semantic output needs deterministic
   normalization or bounded result-only correction;
5. review exact accepted edits without making the review checkout writable;
6. run configured commands, integrate accepted structured units, publish the
   exact subject, reconcile provider evidence, and clean runtime resources;
7. expose status, logs, historical record metadata, stop/supersede control, and
   maintenance fencing through one bounded operator surface.

## Shipped architecture

- `.openthrottle/` is the authoring surface for config, instructions,
  pipelines, optional pipeline-local loops, skills, and evals.
- Pipeline is the only public orchestration concept. A compiled manifest is a
  private runtime artifact reconstructed from immutable bundle bytes.
- Agent instructions, task prompts, and skills have separate lifecycles.
  Skills retain native progressive disclosure for Claude, Codex, and OpenCode.
- `inspect` and `edit` are the only repository authorities. Review and planning
  receive an immutable exact-subject view; implementation and remediation
  receive an isolated writable content tree. The executor owns Git throughout.
- Agent output is a bounded ResultCandidate. Declared normalizations are
  recorded; unresolved schema errors enter `result_pending` and use the same
  native session for result-only correction.
- Ordinary and structured coordinators use the same kernel reducer and durable
  store. Structured work adds bounded frontier, dependency, acceptance, serial
  integration, and reviewer-persona planning over those primitives.
- External writes are write-ahead Effects with one idempotency key. The worker
  reconciles before writing and records confirmed or rejected delivery
  evidence.
- SQLite has one fresh twelve-table epoch. Immutable payloads above the inline
  bound use verified content-addressed blobs.
- Provider ingress is durably deduplicated. During maintenance it returns a
  retryable non-acknowledgement and persists nothing.
- The old dogfood installation is replaced once, offline. The runtime has no
  old-epoch read path, dual-write path, or durable replacement phase model.

## Acceptance gates

The release is accepted only when all of the following hold:

- Filesystem and exact-Git readers compile the same definition tree to the same
  canonical bytes and SHA-256 hash.
- A restarted supervisor reconstructs the same private manifest solely from the
  DefinitionBundle blob and release-sealed platform authority.
- An action cannot widen its skill set, eval, engine, repository authority,
  tools, MCP access, credentials, session policy, or exact input subject.
- Inspect actions cannot modify repository content, Git state, or remotes.
  Blocking findings create separate edit remediation Attempts.
- Edit actions cannot commit, push, publish, or supply authoritative checkpoint
  identity.
- An array-valued `payload.summary` normalizes deterministically; any remaining
  candidate error preserves the work checkpoint and enters bounded correction
  instead of rerunning work.
- Attempt transitions, records, checkpoints, cursor movement, and Effect
  scheduling commit atomically and remain deterministic after restart.
- Lost leases recover safely. Stale or conflicting events cannot settle another
  Attempt or native session.
- Effect retries reconcile known external state before writing and never replay
  an unknown mutation blindly.
- Ordinary and structured Docker proofs cover edit, inspect, commands,
  publication, provider wait, cleanup, restart, and large-blob verification.
- The offline replacement proof rejects live writers, unresolved resources,
  corrupt archives, nonempty fresh paths, and mixed release/storage identity;
  ordinary and structured smoke items pass before ingress reopens.

## Verification

```bash
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli
npm test --prefix contracts
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test
```

Live Linear, GitHub, Daytona, Fly, and model checks require operator credentials
and remain an explicit post-CI gate.

## Deferred work

- multi-tenant administration or a separate web UI;
- automatic mutation of definitions from historical analysis;
- offline evaluation and longitudinal skill-quality scoring;
- a remote blob backend if one Fly volume stops being sufficient;
- parallel Git integration of structured units;
- agent-owned commit, publication, merge, or scope-expansion authority;
- online epoch migration or preservation of abandoned dogfood work.
