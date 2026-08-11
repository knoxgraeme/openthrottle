import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../persistence/database.js";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import {
  OPENTHROTTLE_WEBHOOK_EVENTS,
  reconcileRepositoryWebhook,
} from "../providers/github/client.js";
import {
  createGithubWebhookReconciler,
  type RepositoryWebhookDelivery,
} from "./github-webhook-reconciliation.js";

describe("GitHub webhook reconciliation", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
  });

  afterEach(() => db.close());

  const listNoDeliveries = vi.fn(async (): Promise<RepositoryWebhookDelivery[]> => []);
  const redeliverNoDeliveries = vi.fn(async () => undefined);

  it("persists a replacement hook id when a deleted registration is adopted by URL", async () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "openthrottle",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget/hooks/7") && !init?.method) {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/repos/acme/widget/hooks?per_page=100")) {
        return Response.json([{
          id: 8,
          active: true,
          events: ["pull_request"],
          config: { url: "https://ot.test/webhooks/github" },
        }]);
      }
      if (url.endsWith("/repos/acme/widget/hooks/8") && init?.method === "PATCH") {
        return Response.json({ id: 8 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    const logger = { warn: vi.fn(), error: vi.fn() };

    await createGithubWebhookReconciler({
      store,
      client: { token: "github", fetch: fetchMock },
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
      reconcileRepositoryWebhook,
      listRepositoryWebhookDeliveries: listNoDeliveries,
      redeliverRepositoryWebhookDelivery: redeliverNoDeliveries,
      logger,
    })();

    expect(store.getRepositoryRegistration("team-1")?.webhook_id).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-webhook] reconciled acme/widget hook 8; missing events: issues, pull_request_review, issue_comment, workflow_run, check_suite"
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs one repository failure and continues reconciling later registrations", async () => {
    store.registerRepository({
      linearTeamKey: "BAD",
      linearTeamId: "team-bad",
      githubRepo: "acme/bad",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "openthrottle",
    });
    store.registerRepository({
      linearTeamKey: "GOOD",
      linearTeamId: "team-good",
      githubRepo: "acme/good",
      baseBranch: "main",
      webhookId: 9,
      snapshot: "openthrottle",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/bad/hooks/7")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.endsWith("/repos/acme/good/hooks/9")) {
        return Response.json({
          id: 9,
          active: true,
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
          config: { url: "https://ot.test/webhooks/github" },
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    const logger = { warn: vi.fn(), error: vi.fn() };

    await createGithubWebhookReconciler({
      store,
      client: { token: "github", fetch: fetchMock },
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
      reconcileRepositoryWebhook,
      listRepositoryWebhookDeliveries: listNoDeliveries,
      redeliverRepositoryWebhookDelivery: redeliverNoDeliveries,
      concurrency: 1,
      logger,
    })();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/good/hooks/9",
      expect.any(Object)
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[github-webhook] reconciliation failed for acme/bad hook 7:",
      expect.any(Error)
    );
  });

  it("requeues local dead deliveries only for successfully reconciled repositories", async () => {
    store.registerRepository({
      linearTeamKey: "BAD",
      linearTeamId: "team-bad",
      githubRepo: "acme/bad",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "openthrottle",
    });
    store.registerRepository({
      linearTeamKey: "GOOD",
      linearTeamId: "team-good",
      githubRepo: "acme/good",
      baseBranch: "main",
      webhookId: 9,
      snapshot: "openthrottle",
    });
    store.claimDelivery({
      deliveryId: "github-bad-dead",
      source: "github",
      action: "closed",
      eventName: "pull_request",
      payload: JSON.stringify({ repository: { full_name: "acme/bad" } }),
    });
    store.markDeliveryFailed("github-bad-dead", "delivery handler crashed", null);
    store.claimDelivery({
      deliveryId: "github-good-dead",
      source: "github",
      action: "closed",
      eventName: "pull_request",
      payload: JSON.stringify({ repository: { full_name: "ACME/GOOD" } }),
    });
    store.markDeliveryFailed("github-good-dead", "delivery handler crashed", null);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/bad/hooks/7")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.endsWith("/repos/acme/good/hooks/9")) {
        return Response.json({
          id: 9,
          active: true,
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
          config: { url: "https://ot.test/webhooks/github" },
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    const logger = { warn: vi.fn(), error: vi.fn() };

    await createGithubWebhookReconciler({
      store,
      client: { token: "github", fetch: fetchMock },
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
      reconcileRepositoryWebhook,
      listRepositoryWebhookDeliveries: listNoDeliveries,
      redeliverRepositoryWebhookDelivery: redeliverNoDeliveries,
      concurrency: 1,
      logger,
    })();

    const delivery = db.prepare(`
      SELECT status, last_error, redelivered_at
      FROM webhook_deliveries WHERE delivery_id = ?
    `);
    expect(delivery.get("github-good-dead")).toMatchObject({
      status: "pending",
      last_error: null,
      redelivered_at: expect.any(String),
    });
    expect(delivery.get("github-bad-dead")).toMatchObject({
      status: "dead",
      last_error: "delivery handler crashed",
      redelivered_at: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-webhook] requeued 1 dead delivery(s) for acme/good after hook reconciliation"
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[github-webhook] reconciliation failed for acme/bad hook 7:",
      expect.any(Error)
    );
  });

  it("durably redelivers each failed provider delivery once before requeueing its local row", async () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "openthrottle",
    });
    store.claimDelivery({
      deliveryId: "provider-guid",
      source: "github",
      action: "opened",
      eventName: "issues",
      payload: JSON.stringify({ repository: { full_name: "acme/widget" } }),
    });
    store.markDeliveryFailed(
      "provider-guid",
      "transient handler failure",
      "2026-01-01T00:10:00.000Z"
    );
    const now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const reconcile = vi.fn(async () => ({
      repo: "acme/widget",
      webhookId: 7,
      webhookAction: "unchanged" as const,
      missingEvents: [],
    }));
    const list = vi.fn(async (): Promise<RepositoryWebhookDelivery[]> => [{
      id: 123,
      guid: "provider-guid",
      deliveredAt: "2026-01-01T00:00:00Z",
      statusCode: 500,
      redelivery: false,
    }]);
    const redeliver = vi.fn(async () => undefined);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const sweep = createGithubWebhookReconciler({
      store,
      client: {},
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
      reconcileRepositoryWebhook: reconcile,
      listRepositoryWebhookDeliveries: list,
      redeliverRepositoryWebhookDelivery: redeliver,
      now,
      logger,
    });

    await sweep();

    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(redeliver).toHaveBeenCalledWith({}, {
      repo: "acme/widget",
      webhookId: 7,
      deliveryId: 123,
    });
    expect(db.prepare(`
      SELECT status, attempts, accepted_at, last_error
      FROM github_webhook_redelivery_requests
    `).get()).toMatchObject({
      status: "accepted",
      attempts: 1,
      accepted_at: "2026-01-01T00:00:00.000Z",
      last_error: null,
    });
    expect(db.prepare(`
      SELECT status, next_attempt_at, last_error, redelivered_at
      FROM webhook_deliveries WHERE delivery_id = 'provider-guid'
    `).get()).toEqual({
      status: "pending",
      next_attempt_at: "2026-01-01T00:00:00.000Z",
      last_error: null,
      redelivered_at: "2026-01-01T00:00:00.000Z",
    });

    await sweep();

    expect(list).toHaveBeenCalledTimes(2);
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(db.prepare(`
      SELECT status, attempts FROM github_webhook_redelivery_requests
    `).get()).toEqual({ status: "accepted", attempts: 1 });
  });

  it("retries a failed provider redelivery only after its durable backoff", async () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "openthrottle",
    });
    let timestamp = new Date("2026-01-01T00:00:00.000Z");
    const now = vi.fn(() => timestamp);
    const delivery: RepositoryWebhookDelivery = {
      id: 456,
      guid: "provider-guid-retry",
      deliveredAt: "2026-01-01T00:00:00Z",
      statusCode: 503,
      redelivery: false,
    };
    const redeliver = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce(undefined);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const sweep = createGithubWebhookReconciler({
      store,
      client: {},
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
      reconcileRepositoryWebhook: async () => ({
        repo: "acme/widget",
        webhookId: 7,
        webhookAction: "unchanged",
        missingEvents: [],
      }),
      listRepositoryWebhookDeliveries: async () => [delivery],
      redeliverRepositoryWebhookDelivery: redeliver,
      redeliveryRetryMs: 60_000,
      now,
      logger,
    });

    await sweep();
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(db.prepare(`
      SELECT status, attempts, next_attempt_at, accepted_at, last_error
      FROM github_webhook_redelivery_requests
    `).get()).toEqual({
      status: "failed",
      attempts: 1,
      next_attempt_at: "2026-01-01T00:01:00.000Z",
      accepted_at: null,
      last_error: "GitHub unavailable",
    });

    timestamp = new Date("2026-01-01T00:00:59.999Z");
    await sweep();
    expect(redeliver).toHaveBeenCalledTimes(1);

    timestamp = new Date("2026-01-01T00:01:00.000Z");
    await sweep();
    expect(redeliver).toHaveBeenCalledTimes(2);
    expect(db.prepare(`
      SELECT status, attempts, accepted_at, last_error
      FROM github_webhook_redelivery_requests
    `).get()).toEqual({
      status: "accepted",
      attempts: 2,
      accepted_at: "2026-01-01T00:01:00.000Z",
      last_error: null,
    });
  });
});
