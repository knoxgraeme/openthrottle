import { serve } from "@hono/node-server";
import { Daytona } from "@daytonaio/sdk";
import { loadConfig } from "./config.js";
import { openDb, createTicketStore } from "./db.js";
import { createServer } from "./server.js";
import { runSweep } from "./sweep.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 min while awake; SPEC only requires "on every boot" + periodic while awake

async function main() {
  const cfg = loadConfig();

  const db = openDb(cfg.databasePath);
  const store = createTicketStore(db);

  const daytona = new Daytona({ apiKey: cfg.daytonaApiKey });

  const app = createServer({ cfg, store, daytona });

  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[supervisor] listening on :${info.port}`);
  });

  const linear = store.getSetting("linear_access_token")
    ? { accessToken: store.getSetting("linear_access_token")! }
    : undefined;

  // Run once on boot, then on an interval while the process stays awake.
  runSweep(daytona, store, linear, cfg).catch((err) =>
    console.error("[sweep] boot sweep failed:", err)
  );
  setInterval(() => {
    const currentLinear = store.getSetting("linear_access_token")
      ? { accessToken: store.getSetting("linear_access_token")! }
      : undefined;
    runSweep(daytona, store, currentLinear, cfg).catch((err) =>
      console.error("[sweep] interval sweep failed:", err)
    );
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
