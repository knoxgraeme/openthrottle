# Pipeline coordinator POC acceptance

OpenThrottle is a pre-production proof of concept with no installed consumer
population. Every newly delegated generation therefore uses the configurable
pipeline coordinator. There is no repository cohort, legacy-drain period, or
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
- terminal Linear acknowledgement and sandbox cleanup.

Skipping this exercise is a documented verification gap, not a reason to add
an inactive legacy execution cohort.

## Failure handling

- Selection failure: keep the ticket unprovisioned and publish the actionable
  error.
- Runtime or subject-fence failure: stop the actor, quarantine the resource if
  termination cannot be confirmed, and retain the durable evidence.
- Publication failure: leave the receipt retryable or publication-blocked and
  use the operator retry endpoint after correcting the cause.
- Schema/runtime incompatibility: do not deploy the incompatible revision;
  restore the POC database snapshot if one exists.

Destructive schema contraction remains a separate change. The current legacy
columns may remain as historical migration scaffolding, but they do not gate or
route new work.
