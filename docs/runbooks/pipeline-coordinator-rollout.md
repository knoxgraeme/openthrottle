# Pipeline coordinator POC acceptance

OpenThrottle is a pre-production proof of concept with no installed consumer
population. Every newly delegated generation therefore uses the configurable
pipeline coordinator. There is no repository cohort, consumer-drain period, or
production soak gate.

## Required local evidence

Before merging a coordinator change, record:

1. Supervisor and CLI typecheck/build/test results.
2. Sandbox unit, Bats, image build, and stub-agent lifecycle smoke results.
3. A local CE code review of the complete branch diff, with valid findings
   fixed and regression-tested.
4. The exact catalog, runtime descriptor, and migration checksums shipped by
   the branch.

## Deferred credentialed acceptance

The live Linear → Fly → Daytona → GitHub exercise is optional for this POC and
must be explicitly authorized because it consumes operator credentials. When
run, use one registered test repository/team and capture:

- pipeline selection and immutable manifest/config/runtime evidence;
- a fenced semantic or command stage result;
- PR creation and exact-subject provider evidence;
- one failed review/check repair through the same native session;
- a GitHub Issue control-thread delegation by an authorized repository actor,
  proving the Issue-to-PR path without exposing Fly, Daytona, install, webhook,
  supervisor, or operator-only credentials to the sandbox;
- exact PR merge settlement and Issue close settlement observed in both orders
  on equivalent fixtures: merge then close, and close then merge, with a single
  monotonic terminal outcome and no reopened actor;
- webhook delivery recovery: force one failed GitHub webhook delivery, run hook
  reconciliation, and confirm it is requeued once and then processed exactly
  once after the handler succeeds;
- terminal Linear acknowledgement and sandbox cleanup.

Skipping this exercise is a documented verification gap, not a reason to add
an inactive alternate execution cohort.

## Failure handling

- Selection failure: keep the ticket unprovisioned and publish the actionable
  error.
- Runtime or subject-fence failure: stop the actor, quarantine the resource if
  termination cannot be confirmed, and retain the durable evidence.
- An accepted operator stop returns `202 stop_requested` until the durable stop
  effect confirms termination; only then does it return `200 stopped`.
- `/status` and ticket log headers expose outstanding/dead effect state and
  publication error/recovery fields for operator diagnosis.
- Publication failure: leave the receipt retryable or publication-blocked and
  use the operator retry endpoint after correcting the cause.
- Schema/runtime incompatibility: do not deploy the incompatible revision;
  restore the POC database snapshot if one exists.

Destructive schema contraction remains a separate change. Historical columns
may remain as migration scaffolding, but they do not gate or
route new work.
