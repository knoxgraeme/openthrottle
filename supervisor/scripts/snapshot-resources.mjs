// Resolve the Daytona sandbox resource sizing from the environment.
//
// The default tier Daytona applies when a snapshot is created with no
// `resources` is small (~1 vCPU / ~1 GiB), which OOM-kills real pnpm/Turbo
// monorepo builds and type-checks — the container memory cgroup sends SIGKILL,
// surfacing as exit 137, before diagnostics even print. These defaults size a
// sandbox to run those builds; all three are operator-overridable so a repo
// with heavier or lighter builds can be right-sized without a code change.
//
// Units follow the Daytona SDK `Resources` contract: cpu in cores, memory and
// disk in GiB.

// Disk stays within Daytona's documented standard-tier maximum (10 GiB) so the
// default snapshot build works for ordinary orgs; raise DAYTONA_SANDBOX_DISK on
// plans with a larger quota. The OOM fix is the memory bump, not disk.
export const SANDBOX_RESOURCE_DEFAULTS = Object.freeze({
  cpu: 4,
  memory: 8,
  disk: 10,
});

function positiveIntFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const trimmed = String(raw).trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

// Returns { cpu, memory, disk } sized from DAYTONA_SANDBOX_CPU/MEMORY/DISK,
// falling back to SANDBOX_RESOURCE_DEFAULTS for any that are unset or blank.
export function resolveSandboxResources(env = process.env) {
  return {
    cpu: positiveIntFromEnv(env, "DAYTONA_SANDBOX_CPU", SANDBOX_RESOURCE_DEFAULTS.cpu),
    memory: positiveIntFromEnv(env, "DAYTONA_SANDBOX_MEMORY", SANDBOX_RESOURCE_DEFAULTS.memory),
    disk: positiveIntFromEnv(env, "DAYTONA_SANDBOX_DISK", SANDBOX_RESOURCE_DEFAULTS.disk),
  };
}
