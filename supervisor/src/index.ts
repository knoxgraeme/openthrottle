import { loadConfig } from "./app/config.js";
import { createSupervisorStore } from "./persistence/store.js";
import { openDb } from "./persistence/database.js";
import { listen } from "./http/listener.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./http/server.js";
import { runSweep } from "./operations/sweep.js";
import { createLinearClientProvider } from "./providers/linear/auth.js";
import {
  captureCodexAuthFromSandbox,
  createCredentialMaterializer,
} from "./providers/codex/auth.js";
import { pollSandboxEvents } from "./runtime/event-poller.js";
import { deliverPendingInbox } from "./runtime/steering.js";
import { reapStalledRuns } from "./operations/reaper.js";
import { activityPayload, createLinearActivityPublisher, createLinearOutboxProcessor, enqueueSessionUpdate } from "./providers/linear/outbox.js";
import { loadPipelineCatalog } from "./pipeline/manifest.js";
import { createPipelineStore } from "./persistence/pipeline/create-store.js";
import { loadRuntimeCapabilityDescriptor } from "./runtime/contracts.js";
import { drainDeferredProviderEvidence } from "./pipeline/gates.js";
import { completeStageAttemptActor } from "./pipeline/settlement.js";
import { createGithubPublicationProcessor } from "./providers/github/pipeline-publication.js";
import { createDaytonaRuntime } from "./providers/daytona/adapter.js";
import { createPipelineEffectProcessor } from "./operations/pipeline-effects.js";
import { drainPipelineFeedbackSnapshots } from "./app/provider-feedback.js";
import { createGithubWebhookReconciler } from "./operations/github-webhook-reconciliation.js";
import { reconcileRepositoryWebhook } from "./providers/github/client.js";
import { canSteerPipelineRun } from "./pipeline/control.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 min while awake; SPEC only requires "on every boot" + periodic while awake
const DELIVERY_DRAIN_INTERVAL_MS = 30 * 1000;
const WEBHOOK_RECONCILIATION_CONCURRENCY = 4;
// Liveness reap runs far more often than the hard-timeout sweep so a stalled
// run is caught within ~a minute of crossing STALL_TIMEOUT_SECONDS.
const REAP_INTERVAL_MS = 60 * 1000;

async function main() {
  const cfg = loadConfig();

  const db = openDb(cfg.databasePath);
  const pipelineStore = createPipelineStore(db);
  const store = createSupervisorStore(db, pipelineStore);
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

  const getLinearClient = createLinearClientProvider(cfg, store);
  const linearOutboxProcessor = createLinearOutboxProcessor({ store, getLinearClient });
  const activityPublisher = createLinearActivityPublisher(store, linearOutboxProcessor);
  const runtime = createDaytonaRuntime({
    apiKey: cfg.daytonaApiKey,
    snapshot: cfg.daytonaSnapshot,
    taskTimeoutSeconds: cfg.taskTimeout,
    materializeCredentialEnv: createCredentialMaterializer(cfg, store),
  });
  const pipelineEffectProcessor = createPipelineEffectProcessor({
    store: pipelineStore,
    tickets: store,
    runtime,
    taskTimeoutSeconds: cfg.taskTimeout,
  });
  const pipelineCoordinator = {
    catalog: pipelineCatalog,
    runtime: runtimeCapabilities,
    store: pipelineStore,
    drainEffects: () => pipelineEffectProcessor.drain(),
  };
  const githubPublicationProcessor = createGithubPublicationProcessor({
    store: pipelineStore,
    tickets: store,
    client: { token: cfg.githubToken },
  });
  const reconcileGithubWebhooks = createGithubWebhookReconciler({
    store,
    client: { token: cfg.githubToken },
    webhookUrl: `${cfg.supervisorUrl}/webhooks/github`,
    webhookSecret: cfg.githubWebhookSecret,
    reconcileRepositoryWebhook,
    concurrency: WEBHOOK_RECONCILIATION_CONCURRENCY,
  });
  const deliveryProcessor = createServerWebhookDeliveryProcessor({
    cfg,
    store,
    runtime,
    getLinearClient,
    linearOutbox: linearOutboxProcessor,
    pipelineCoordinator,
  });

  const app = createServer({
    cfg,
    store,
    runtime,
    getLinearClient,
    deliveryProcessor,
    linearOutboxProcessor,
    pipelineCoordinator,
  });
  const drainLinearAndDeferredProvider = async () => {
    await linearOutboxProcessor.drain();
    const deferred = drainDeferredProviderEvidence(pipelineStore);
    const feedback = drainPipelineFeedbackSnapshots(pipelineStore, store);
    if (deferred + feedback > 0) {
      await pipelineEffectProcessor.drain();
    }
  };

  let sandboxPollRunning = false;
  const pollActiveSandboxes = async () => {
    if (sandboxPollRunning) return;
    sandboxPollRunning = true;
    try {
      await pollSandboxEvents({
        runtime,
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
        postStageResult: async (event, observedSubject) => {
          completeStageAttemptActor(
            pipelineStore,
            store,
            {
              id: event.event_id,
              kind: "stage_result",
              instanceId: event.pipeline_instance_id,
              generation: event.generation,
              runId: event.run_id,
              stageId: event.stage_id,
              attemptId: event.attempt_id,
              requestHash: event.request_hash,
              outcome: event.outcome,
              resultHash: event.result_hash,
              subject: event.subject,
              nativeSessionId: event.native_session_id,
              artifacts: event.artifacts,
            },
            { observedSubject }
          );
          await pipelineEffectProcessor.drain();
        },
        captureAgentAuth: (sandbox, ticket) => captureCodexAuthFromSandbox(store, sandbox, ticket),
      });
      // Deliver any queued mid-run steering into running sandboxes on the same
      // fast cadence, so a steer reaches the agent within one poll interval.
      await deliverPendingInbox({
        runtime,
        store,
        canReceiveSteering: (ticket) => canSteerPipelineRun({
          store: pipelineStore,
          sessionId: ticket.linear_session_id,
          runId: ticket.run_id,
          agent: ticket.agent,
        }),
      });
    } finally {
      sandboxPollRunning = false;
    }
  };

  listen(app, cfg.port, (info) => {
    console.log(`[supervisor] listening on :${info.port}`);
  });

  // Run once on boot, then on an interval while the process stays awake.
  deliveryProcessor.drain().catch((err) => console.error("[webhooks] boot drain failed:", err));
  drainLinearAndDeferredProvider().catch((err) => console.error("[linear-outbox] boot drain failed:", err));
  githubPublicationProcessor.drain().catch((err) => console.error("[github-publication] boot drain failed:", err));
  pipelineEffectProcessor.drain().catch((err) => console.error("[pipeline-effects] boot drain failed:", err));
  pollActiveSandboxes().catch((err) => console.error("[sandbox-events] boot poll failed:", err));
  runSweep(runtime, store, cfg, pipelineStore, activityPublisher, reconcileGithubWebhooks)
    .catch((err) => console.error("[sweep] boot sweep failed:", err));
  const reapStalled = () =>
    reapStalledRuns({ runtime, store, activityPublisher, cfg, pipelines: pipelineStore }).catch((err) =>
      console.error("[reaper] stall reap failed:", err)
    );
  reapStalled();
  setInterval(reapStalled, REAP_INTERVAL_MS).unref();
  setInterval(() => {
    deliveryProcessor
      .drain()
      .catch((err) => console.error("[webhooks] interval drain failed:", err));
    drainLinearAndDeferredProvider()
      .catch((err) => console.error("[linear-outbox] interval drain failed:", err));
    githubPublicationProcessor
      .drain()
      .catch((err) => console.error("[github-publication] interval drain failed:", err));
    pipelineEffectProcessor
      .drain()
      .catch((err) => console.error("[pipeline-effects] interval drain failed:", err));
  }, DELIVERY_DRAIN_INTERVAL_MS).unref();
  setInterval(() => {
    pollActiveSandboxes().catch((err) =>
      console.error("[sandbox-events] interval poll failed:", err)
    );
  }, cfg.sandboxEventPollIntervalMs).unref();
  setInterval(() => {
    runSweep(runtime, store, cfg, pipelineStore, activityPublisher, reconcileGithubWebhooks)
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
