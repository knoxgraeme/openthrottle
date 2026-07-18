import type { TicketStore, WebhookDelivery } from "./db.js";
import { sanitizeText } from "./sanitize.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface WebhookDeliveryProcessor {
  process(deliveryId: string): Promise<void>;
  drain(): Promise<void>;
}

export function createWebhookDeliveryProcessor(params: {
  store: TicketStore;
  handler: (delivery: WebhookDelivery) => Promise<void>;
  onDead?: (delivery: WebhookDelivery, error: unknown) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  leaseMs?: number;
}): WebhookDeliveryProcessor {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = params.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;

  const process = async (deliveryId: string): Promise<void> => {
    const now = Date.now();
    const delivery = params.store.claimDeliveryForProcessing({
      deliveryId,
      nowIso: new Date(now).toISOString(),
      leaseUntilIso: new Date(now + leaseMs).toISOString(),
    });
    if (!delivery) return;

    try {
      await params.handler(delivery);
      params.store.markDeliveryProcessed(delivery.id);
    } catch (error) {
      const message = sanitizeText(String(error)).slice(-4_000);
      const retryAt =
        delivery.attempts >= maxAttempts
          ? null
          : new Date(Date.now() + baseDelayMs * 2 ** (delivery.attempts - 1)).toISOString();
      params.store.markDeliveryFailed(delivery.id, message, retryAt);
      if (!retryAt && params.onDead) {
        try {
          await params.onDead(delivery, error);
        } catch (notificationError) {
          console.error(
            `[webhooks/${delivery.source}] failed to report dead delivery ${delivery.id}:`,
            notificationError
          );
        }
      }
      throw error;
    }
  };

  return {
    process,
    async drain() {
      const processable = params.store.listProcessableDeliveries(new Date().toISOString(), 50);
      for (const delivery of processable) {
        try {
          await process(delivery.id);
        } catch (error) {
          console.error(`[webhooks/${delivery.source}] delivery ${delivery.id} failed:`, error);
        }
      }
    },
  };
}
