import type { SupervisorStore } from "../persistence/store.js";

const DEFAULT_WEBHOOK_RECONCILIATION_CONCURRENCY = 4;
const DEFAULT_WEBHOOK_REDELIVERY_LIMIT = 50;
const DEFAULT_WEBHOOK_REDELIVERY_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_WEBHOOK_REDELIVERY_RETRY_MS = 5 * 60 * 1000;

export interface RepositoryWebhookReconciliation {
  repo: string;
  webhookId: number;
  webhookAction: "unchanged" | "updated" | "created";
  missingEvents: string[];
}

export interface RepositoryWebhookDelivery {
  id: number;
  guid: string;
  deliveredAt: string;
  statusCode: number;
  redelivery: boolean;
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
  listRepositoryWebhookDeliveries: (
    client: TClient,
    input: { repo: string; webhookId: number; limit: number }
  ) => Promise<RepositoryWebhookDelivery[]>;
  redeliverRepositoryWebhookDelivery: (
    client: TClient,
    input: { repo: string; webhookId: number; deliveryId: number }
  ) => Promise<void>;
  concurrency?: number;
  redeliveryLimit?: number;
  redeliveryLeaseMs?: number;
  redeliveryRetryMs?: number;
  now?: () => Date;
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
  const redeliveryLeaseMs = options.redeliveryLeaseMs ?? DEFAULT_WEBHOOK_REDELIVERY_LEASE_MS;
  const redeliveryRetryMs = options.redeliveryRetryMs ?? DEFAULT_WEBHOOK_REDELIVERY_RETRY_MS;
  const now = options.now ?? (() => new Date());
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

        const reconciledAt = now().toISOString();
        const locallyRequeued = options.store.requeueDeadDeliveriesForRedelivery(
          "github",
          registration.github_repo,
          reconciledAt,
          redeliveryLimit
        );
        if (locallyRequeued > 0) {
          logger.warn(
            `[github-webhook] requeued ${locallyRequeued} dead delivery(s) for ${registration.github_repo} after hook reconciliation`
          );
        }

        let deliveries: RepositoryWebhookDelivery[];
        try {
          deliveries = await options.listRepositoryWebhookDeliveries(options.client, {
            repo: registration.github_repo,
            webhookId: result.webhookId,
            limit: redeliveryLimit,
          });
        } catch (error) {
          logger.error(
            `[github-webhook] could not list deliveries for ${registration.github_repo} hook ${result.webhookId}:`,
            error
          );
          return;
        }

        for (const delivery of deliveries) {
          if (delivery.redelivery || delivery.statusCode < 300 && delivery.statusCode >= 200) {
            continue;
          }
          const claimedAt = now();
          if (!options.store.claimGithubWebhookRedelivery({
            repository: registration.github_repo,
            webhookId: result.webhookId,
            deliveryId: delivery.id,
            deliveryGuid: delivery.guid,
            deliveredAt: delivery.deliveredAt,
            nowIso: claimedAt.toISOString(),
            leaseUntilIso: new Date(claimedAt.getTime() + redeliveryLeaseMs).toISOString(),
          })) {
            continue;
          }
          try {
            await options.redeliverRepositoryWebhookDelivery(options.client, {
              repo: registration.github_repo,
              webhookId: result.webhookId,
              deliveryId: delivery.id,
            });
            const acceptedAt = now().toISOString();
            if (options.store.markGithubWebhookRedeliveryAccepted({
              repository: registration.github_repo,
              webhookId: result.webhookId,
              deliveryId: delivery.id,
              nowIso: acceptedAt,
            })) {
              options.store.requeueDeliveryAfterProviderRedelivery(
                "github",
                delivery.guid,
                acceptedAt
              );
            }
          } catch (error) {
            const failedAt = now();
            options.store.markGithubWebhookRedeliveryFailed({
              repository: registration.github_repo,
              webhookId: result.webhookId,
              deliveryId: delivery.id,
              error: error instanceof Error ? error.message : String(error),
              retryAt: new Date(failedAt.getTime() + redeliveryRetryMs).toISOString(),
            });
            logger.error(
              `[github-webhook] redelivery request failed for ${registration.github_repo} delivery ${delivery.id}:`,
              error
            );
          }
        }
      } catch (error) {
        logger.error(
          `[github-webhook] reconciliation failed for ${registration.github_repo} hook ${registration.webhook_id}:`,
          error
        );
      }
    });
  };
}
