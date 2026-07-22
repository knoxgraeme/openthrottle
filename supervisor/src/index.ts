import { serve } from "@hono/node-server";
import { Daytona } from "@daytona/sdk";
import { loadConfig } from "./config.js";
import { openDb, createTicketStore } from "./db.js";
import { completeRun, createServer, createServerWebhookDeliveryProcessor } from "./server.js";
import { runSweep } from "./sweep.js";
import { createLinearClientProvider } from "./linear-auth.js";
import { captureCodexAuthJson } from "./codex-auth.js";
import { pollSandboxEvents } from "./sandbox-events.js";
import { deliverPendingInbox } from "./inbox.js";
import { reapStalledRuns } from "./reaper.js";
import { activityPayload, createLinearOutboxProcessor, enqueueSessionUpdate } from "./linear-outbox.js";
import { loadPipelineCatalog } from "./pipeline-manifest.js";
import { createPipelineStore } from "./pipeline-store.js";
import { loadRuntimeCapabilityDescriptor } from "./sandbox-runtime.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 min while awake; SPEC only requires "on every boot" + periodic while awake
const DELIVERY_DRAIN_INTERVAL_MS = 30 * 1000;
// Liveness reap runs far more often than the hard-timeout sweep so a stalled
// run is caught within ~a minute of crossing STALL_TIMEOUT_SECONDS.
const REAP_INTERVAL_MS = 60 * 1000;

async function main() {
  const cfg = loadConfig();

  const db = openDb(cfg.databasePath);
  const store = createTicketStore(db);
  const pipelineStore = createPipelineStore(db);
  const runtimeCapabilities = loadRuntimeCapabilityDescriptor(
    cfg.sandboxRuntimeDescriptorPath,
    cfg.sandboxRuntimeRelease
  );
  // Catalog wishes and runtime evidence are built independently, then checked
  // against one another before either is accepted into the durable ledger.
  const pipelineCatalog = loadPipelineCatalog(
    cfg.pipelineCatalogPath,
    runtimeCapabilities.descriptor
  );
  pipelineStore.acceptRuntimeDescriptor(runtimeCapabilities);
  pipelineStore.acceptCatalog(pipelineCatalog);

  const daytona = new Daytona({ apiKey: cfg.daytonaApiKey });
  const getLinearClient = createLinearClientProvider(cfg, store);
  const linearOutboxProcessor = createLinearOutboxProcessor({ store, getLinearClient });
  const deliveryProcessor = createServerWebhookDeliveryProcessor({
    cfg,
    store,
    daytona,
    getLinearClient,
    linearOutbox: linearOutboxProcessor,
    pipelineAdmission: {
      catalog: pipelineCatalog,
      runtime: runtimeCapabilities,
      store: pipelineStore,
    },
  });

  const app = createServer({
    cfg,
    store,
    daytona,
    getLinearClient,
    deliveryProcessor,
    linearOutboxProcessor,
  });

  let sandboxPollRunning = false;
  const pollActiveSandboxes = async () => {
    if (sandboxPollRunning) return;
    sandboxPollRunning = true;
    try {
      await pollSandboxEvents({
        daytona,
        store,
        postActivity: async (activity, event) => {
          const row = store.enqueueLinearOutbox({
            id: event.event_id,
            linearSessionId: activity.sessionId,
            issueId: event.issueId,
            runId: event.run_id,
            kind: "activity",
            payload: activityPayload(activity),
          });
          await linearOutboxProcessor.process(row.id);
        },
        postSessionUpdate: (params) =>
          enqueueSessionUpdate(store, linearOutboxProcessor, {
            id: params.eventId,
            sessionId: params.sessionId,
            issueId: params.issueId,
            plan: params.plan,
          }),
        finishCompletion: (completion) =>
          completeRun(
            {
              cfg,
              store,
              daytona,
              getLinearClient,
              linearOutbox: linearOutboxProcessor,
              schedule: (task) => void task.catch((error) =>
                console.error("[sandbox-events] follow-up task failed:", error)
              ),
            },
            completion
          ),
        captureAgentAuth: async (sandbox, ticket) => {
          // Codex rotates its OAuth refresh token inside the sandbox; persist
          // it so the next run seeds the live token instead of a spent one.
          if (ticket.agent !== "codex") return;
          try {
            const raw = (
              await sandbox.fs.downloadFile("/home/agent/.codex/auth.json")
            ).toString("utf8");
            if (captureCodexAuthJson(store, raw)) {
              console.log("[codex-auth] captured a rotated refresh token from the sandbox");
            }
          } catch (error) {
            console.warn("[codex-auth] could not read back ~/.codex/auth.json:", error);
          }
        },
      });
      // Deliver any queued mid-run steering into running sandboxes on the same
      // fast cadence, so a steer reaches the agent within one poll interval.
      await deliverPendingInbox({ daytona, store });
    } finally {
      sandboxPollRunning = false;
    }
  };

  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[supervisor] listening on :${info.port}`);
  });

  // Run once on boot, then on an interval while the process stays awake.
  deliveryProcessor.drain().catch((err) => console.error("[webhooks] boot drain failed:", err));
  linearOutboxProcessor.drain().catch((err) => console.error("[linear-outbox] boot drain failed:", err));
  pollActiveSandboxes().catch((err) => console.error("[sandbox-events] boot poll failed:", err));
  getLinearClient()
    .then((linear) => runSweep(daytona, store, linear, cfg))
    .catch((err) => console.error("[sweep] boot sweep failed:", err));
  const reapStalled = () =>
    reapStalledRuns({ daytona, store, linearOutbox: linearOutboxProcessor, cfg }).catch((err) =>
      console.error("[reaper] stall reap failed:", err)
    );
  reapStalled();
  setInterval(reapStalled, REAP_INTERVAL_MS).unref();
  setInterval(() => {
    deliveryProcessor
      .drain()
      .catch((err) => console.error("[webhooks] interval drain failed:", err));
    linearOutboxProcessor
      .drain()
      .catch((err) => console.error("[linear-outbox] interval drain failed:", err));
  }, DELIVERY_DRAIN_INTERVAL_MS).unref();
  setInterval(() => {
    pollActiveSandboxes().catch((err) =>
      console.error("[sandbox-events] interval poll failed:", err)
    );
  }, cfg.sandboxEventPollIntervalMs).unref();
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
