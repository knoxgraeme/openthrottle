import { serve } from "@hono/node-server";
import { SpritesClient } from "./sprites.js";
import { loadConfig } from "./config.js";
import { openDb, createTicketStore } from "./db.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./server.js";
import { runSweep } from "./sweep.js";
import { createLinearClientProvider } from "./linear-auth.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 min while awake; SPEC only requires "on every boot" + periodic while awake
const DELIVERY_DRAIN_INTERVAL_MS = 30 * 1000;

async function main() {
  const cfg = loadConfig();

  const db = openDb(cfg.databasePath);
  const store = createTicketStore(db);

  const sprites = new SpritesClient(cfg.spriteToken, { baseURL: cfg.spritesApiUrl });
  const getLinearClient = createLinearClientProvider(cfg, store);
  const linearOutboxProcessor = createLinearOutboxProcessor({ store, getLinearClient });
  const deliveryProcessor = createServerWebhookDeliveryProcessor({
    cfg,
    store,
    sprites,
    getLinearClient,
    linearOutbox: linearOutboxProcessor,
  });

  const app = createServer({
    cfg,
    store,
    sprites,
    getLinearClient,
    deliveryProcessor,
    linearOutboxProcessor,
  });

  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[supervisor] listening on :${info.port}`);
  });

  // Sandbox events arrive by push (POST /runs/:id/events + /runs/:id/complete),
  // so there is no sandbox poll loop; the sweep is the only sandbox-touching timer.
  deliveryProcessor.drain().catch((err) => console.error("[webhooks] boot drain failed:", err));
  linearOutboxProcessor.drain().catch((err) => console.error("[linear-outbox] boot drain failed:", err));
  getLinearClient()
    .then((linear) => runSweep(sprites, store, linear, cfg))
    .catch((err) => console.error("[sweep] boot sweep failed:", err));
  setInterval(() => {
    deliveryProcessor
      .drain()
      .catch((err) => console.error("[webhooks] interval drain failed:", err));
    linearOutboxProcessor
      .drain()
      .catch((err) => console.error("[linear-outbox] interval drain failed:", err));
  }, DELIVERY_DRAIN_INTERVAL_MS).unref();
  setInterval(() => {
    getLinearClient()
      .then((linear) => runSweep(sprites, store, linear, cfg))
      .catch((err) => console.error("[sweep] interval sweep failed:", err));
  }, SWEEP_INTERVAL_MS).unref();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[supervisor] received ${sig}, shutting down`);
      db.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[supervisor] fatal boot error:", err);
  process.exit(1);
});
