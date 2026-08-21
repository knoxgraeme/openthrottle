import { afterEach, describe, expect, it } from "vitest";
import { KernelControlService } from "./kernel-control.js";
import { KernelHttpNotFoundError, KernelHttpService } from "./kernel-http.js";
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
  return {
    fixture,
    service: new KernelHttpService({
      registrations,
      projections,
      analysis: createKernelHistoricalAnalysisStore(fixture.db),
      control,
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
});
