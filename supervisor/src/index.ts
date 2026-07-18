import { serve } from "@hono/node-server";
import { Daytona } from "@daytona/sdk";
import { loadConfig } from "./config.js";
import { openDb, createTicketStore } from "./db.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./server.js";
import { runSweep } from "./sweep.js";
import { createLinearClientProvider } from "./linear-auth.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 min while awake; SPEC only requires "on every boot" + periodic while awake
const DELIVERY_DRAIN_INTERVAL_MS = 30 * 1000;

async function main() {
  const cfg = loadConfig();

  const db = openDb(cfg.databasePath);
  const store = createTicketStore(db);

  const daytona = new Daytona({ apiKey: cfg.daytonaApiKey });
  const getLinearClient = createLinearClientProvider(cfg, store);
  const deliveryProcessor = createServerWebhookDeliveryProcessor({
    cfg,
    store,
    daytona,
    getLinearClient,
  });

  const app = createServer({ cfg, store, daytona, getLinearClient, deliveryProcessor });

  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[supervisor] listening on :${info.port}`);
  });

  // Run once on boot, then on an interval while the process stays awake.
  deliveryProcessor.drain().catch((err) => console.error("[webhooks] boot drain failed:", err));
  getLinearClient()
    .then((linear) => runSweep(daytona, store, linear, cfg))
    .catch((err) => console.error("[sweep] boot sweep failed:", err));
  setInterval(() => {
    deliveryProcessor
      .drain()
      .catch((err) => console.error("[webhooks] interval drain failed:", err));
  }, DELIVERY_DRAIN_INTERVAL_MS).unref();
  setInterval(() => {
    getLinearClient()
      .then((linear) => runSweep(daytona, store, linear, cfg))
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
