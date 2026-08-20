---
name: performance
description: Use when reviewing changed queries, loops, I/O, allocation, or retention for production-scale boundedness.
---

# Performance review

Trace how work and retained data grow with realistic input, repository, and
history size. Focus on defects that can block a request path, exhaust resources,
or turn previously bounded work into unbounded work.

## Review method

- Inspect changed queries, scans, reducers, polling loops, queues, leases, and
  drains for explicit limits, indexes, cursors, or bounded windows.
- Look for N+1 database or provider calls, blocking I/O, repeated parsing or
  canonicalization, and expensive work added to synchronous hot paths.
- Check allocations, logs, artifacts, caches, and package copies for unbounded
  retention or repeated work proportional to full history.
- Verify pagination, timeout, batch, concurrency, and output-size limits are
  enforced by code rather than documentation alone.
- Compare failure granularity before recommending batching or concurrency;
  faster code that changes error isolation is a behaviour change.
- Estimate complexity from the actual loop and call structure, then tie it to a
  plausible production-sized input.

## Finding bar

Name the growing input or table, changed path and stable symbol, missing bound
or index, and observable timeout, event-loop blockage, quota exhaustion, memory
growth, or runaway work. Report only changed bounds, not theoretical
micro-optimizations.

## Exclusions

Do not report small constant-factor changes, formatting, speculative scale
concerns without a growth path, unchanged debt, or local-machine slowness.
