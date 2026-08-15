// Admission preflight: reject a delegation at admission time — before any
// pipeline instance or sandbox exists — when the run is guaranteed (or very
// likely) to fail later in a way that is invisible from Linear.
//
// Two checks, each motivated by a real incident:
//  1. Read-token check (hard). The sandbox clones with GITHUB_READ_TOKEN, not
//     the write token the supervisor uses for config resolution. A fine-grained
//     PAT without the Contents: Read permission passed admission and then 403'd
//     inside the sandbox with no Linear-visible error. Verify the read token
//     can read the pinned commit's tree before provisioning anything.
//  2. Capacity check (soft, best-effort). Daytona enforces an org-wide memory
//     quota; when it is exhausted, provisioning churns retries and fails
//     opaquely. Estimate usage from live sandboxes and reject when one more
//     sandbox cannot fit. A broken capacity probe never blocks admission.
//     Before rejecting, run the terminal-runtime-resource reconciler once
//     (OPE-75): a needs_human/failed/shipped backlog can leave stopped-but-
//     undeleted sandboxes billed against this exact quota forever, deadlocking
//     every future delegation even though no pipeline action is active. One
//     reconciliation pass frees whatever is eligible and the usage estimate is
//     recomputed before the final verdict.

import type { Config } from "./config.js";
import type { RuntimeInventory } from "../runtime/contracts.js";
import { githubApiResponse } from "../shared/github-request.js";

export const DEFAULT_DAYTONA_TOTAL_MEMORY_GIB = 10;
export const DEFAULT_DAYTONA_SANDBOX_MEMORY_GIB = 8;

export type AdmissionPreflightResult = { ok: true } | { ok: false; reason: string };

export interface AdmissionPreflightTarget {
  repository: string;
  baseCommit: string;
}

export type AdmissionPreflight = (
  target: AdmissionPreflightTarget
) => Promise<AdmissionPreflightResult>;

export interface AdmissionPreflightDeps {
  githubReadToken: string;
  githubApiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Live sandbox inventory; omit to skip the capacity check entirely. */
  listSandboxes?: () => Promise<Array<{ state?: string; memory?: number }>>;
  totalMemoryGib?: number;
  sandboxMemoryGib?: number;
  /**
   * Best-effort idempotent reclaim of eligible terminal stopped runtime
   * resources, run at most once per preflight call when capacity is tight.
   * Omit to skip reconciliation (the capacity check still runs; it just
   * cannot free anything before rejecting). A throwing reconciler must not
   * block admission any more than a broken capacity probe does.
   */
  reconcile?: () => Promise<unknown>;
}

type RuntimeInventoryReader = Pick<RuntimeInventory, "listLabeledResources">;

export async function runAdmissionPreflight(
  deps: AdmissionPreflightDeps,
  target: AdmissionPreflightTarget
): Promise<AdmissionPreflightResult> {
  const readVerdict = await checkReadToken(deps, target);
  if (!readVerdict.ok) return readVerdict;
  return checkDaytonaCapacity(deps);
}

/** Bind the preflight to supervisor config and the live runtime inventory. */
export function createAdmissionPreflight(
  cfg: Config,
  runtime: RuntimeInventoryReader,
  reconcile?: () => Promise<unknown>
): AdmissionPreflight {
  return (target) =>
    runAdmissionPreflight(
      {
        githubReadToken: cfg.githubReadToken,
        listSandboxes: () => runtime.listLabeledResources(),
        totalMemoryGib: cfg.daytonaTotalMemoryGib,
        sandboxMemoryGib: cfg.daytonaSandboxMemoryGib,
        reconcile,
      },
      target
    );
}

// The exact read the sandbox needs later: the pinned commit's tree, fetched
// with the read token. 401/403/404 are definitive evidence the sandbox clone
// would fail; anything else (network blip, 5xx) is not evidence the token is
// bad — the write-token calls that resolved the config just succeeded — so it
// logs and proceeds rather than blocking admission on a broken check.
async function checkReadToken(
  deps: AdmissionPreflightDeps,
  target: AdmissionPreflightTarget
): Promise<AdmissionPreflightResult> {
  let response: Response;
  try {
    response = await githubApiResponse(
      { token: deps.githubReadToken, apiBaseUrl: deps.githubApiBaseUrl, fetch: deps.fetch },
      `/repos/${target.repository}/git/trees/${target.baseCommit}`
    );
  } catch (error) {
    console.warn(
      `[preflight] read-token check for ${target.repository} did not complete; proceeding: ${String(error)}`
    );
    return { ok: true };
  }
  if (response.ok) return { ok: true };
  if ([401, 403, 404].includes(response.status)) {
    return { ok: false, reason: readTokenFailureReason(target.repository, response.status) };
  }
  console.warn(
    `[preflight] read-token check for ${target.repository} returned HTTP ${response.status}; proceeding`
  );
  return { ok: true };
}

function readTokenFailureReason(repository: string, status: number): string {
  const base = `GITHUB_READ_TOKEN cannot read ${repository} (HTTP ${status}), so the sandbox clone would fail after provisioning.`;
  if (status === 401) {
    return `${base} The token is invalid or expired — rotate GITHUB_READ_TOKEN on the supervisor.`;
  }
  if (status === 404) {
    return `${base} The token cannot see the repository — grant it access to ${repository} (fine-grained PATs also need the Contents: Read repository permission).`;
  }
  return `${base} Fine-grained PATs need the Contents: Read repository permission.`;
}

async function measureDaytonaUsageGib(
  deps: AdmissionPreflightDeps,
  sandboxGib: number
): Promise<number | undefined> {
  if (!deps.listSandboxes) return undefined;
  try {
    const sandboxes = await deps.listSandboxes();
    return sandboxes
      .filter((sandbox) => sandbox.state !== "destroyed" && sandbox.state !== "destroying")
      .reduce(
        (sum, sandbox) =>
          sum + (typeof sandbox.memory === "number" && sandbox.memory > 0 ? sandbox.memory : sandboxGib),
        0
      );
  } catch (error) {
    console.warn(`[preflight] Daytona capacity check failed; proceeding: ${String(error)}`);
    return undefined;
  }
}

async function checkDaytonaCapacity(deps: AdmissionPreflightDeps): Promise<AdmissionPreflightResult> {
  const totalGib = deps.totalMemoryGib ?? DEFAULT_DAYTONA_TOTAL_MEMORY_GIB;
  const sandboxGib = deps.sandboxMemoryGib ?? DEFAULT_DAYTONA_SANDBOX_MEMORY_GIB;
  let usedGib = await measureDaytonaUsageGib(deps, sandboxGib);
  if (usedGib === undefined) return { ok: true };
  if (usedGib + sandboxGib > totalGib && deps.reconcile) {
    try {
      await deps.reconcile();
    } catch (error) {
      console.warn(`[preflight] runtime resource reconciliation failed; proceeding with the prior usage estimate: ${String(error)}`);
    }
    // Re-measure regardless of whether reconcile() reported anything reclaimed:
    // its own view of what is eligible can differ from what we can observe here.
    const reconciledGib = await measureDaytonaUsageGib(deps, sandboxGib);
    if (reconciledGib !== undefined) usedGib = reconciledGib;
  }
  if (usedGib + sandboxGib > totalGib) {
    return {
      ok: false,
      reason:
        `Daytona capacity: ${usedGib} GiB of ${totalGib} GiB memory is already in use; ` +
        `delegating would exceed the org memory quota (a new sandbox needs ${sandboxGib} GiB). ` +
        `Stop or delete an existing sandbox, then delegate again.`,
    };
  }
  return { ok: true };
}
