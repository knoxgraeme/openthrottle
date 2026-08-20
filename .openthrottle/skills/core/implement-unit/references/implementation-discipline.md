# Implementation discipline

Use this deeper method for behaviour-bearing units and focused repairs.

## 1. Read before writing

Orient in this order:

1. Read the files named by the task, including each enclosing construct.
2. Find the nearest existing example of the pattern being added or changed.
3. Find the tests that already own the behaviour.

Note the local conventions for layout, imports, errors, naming, configuration,
and tests. Prefer the nearest consistent pattern over personal defaults.

## 2. Work in coherent increments

Change one behaviour at a time. Two changes that must move together to keep the
tree coherent are one increment; two that merely share a file are not. A useful
increment can be described in one sentence about behaviour rather than a list
of files.

## 3. Discover the test seam

Search for tests that import the implementation, share its name, mirror its
path, or exercise its public entry point. Prefer, in order:

1. Extend a test that already owns the contract.
2. Correct an expectation the requested change makes obsolete.
3. Strengthen a test that currently passes whether the behaviour works or not.
4. Add a new test only when no existing test is the right home.

When no practical automated seam exists, state why and choose a concrete
replacement check.

## 4. Complete the scenarios

For each behaviour change, cover the categories that apply:

- **Normal path:** the primary input and observable output.
- **Boundaries:** empty, absent, zero, one, first, last, and maximum values
  where they have distinct meaning.
- **Failures:** validation, permission denial, downstream failure, and retry.
- **Integration:** a real path across interacting layers without replacing the
  components whose interaction is under test.

Skip a category deliberately only when the behaviour has no such case.

## 5. Trace two levels out

Read the code that runs immediately before and after the change:

- lifecycle hooks, middleware, subscribers, and cache invalidation;
- partial writes, locks, files, or queue entries left by mid-way failure;
- retries and fallbacks that may duplicate or hide work;
- alternate entry points and re-exports; and
- error types expected by the layer above.

A leaf change with no hooks, durable state, or alternate entry point needs only
a quick confirmation that none of these paths apply.

## 6. Verify as you go

After each meaningful edit, run the narrowest real check: a single test case,
test file, focused type check, or direct invocation. Record what actually ran
and what actually happened. A claimed check that never ran is worse than an
explicit verification gap.

## 7. Repair from evidence

Before a repair edit, name the failure from the strongest available source:
captured failure output, the prior attempt's diagnostic evidence, or a fresh
focused reproduction. Read the first causal error rather than the last summary
line.

Once the failure is established:

- fix the cause instead of suppressing the symptom;
- change one hypothesis at a time;
- rerun the exact failing check, then nearby checks;
- add the regression test that would have caught a behavioural defect; and
- keep the repair narrower than the change it repairs.

If no available evidence yields a concrete failure, stop guessing and state
what information is missing.

## 8. Shortcut warnings

Pause when any of these appears:

- a proposed fix before the cause is stated;
- “it works now” without a causal explanation;
- confidence based only on a familiar pattern rather than the local code;
- several changes made to test one hypothesis; or
- scope widening because a broad rewrite is easier than a precise fix.
