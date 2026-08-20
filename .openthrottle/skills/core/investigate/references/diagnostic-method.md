# Diagnostic method

Use this ladder when a defect is intermittent, crosses subsystem boundaries, or
survives the first two causal hypotheses.

## 1. Reproduce and minimize

Capture the symptom exactly: message, exit status, wrong value, or state left
behind. When it is intermittent:

- repeat under measurement to establish a rate;
- vary one condition at a time, such as data, concurrency, or network access;
- compare isolated and suite execution for order pollution; and
- reduce the input and setup until removing one more element makes the failure
  disappear.

If it never reproduces, list what ran, which conditions were unavailable, and
what substitute evidence supports the hypothesis.

## 2. Isolate the failing boundary

Confirm runtime, dependencies, configuration, and generated state first. Then
trace backward from the symptom. Open each stack frame and find the earliest
point whose input is already wrong. Observe values on both sides of that
boundary until valid input becomes invalid output.

For cross-system paths, list every boundary from trigger to symptom and capture
what enters and leaves each one in the same run. The first mismatch identifies
the subsystem in which backward tracing should continue.

Check recent history for the implicated files. If instrumentation makes the
problem vanish, treat that as timing or ordering evidence and prefer buffered
or post-mortem observation.

## 3. Prove the cause

Write down every “this must be true” assumption and mark it observed or
assumed. Ground each hypothesis in a captured value, branch, log entry, or
behavioural difference.

Build a complete chain from trigger through each transformation to the symptom.
For an uncertain link, predict an independent observable that must hold if the
link is real. A successful change with a false prediction repaired a symptom,
not the established cause.

After several failed hypotheses, diagnose the pattern:

| Pattern | Interpretation | Next move |
| --- | --- | --- |
| Hypotheses land in unrelated systems | The design boundary may be wrong | Explain the conflict |
| Evidence contradicts itself | The execution model is wrong | Re-read from the entry point |
| Local pass and remote failure | The environment difference is causal | Compare versions, data, and ordering |
| A fix works but its prediction fails | The symptom moved | Continue tracing |

Check common classes before deeper instrumentation: time zones, encoding,
floating point, numeric boundaries, off-by-one errors, stale caches,
permissions, dependency drift, path case sensitivity, concurrency, and
check-then-use races.

## 4. Meet the evidence bar

Before calling the diagnosis complete, confirm all of these:

- the symptom was observed rather than paraphrased;
- the causal construct is named by path and stable symbol;
- the trigger-to-symptom chain has no unexplained jump;
- at least one link is backed by an observed value;
- uncertain links have predictions and recorded outcomes;
- the missing or inadequate test is identified; and
- any applied fix has a regression check that fails before and passes after.
