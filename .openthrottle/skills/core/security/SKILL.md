---
name: security
description: Use when reviewing changed trust boundaries for authorization, injection, secret exposure, or cross-tenant access defects.
---

# Security review

Trace security-sensitive behaviour changed by the work and report only
reachable confidentiality, integrity, or authority failures.

## Review method

- Identify attacker-controlled text, files, provider payloads, webhooks,
  comments, paths, and identifiers that enter the changed code.
- Follow authentication, authorization, tenant, repository, run, and session
  binding through every changed branch. Missing or invalid identity must fail
  closed.
- Trace secrets and tokens through memory, persistence, logs, prompts,
  configuration, Git metadata, and user-visible artifacts.
- Inspect shell, path, SQL, JSON, markdown, prompt, URL, and provider payload
  construction. Prefer structured APIs; otherwise require explicit validation
  and correct escaping at the boundary.
- Check that untrusted input cannot select tools, credentials, filesystem scope,
  external resources, or runtime capabilities.
- Consider cross-request and cross-tenant races when authorization is checked
  before a later use.

## Finding bar

Each finding must identify the attacker-controlled input, path and stable
symbol, missing or incorrect check, exploit path, and concrete impact. Follow
direct local calls only far enough to prove reachability.

## Exclusions

Do not report speculative hardening, style, unrelated dependency advisories,
missing defense in depth when an existing boundary blocks the path, unchanged
risks, operator misconfiguration not represented in code, or external provider
incidents.
