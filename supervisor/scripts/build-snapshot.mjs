// Build and register the OpenThrottle Daytona sandbox snapshot from CI (or any
// operator machine) using the same pinned @daytona/sdk the supervisor runs on,
// so no Daytona CLI install is required.
//
// Usage: node supervisor/scripts/build-snapshot.mjs <snapshot-name>
// Requires DAYTONA_API_KEY. Equivalent to the documented operator command
// `daytona snapshot create <name> --dockerfile sandbox/Dockerfile --context .`.

import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Daytona, Image } from "@daytona/sdk";
import { resolveSandboxResources } from "./snapshot-resources.mjs";

const name = process.argv[2];
if (!name) {
  console.error("usage: node supervisor/scripts/build-snapshot.mjs <snapshot-name>");
  process.exit(1);
}
if (!process.env.DAYTONA_API_KEY) {
  console.error("DAYTONA_API_KEY is required");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, "../..");
const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });

// Idempotent re-runs: a snapshot name is commit-pinned, so an active snapshot
// under this name is this build already done.
let existing;
try {
  existing = await daytona.snapshot.get(name);
} catch {
  existing = undefined;
}
if (existing) {
  const state = String(existing.state).toLowerCase();
  if (state === "active") {
    console.log(`Snapshot ${name} is already active; nothing to build.`);
    process.exit(0);
  }
  console.error(
    `Snapshot ${name} already exists in state ${existing.state}; delete it in Daytona before rebuilding.`
  );
  process.exit(1);
}

// Image.fromDockerfile resolves COPY sources relative to the Dockerfile's own
// directory, while sandbox/Dockerfile expects the repository root as build
// context (COPY sandbox/..., COPY skills). Stage a copy at the repo root so
// both agree, and clean it up afterwards.
const stagedDockerfile = resolve(repoRoot, ".snapshot-build.Dockerfile");
copyFileSync(resolve(repoRoot, "sandbox/Dockerfile"), stagedDockerfile);

// Size the sandbox to run real monorepo builds. Without this, Daytona's small
// default tier OOM-kills pnpm/Turbo build and type-check gates (exit 137).
// Overridable per operator via DAYTONA_SANDBOX_CPU/MEMORY/DISK.
const resources = resolveSandboxResources();
console.log(
  `Sizing sandbox: ${resources.cpu} vCPU / ${resources.memory} GiB RAM / ${resources.disk} GiB disk`
);
try {
  const snapshot = await daytona.snapshot.create(
    { name, image: Image.fromDockerfile(stagedDockerfile), resources },
    { onLogs: (chunk) => process.stdout.write(chunk) }
  );
  const state = String(snapshot.state).toLowerCase();
  if (state !== "active") {
    console.error(`\nSnapshot ${name} finished in state ${snapshot.state}.`);
    process.exit(1);
  }
  console.log(`\nSnapshot ${name} is active.`);
} finally {
  rmSync(stagedDockerfile, { force: true });
}
