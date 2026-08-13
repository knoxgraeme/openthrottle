import type { AdmissionDrainBlocker, AdmissionDrainStore } from "../persistence/admission-drain-store.js";
import type { RuntimeInventory, RuntimeInventoryResource } from "../runtime/contracts.js";

export type AdmissionDrainReportBlocker =
  | AdmissionDrainBlocker
  | {
      kind: "admission_not_paused" | "runtime_inventory_resource" | "unknown_runtime_inventory_resource" | "runtime_inventory_error";
      id: string;
      detail: string;
    };

export interface AdmissionDrainReport {
  clear: boolean;
  blockers: AdmissionDrainReportBlocker[];
  truncated: boolean;
}

export interface AdmissionDrainReportDeps {
  store: AdmissionDrainStore;
  runtime: Pick<RuntimeInventory, "listLabeledResources">;
  admissionPaused: boolean;
  epochStartedAtIso: string;
  nowIso: string;
  limit?: number;
}

const DEFAULT_DRAIN_REPORT_LIMIT = 50;
const DESTROYED_RUNTIME_STATES = new Set(["destroyed"]);

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DRAIN_REPORT_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function runtimeResourceDetail(resource: RuntimeInventoryResource): string {
  const state = resource.state ?? "unknown";
  const memory = typeof resource.memory === "number" ? `${resource.memory}GiB` : "unknown-memory";
  return `state=${state} memory=${memory} created_at=${resource.createdAt ?? "unknown"}`;
}

function insertSortedById(
  resources: RuntimeInventoryResource[],
  resource: RuntimeInventoryResource,
  limit: number
): RuntimeInventoryResource[] {
  const next = [...resources, resource].sort((left, right) => left.id.localeCompare(right.id));
  return next.slice(0, limit);
}

export async function buildAdmissionDrainReport(
  deps: AdmissionDrainReportDeps
): Promise<AdmissionDrainReport> {
  const limit = normalizeLimit(deps.limit);
  const blockers: AdmissionDrainReportBlocker[] = [];
  if (!deps.admissionPaused) {
    blockers.push({
      kind: "admission_not_paused",
      id: "admission",
      detail: "admission maintenance pause is not active",
    });
  }
  const durableCapacity = limit - blockers.length;
  if (durableCapacity === 0) {
    return { clear: false, blockers, truncated: true };
  }
  const durable = deps.store.collectAdmissionDrainBlockers({
    epochStartedAtIso: deps.epochStartedAtIso,
    nowIso: deps.nowIso,
    limit: durableCapacity,
  });
  blockers.push(...durable.blockers);
  let truncated = durable.truncated;
  const knownRuntimeResourceIds = new Set(durable.knownRuntimeResourceIds);

  try {
    const inventoryCapacity = Math.max(0, limit - blockers.length);
    if (inventoryCapacity === 0) {
      truncated = true;
    } else {
      const inventoryReadLimit = inventoryCapacity + 1;
      const liveResources = (await deps.runtime.listLabeledResources(inventoryReadLimit))
        .reduce<RuntimeInventoryResource[]>((selected, resource) => {
          if (DESTROYED_RUNTIME_STATES.has(resource.state ?? "")) return selected;
          return insertSortedById(selected, resource, inventoryReadLimit);
        }, []);
      if (liveResources.length > inventoryCapacity) truncated = true;
      for (const resource of liveResources.slice(0, inventoryCapacity)) {
        const unknown = !knownRuntimeResourceIds.has(resource.id);
        blockers.push({
          kind: unknown ? "unknown_runtime_inventory_resource" : "runtime_inventory_resource",
          id: resource.id,
          detail: runtimeResourceDetail(resource),
        });
      }
    }
  } catch (error) {
    if (blockers.length < limit) {
      blockers.push({
        kind: "runtime_inventory_error",
        id: "runtime-inventory",
        detail: String(error),
      });
    } else {
      truncated = true;
    }
  }

  return {
    clear: blockers.length === 0 && !truncated,
    blockers,
    truncated,
  };
}
