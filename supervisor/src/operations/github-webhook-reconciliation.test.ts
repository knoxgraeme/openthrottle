import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../persistence/database.js";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import {
  OPENTHROTTLE_WEBHOOK_EVENTS,
  reconcileRepositoryWebhook,
} from "../providers/github/client.js";
import { createGithubWebhookReconciler } from "./github-webhook-reconciliation.js";

describe("GitHub webhook reconciliation", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
  });

  afterEach(() => db.close());

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
      logger,
    })();

    expect(store.getRepositoryRegistration("team-1")?.webhook_id).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-webhook] reconciled acme/widget hook 8; missing events: pull_request_review, issue_comment, workflow_run, check_suite"
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
});
