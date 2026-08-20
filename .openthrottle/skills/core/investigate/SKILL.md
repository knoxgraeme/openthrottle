---
name: investigate
description: Use when reproducing a software defect, proving its root cause, and applying a convergent fix when intended behaviour is clear.
---

# Investigate a defect

Diagnose the reported behaviour from evidence. A useful investigation explains
the complete causal chain; a change that merely makes the symptom disappear is
not enough.

## Method

### 1. Reproduce

Run the failing test or smallest faithful reproduction and capture the actual
symptom: message, exit status, wrong value, or state left behind. If it does not
reproduce, record the attempts, environmental differences, and substitute
evidence. Label any unobserved failure as a hypothesis.

### 2. Isolate

Confirm runtime, dependencies, configuration, and generated state before
blaming code. Trace backward from the symptom to the first boundary where valid
state becomes invalid. Inspect actual values rather than inferred ones, compare
with a working path, and change one diagnostic variable at a time.

### 3. Prove the root cause

List the assumptions behind the leading explanation and mark them observed or
assumed. Build a gap-free chain from trigger through the changed construct to
the symptom. Where a link is uncertain, make a falsifiable prediction about a
different observable and check it.

After several failed hypotheses, reassess the model: contradictory evidence,
different environments, and hypotheses scattered across unrelated subsystems
each call for a different next step.

### 4. Explain

Name the causal construct by path and stable symbol, the evidence for each link,
the test that should have caught the problem and why it did not, and the repair
that closes the cause.

Read `references/diagnostic-method.md` for the full reproduction and tracing
ladder when the defect is intermittent, crosses subsystems, or resists two
hypotheses.

## Apply only a convergent fix

Implement a fix when existing requirements, tests, and surrounding behaviour
make the intended result clear. Add or correct a regression test that fails on
the defective behaviour and passes after the fix.

Do not change code when the proposed correction would alter a deliberate
contract, default, interface, or product decision. State the conflict, options,
trade-offs, and recommendation. Never weaken, skip, substitute, or delete a
valid assertion to make a failure disappear.

## Evidence to leave behind

Include the reproduction, causal chain, paths and symbols inspected, focused
checks and outcomes, fix applied or recommended, and every material uncertainty.
Distinguish observed facts from inference.
