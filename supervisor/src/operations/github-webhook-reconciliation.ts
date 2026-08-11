import type { SupervisorStore } from "../persistence/store.js";

const DEFAULT_WEBHOOK_RECONCILIATION_CONCURRENCY = 4;
const DEFAULT_WEBHOOK_REDELIVERY_LIMIT = 50;

export interface RepositoryWebhookReconciliation {
  repo: string;
  webhookId: number;
  webhookAction: "unchanged" | "updated" | "created";
  missingEvents: string[];
}

export interface GithubWebhookReconcilerOptions<TClient> {
  store: SupervisorStore;
  client: TClient;
  webhookUrl: string;
  webhookSecret: string;
  reconcileRepositoryWebhook: (
    client: TClient,
    input: {
      repo: string;
      webhookId: number;
      webhookUrl: string;
      webhookSecret: string;
    }
  ) => Promise<RepositoryWebhookReconciliation>;
  concurrency?: number;
  redeliveryLimit?: number;
  logger?: Pick<Console, "error" | "warn">;
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const item = items[next];
      next += 1;
      if (item === undefined) return;
      await task(item);
    }
  });
  await Promise.all(workers);
}

export function createGithubWebhookReconciler<TClient>(
  options: GithubWebhookReconcilerOptions<TClient>
): () => Promise<void> {
  const logger = options.logger ?? console;
  const concurrency = options.concurrency ?? DEFAULT_WEBHOOK_RECONCILIATION_CONCURRENCY;
  const redeliveryLimit = options.redeliveryLimit ?? DEFAULT_WEBHOOK_REDELIVERY_LIMIT;
  return async () => {
    await runBounded(options.store.listRepositoryRegistrations(), concurrency, async (registration) => {
      try {
        const result = await options.reconcileRepositoryWebhook(options.client, {
          repo: registration.github_repo,
          webhookId: registration.webhook_id,
          webhookUrl: options.webhookUrl,
          webhookSecret: options.webhookSecret,
        });
        if (result.webhookId !== registration.webhook_id) {
          options.store.registerRepository({
            controlProvider: registration.control_provider,
            linearTeamKey: registration.linear_team_key ?? undefined,
            linearTeamId: registration.linear_team_id ?? undefined,
            githubRepo: registration.github_repo,
            baseBranch: registration.base_branch,
            webhookId: result.webhookId,
            snapshot: registration.snapshot,
          });
        }
        if (result.webhookAction === "updated") {
          logger.warn(
            `[github-webhook] reconciled ${result.repo} hook ${result.webhookId}; missing events: ${result.missingEvents.join(", ") || "none"}`
          );
        } else if (result.webhookAction === "created") {
          logger.warn(
            `[github-webhook] recreated ${result.repo} hook ${result.webhookId}; previous hook ${registration.webhook_id} was unavailable`
          );
        }
      } catch (error) {
        logger.error(
          `[github-webhook] reconciliation failed for ${registration.github_repo} hook ${registration.webhook_id}:`,
          error
        );
      }
    });
    const requeued = options.store.requeueFailedDeliveriesForRedelivery(
      "github",
      new Date().toISOString(),
      redeliveryLimit
    );
    if (requeued > 0) {
      logger.warn(`[github-webhook] requeued ${requeued} failed delivery(s) for one redelivery attempt`);
    }
  };
}
