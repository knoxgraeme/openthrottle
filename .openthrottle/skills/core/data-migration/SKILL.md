---
name: data-migration
description: Use when reviewing schema changes, migrations, backfills, or serialized-data compatibility for safe upgrades and retries.
---

# Data migration review

Trace every changed durable-data or versioned-serialization path from old state
through upgrade to current reads and writes.

## Review method

- Compare fresh-install and upgrade paths for schema, constraints, indexes, and
  default values.
- Check migration ordering and whether every reader is compatible with the data
  shape available when it runs.
- Exercise missing, null, legacy, duplicate, malformed, empty, and maximum-sized
  records in backfills and adapters.
- Verify transformations preserve meaning and do not silently drop, duplicate,
  reinterpret, or orphan existing state.
- Inspect transaction boundaries and version markers. Partial failure must leave
  a safely retryable state and must not advertise completion early.
- Compare versioned JSON, configuration, fixtures, and provider record shapes
  for backward compatibility or an explicit unsupported-version failure.
- Check downgrade assumptions when the repository promises reversibility.

## Finding bar

Ground findings in committed migrations, schemas, fixtures, or adapter paths.
Name the old shape, changed path and stable symbol, violated transition
invariant, and observable data loss, misread, duplication, or unrecoverable
upgrade.

## Exclusions

Do not infer undocumented production records, report historical schema debt,
flag index style without a semantic effect, or demand migrations for private
in-memory changes.
