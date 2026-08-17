# Security policy

## Supported versions

Security fixes are provided for the latest published `1.x` release. The
project is pre-production; older releases and unreleased commits may not
receive backports.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/knoxgraeme/openthrottle/security/advisories/new).
Do not include exploit details, credentials, or sensitive logs in a public
Issue or Discussion. If private reporting is unavailable, contact the
repository owner through GitHub to arrange a private channel.

Include, when possible:

- the affected version or commit;
- the component and deployment assumptions;
- reproduction steps or a minimal proof of concept;
- the likely impact; and
- any suggested mitigation.

The maintainers will acknowledge the report, validate its scope, coordinate a
fix and release, and credit the reporter unless anonymity is requested. Please
allow time for a patch before public disclosure.

## Operational security

OpenThrottle executes code from registered repositories. Operators should
register only trusted repositories, keep GitHub branch protection enabled,
use least-privilege tokens, isolate pilot deployments, and rotate any
credential that may have appeared in logs or repository content.
