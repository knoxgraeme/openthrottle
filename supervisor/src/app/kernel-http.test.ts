import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelControlService } from "./kernel-control.js";
import {
  KernelHttpConflictError,
  KernelHttpNotFoundError,
  KernelHttpService,
} from "./kernel-http.js";
import {
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "../persistence/__fixtures__/kernel-epoch.js";
import { createKernelHistoricalAnalysisStore } from "../persistence/kernel-analysis-store.js";
import { SqliteKernelInboxStore } from "../persistence/kernel-inbox-store.js";
import { SqliteKernelProjectionStore } from "../persistence/kernel-projection-store.js";
import { SqliteKernelRegistrationStore } from "../persistence/kernel-registration-store.js";
import {
  KernelOperatorEffectRejectionConflictError,
  KernelOperatorEffectRejectionNotFoundError,
} from "../pipeline/kernel/operator-effect-rejection.js";
import type { KernelOperatorEffectRejectionRequest } from "../pipeline/kernel/ports.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  seedKernelRun({ db: fixture.db, run_id: "run-active" });
  seedKernelAttempt({ db: fixture.db, run_id: "run-active", id: "attempt-active", status: "running" });
  seedKernelRun({ db: fixture.db, run_id: "run-settled", status: "completed" });
  const inbox = new SqliteKernelInboxStore({
    db: fixture.db,
    blob_store: fixture.blobs,
    now: () => "2026-08-20T13:00:00.000Z",
  });
  const registrations = new SqliteKernelRegistrationStore({ db: fixture.db });
  const projections = new SqliteKernelProjectionStore({ db: fixture.db });
  const control = new KernelControlService({
    inbox,
    maintenance: inbox,
    runtime_sessions: {
      bindRuntimeSession: async () => {
        throw new Error("not used");
      },
      loadCurrentRuntimeSession: async () => null,
    },
    active_work: projections,
    runtime_inventory: { listActiveRuntimeResources: async () => [] },
    now: () => "2026-08-20T13:00:00.000Z",
  });
  const effectRejections = {
    rejectDispatchFencedUnknownEffect: vi.fn(async (input: KernelOperatorEffectRejectionRequest) => ({
      disposition: "rejected" as const,
      pipeline_run_id: input.pipeline_run_id,
      effect_id: input.effect_id,
      delivery_record_id: "delivery-operator-rejection",
      effect_version: 4,
      run_version: 8,
    })),
  };
  return {
    fixture,
    effectRejections,
    service: new KernelHttpService({
      registrations,
      projections,
      analysis: createKernelHistoricalAnalysisStore(fixture.db),
      control,
      effect_rejections: effectRejections,
    }),
  };
}

describe("KernelHttpService", () => {
  it("resolves status and bounded logs by run ID or source reference", () => {
    const { service } = setup();
    expect(service.status("run-active")).toMatchObject({
      pipeline_run_id: "run-active",
      source_reference: "OPE-run-active",
      status: "running",
    });
    expect(service.status("OPE-run-active")).toMatchObject({ pipeline_run_id: "run-active" });
    expect(service.logs({ reference: "OPE-run-active", limit: 10 })).toMatchObject({
      pipeline_run_id: "run-active",
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "run" }),
        expect.objectContaining({ kind: "attempt" }),
      ]),
    });
    expect(() => service.status("missing")).toThrow(KernelHttpNotFoundError);
  });

  it("exposes settled history without making it a live decision input", () => {
    const { service } = setup();
    expect(service.analysis({ terminal_outcome: "completed" })).toEqual([
      expect.objectContaining({
        pipeline_run_id: "run-settled",
        terminal_outcome: "completed",
      }),
    ]);
    expect(service.runAnalysis({ reference: "OPE-run-settled" })).toEqual({
      pipeline_run_id: "run-settled",
      records: [],
    });
  });

  it("turns stop and supersede into idempotent inbox events", () => {
    const { fixture, service } = setup();
    const first = service.requestRunControl({
      reference: "OPE-run-active",
      action: "stop",
      reason: "operator request",
    });
    expect(first).toMatchObject({
      accepted: true,
      action: "stop",
      pipeline_run_id: "run-active",
      duplicate: false,
    });
    expect(service.requestRunControl({
      reference: "run-active",
      action: "stop",
      reason: "operator request",
    })).toMatchObject({ accepted: true, duplicate: true });
    expect(fixture.db.prepare("SELECT kind, pipeline_run_id FROM inbox_events").all()).toEqual([
      { kind: "control/stop@1", pipeline_run_id: "run-active" },
    ]);
  });

  it("fences all provider ingress during maintenance and deduplicates after reopening", () => {
    const { fixture, service } = setup();
    expect(service.closeMaintenance()).toMatchObject({ closed: true });
    const webhook = {
      provider: "github" as const,
      delivery_id: "delivery-1",
      kind: "github/issues/opened@1",
      event_group_key: "github:issues:1:opened",
      delivery_attempt: 1,
      route: { github_repo: "owner/repo" },
      payload_schema: "openthrottle.provider-event/github/v1",
      payload: { action: "opened", repository: { full_name: "owner/repo" } },
    };
    expect(service.ingestProviderWebhook(webhook)).toMatchObject({
      accepted: false,
      acknowledge: false,
      retryable: true,
      status_code: 503,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });

    service.openMaintenance();
    expect(service.ingestProviderWebhook(webhook)).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(service.ingestProviderWebhook(webhook)).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(service.ingestProviderWebhook({
      ...webhook,
      delivery_id: "unregistered",
      event_group_key: "github:issues:2:opened",
      route: { github_repo: "unknown/repo" },
    })).toEqual({
      accepted: false,
      acknowledge: true,
      retryable: false,
      ignored: "unregistered_route",
    });
  });

  it("rejects one exact dispatch-fenced unknown Effect only inside the observed maintenance fence", async () => {
    const { effectRejections, service } = setup();
    const maintenance = service.closeMaintenance(1);

    await expect(service.rejectUnknownEffect({
      reference: "OPE-run-active",
      effect_id: "effect-integration",
      expected_maintenance_version: maintenance.version,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "  sandbox failed with ghp_this_should_be_redacted before mutation  ",
    })).resolves.toMatchObject({
      disposition: "rejected",
      pipeline_run_id: "run-active",
      effect_id: "effect-integration",
      delivery_record_id: "delivery-operator-rejection",
    });
    expect(effectRejections.rejectDispatchFencedUnknownEffect).toHaveBeenCalledWith({
      pipeline_run_id: "run-active",
      effect_id: "effect-integration",
      expected_maintenance_version: maintenance.version,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "sandbox failed with [REDACTED] before mutation",
    });
  });

  it("delegates the transactional maintenance fence and fails before it for a missing run", async () => {
    const { effectRejections, service } = setup();
    const request = {
      reference: "run-active",
      effect_id: "effect-integration",
      expected_maintenance_version: 1,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation" as const,
      reason: "sandbox request validation failed before mutation",
    };

    effectRejections.rejectDispatchFencedUnknownEffect.mockRejectedValue(
      new KernelOperatorEffectRejectionConflictError("exact closed maintenance fence required"),
    );
    await expect(service.rejectUnknownEffect(request)).rejects.toThrow(KernelHttpConflictError);
    const maintenance = service.closeMaintenance(1);
    await expect(service.rejectUnknownEffect({
      ...request,
      expected_maintenance_version: maintenance.version - 1,
    })).rejects.toThrow(/maintenance fence/i);
    await expect(service.rejectUnknownEffect({
      ...request,
      reference: "missing",
      expected_maintenance_version: maintenance.version,
    })).rejects.toThrow(KernelHttpNotFoundError);
    expect(effectRejections.rejectDispatchFencedUnknownEffect).toHaveBeenCalledTimes(2);
  });

  it("maps a fenced persistence conflict into an HTTP conflict", async () => {
    const { effectRejections, service } = setup();
    const maintenance = service.closeMaintenance(1);
    effectRejections.rejectDispatchFencedUnknownEffect.mockRejectedValueOnce(
      new KernelOperatorEffectRejectionConflictError("effect is currently leased"),
    );

    await expect(service.rejectUnknownEffect({
      reference: "run-active",
      effect_id: "effect-integration",
      expected_maintenance_version: maintenance.version,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "sandbox request validation failed before mutation",
    })).rejects.toThrow(KernelHttpConflictError);
  });

  it("maps a missing exact Effect into an HTTP not-found response", async () => {
    const { effectRejections, service } = setup();
    const maintenance = service.closeMaintenance(1);
    effectRejections.rejectDispatchFencedUnknownEffect.mockRejectedValueOnce(
      new KernelOperatorEffectRejectionNotFoundError("exact Effect was not found"),
    );

    await expect(service.rejectUnknownEffect({
      reference: "run-active",
      effect_id: "effect-missing",
      expected_maintenance_version: maintenance.version,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "sandbox request validation failed before mutation",
    })).rejects.toThrow(KernelHttpNotFoundError);
  });
});
