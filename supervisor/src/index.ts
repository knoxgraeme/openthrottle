import { digestCanonicalJson, type ExecutionRecordPayloadRegistry } from "@openthrottle/contracts";
import { loadConfig } from "./app/config.js";
import { openKernelEpoch } from "./app/kernel-bootstrap.js";
import {
  PolicyEnforcedKernelRuntimeCompatibility,
  VerifiedKernelDefinitionBundleResolver,
  VerifiedKernelManifestResolver,
} from "./app/kernel-composition.js";
import { KernelControlService } from "./app/kernel-control.js";
import { KernelHttpService, type KernelRepositorySetupPort } from "./app/kernel-http.js";
import {
  ADMISSION_PROMOTION_RECORD_PAYLOAD_CONTRACT,
  ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
  KernelAdmissionSettlementPlanner,
} from "./app/kernel-admission-promotion.js";
import { KernelAdmissionInboxHandler } from "./app/kernel-inbox-handler.js";
import { KernelInboxRouter } from "./app/kernel-inbox-router.js";
import { KernelProviderPromptHandler } from "./app/kernel-provider-prompt.js";
import { loadKernelReleaseDefinitions } from "./app/kernel-release.js";
import { KernelRuntimeSessionService } from "./app/kernel-runtime-session.js";
import { KernelStructuredSettlementPlanner } from "./app/kernel-structured-planner.js";
import { listen } from "./http/listener.js";
import { createServer } from "./http/server.js";
import {
  KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT,
  KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
  createKernelEffectAdapterRegistry,
  createKernelEffectExecutionService,
} from "./operations/kernel-effects.js";
import {
  KernelExternalBoundaryCoordinator,
  externalKernelPayloadSchemas,
} from "./operations/kernel-external-boundary.js";
import {
  createKernelExternalStagePlanRegistry,
  type KernelExternalStagePlanRegistry,
} from "./operations/kernel-external-plans.js";
import { createKernelExternalPlanBindings } from "./operations/kernel-plan-bindings.js";
import { KernelWorker } from "./operations/kernel-worker.js";
import { createKernelHistoricalAnalysisStore } from "./persistence/kernel-analysis-store.js";
import { SqliteKernelCodexAuthStore } from "./persistence/kernel-codex-auth-store.js";
import { SqliteKernelInboxStore } from "./persistence/kernel-inbox-store.js";
import { SqliteKernelProjectionStore } from "./persistence/kernel-projection-store.js";
import { SqliteKernelRegistrationStore } from "./persistence/kernel-registration-store.js";
import { SqliteKernelRunEnvironmentStore } from "./persistence/kernel-runtime-context-store.js";
import { SqliteKernelStore } from "./persistence/kernel-store.js";
import { ordinaryKernelPayloadSchemas } from "./pipeline/kernel/evaluator-registry.js";
import { OrdinaryKernelCoordinator } from "./pipeline/kernel/ordinary-coordinator.js";
import { createKernelCredentialMaterializer } from "./providers/codex/auth.js";
import { createDaytonaKernelAdapter } from "./providers/daytona/kernel-adapter.js";
import { GithubKernelAdapter } from "./providers/github/kernel-adapter.js";
import { KernelAdmissionPromotionAdapter } from "./providers/kernel/admission-promotion.js";
import {
  ensureRepositoryControlLabel,
  getRepositoryDefinitionSourceAtCommit,
  prepareRepository,
} from "./providers/github/client.js";
import type { KernelRuntimeCompatibilityPort } from "./runtime/kernel-contracts.js";

const WORK_RETRY_LIMIT = 3;
const RESULT_CORRECTION_LIMIT = 2;

function payloadSchemas(): ExecutionRecordPayloadRegistry {
  return new Map([
    ...ordinaryKernelPayloadSchemas(),
    ...externalKernelPayloadSchemas(),
    [KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA, KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT],
    [ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA, ADMISSION_PROMOTION_RECORD_PAYLOAD_CONTRACT],
  ]);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const release = loadKernelReleaseDefinitions({
    release_root: cfg.releaseRoot,
    generated_root: cfg.generatedDefinitionRoot,
  });
  const epoch = openKernelEpoch({
    database_path: cfg.databasePath,
    blob_store_path: cfg.blobStorePath,
    blob_store_id: cfg.blobStoreId,
    release_id: cfg.epochReleaseId,
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
  });
  const manifestResolver = new VerifiedKernelManifestResolver({
    compiler_environment: release.compiler_environment,
    trusted_platform_definitions: release.trusted_platform_definitions,
  });
  const kernel = new SqliteKernelStore({
    db: epoch.db,
    blob_store: epoch.blobs,
    manifest_resolver: manifestResolver,
    payload_schemas: payloadSchemas(),
    execution_policy: release.execution_policy,
  });
  const bundles = new VerifiedKernelDefinitionBundleResolver({
    bytes: kernel,
    trusted_platform_definitions: release.trusted_platform_definitions,
  });
  const registrations = new SqliteKernelRegistrationStore({ db: epoch.db });
  const inbox = new SqliteKernelInboxStore({ db: epoch.db, blob_store: epoch.blobs });
  const projections = new SqliteKernelProjectionStore({ db: epoch.db });
  const environments = new SqliteKernelRunEnvironmentStore({ db: epoch.db });
  const sessions = new KernelRuntimeSessionService({ transitions: kernel });
  const codexAuth = new SqliteKernelCodexAuthStore({ db: epoch.db });
  const sourceReader = {
    read: (repository: string, commit: string) => getRepositoryDefinitionSourceAtCommit(
      { token: cfg.githubReadToken }, repository, commit,
    ),
  };
  const daytona = createDaytonaKernelAdapter({
    api_key: cfg.daytonaApiKey,
    snapshot: cfg.daytonaSnapshot,
    github_read_token: cfg.githubReadToken,
    task_timeout_seconds: cfg.taskTimeout,
    runtime_capability_digest: release.compiler_environment.descriptor.runtime_capability_digest,
    blob_store: epoch.blobs,
    environments,
    attempt_inputs: kernel,
    materialize_model_credentials: createKernelCredentialMaterializer(cfg, codexAuth),
  });
  const github = new GithubKernelAdapter({ token: cfg.githubToken, blob_store: epoch.blobs });
  let externalPlans: KernelExternalStagePlanRegistry | null = null;
  const providerRuntimeCompatibility: KernelRuntimeCompatibilityPort = {
    async assertCompatible(input) {
      daytona.assertCompatible(input);
      if (externalPlans === null) throw new Error("external plan registry is not initialized");
      externalPlans.assertCompatible(input.stages);
    },
  };
  const runtimeCompatibility = new PolicyEnforcedKernelRuntimeCompatibility({
    execution_policy: release.execution_policy,
    downstream: providerRuntimeCompatibility,
  });
  const admissionPromotion = new KernelAdmissionPromotionAdapter({
    source_reader: sourceReader,
    platform: release.platform,
    compiler_environment: release.compiler_environment,
    runtime: runtimeCompatibility,
    blob_store: epoch.blobs,
    store: kernel,
    work_retry_limit: WORK_RETRY_LIMIT,
    result_correction_limit: RESULT_CORRECTION_LIMIT,
  });
  const effectAdapters = createKernelEffectAdapterRegistry([
    ...daytona.effectBindings(),
    ...github.effectBindings(),
    admissionPromotion.effectBinding(),
  ]);
  externalPlans = createKernelExternalStagePlanRegistry({
    effects: effectAdapters,
    plans: createKernelExternalPlanBindings({ environments, blob_store: epoch.blobs }),
  });
  const admissionSettlement = new KernelAdmissionSettlementPlanner({ store: kernel });
  const structuredSettlement = new KernelStructuredSettlementPlanner({ store: kernel });
  const ordinarySettlement = {
    plan(input: Parameters<KernelAdmissionSettlementPlanner["plan"]>[0]) {
      return input.view.run.pipeline_id === "core/admission"
        ? admissionSettlement.plan(input)
        : structuredSettlement.plan(input);
    },
  };
  const ordinary = new OrdinaryKernelCoordinator({
    store: kernel,
    definition_bundles: bundles,
    runtime: daytona,
    runtime_sessions: sessions,
    settlement_planner: ordinarySettlement,
    attempt_lease_duration_ms: cfg.kernelLeaseSeconds * 1_000,
  });
  const external = new KernelExternalBoundaryCoordinator({
    store: kernel,
    definition_bundles: bundles,
    plans: externalPlans,
    settlement_planner: structuredSettlement,
  });
  const effects = createKernelEffectExecutionService({ effects: kernel, adapters: effectAdapters });
  const inboxHandler = new KernelAdmissionInboxHandler({
    registrations,
    github_token: cfg.githubReadToken,
    source_reader: sourceReader,
    platform: release.platform,
    compiler_environment: release.compiler_environment,
    runtime: runtimeCompatibility,
    blob_store: epoch.blobs,
    store: kernel,
  });
  const control = new KernelControlService({
    inbox,
    maintenance: inbox,
    runtime_sessions: sessions,
    active_work: projections,
    runtime_inventory: daytona,
  });
  const providerPrompts = new KernelProviderPromptHandler({
    runs: registrations,
    projections,
    control: {
      requestRunControl: (input) => ordinary.requestRunControl(input),
      enqueueSteering: (input) => control.enqueueSteering(input),
    },
  });
  const inboxRouter = new KernelInboxRouter({
    admission: inboxHandler,
    run_control: ordinary,
    steering_authority: control,
    steering_delivery: daytona,
    provider_prompts: providerPrompts,
  });
  const worker = new KernelWorker({
    attempts: kernel,
    ordinary,
    external,
    effects,
    inbox,
    inbox_handler: inboxRouter,
    worker_id: cfg.kernelWorkerId,
    lease_seconds: cfg.kernelLeaseSeconds,
    cycle_limit: cfg.kernelCycleLimit,
  });

  const service = new KernelHttpService({
    registrations,
    projections,
    analysis: createKernelHistoricalAnalysisStore(epoch.db),
    control,
  });
  const repositorySetup: KernelRepositorySetupPort = {
    async prepare(input) {
      const readiness = await prepareRepository(
        { token: cfg.githubToken },
        {
          repo: input.repo,
          ...(input.baseBranch ? { requestedBaseBranch: input.baseBranch } : {}),
          webhookUrl: `${cfg.supervisorUrl}/webhooks/github`,
          webhookSecret: cfg.githubWebhookSecret,
        },
      );
      const label = input.controlProvider === "github"
        ? await ensureRepositoryControlLabel({ token: cfg.githubToken }, readiness.repo)
        : undefined;
      const linearTeamKey = input.controlProvider === "linear" ? input.linearTeamKey ?? null : null;
      if (input.controlProvider === "linear" && linearTeamKey === null) {
        throw new Error("Linear registration requires a team key");
      }
      return {
        registration: {
          id: `registration-${digestCanonicalJson({
            provider: input.controlProvider,
            repo: readiness.repo.toLowerCase(),
            route: input.controlProvider === "linear" ? input.linearTeamId ?? linearTeamKey : readiness.repo,
          }).slice(0, 48)}`,
          control_provider: input.controlProvider,
          linear_team_id: input.controlProvider === "linear"
            ? input.linearTeamId ?? `key:${linearTeamKey}`
            : null,
          linear_team_key: linearTeamKey,
          github_repo: readiness.repo,
          github_installation_id: null,
          base_branch: readiness.baseBranch,
          webhook_id: readiness.webhookId,
          runtime_snapshot: cfg.daytonaSnapshot,
        },
        readiness: {
          github: "ready" as const,
          webhook: readiness.webhookAction,
          snapshot: { name: cfg.daytonaSnapshot, state: "configured" },
          ...(label ? { controlLabel: label } : {}),
        },
      };
    },
  };
  const app = createServer({
    cfg,
    capabilities: {
      release: cfg.epochReleaseId,
      capability_digest: release.execution_policy.runtime_capability_digest,
      capabilities: [
        release.runtime_capabilities.protocol,
        ...release.runtime_capabilities.engines.map((engine) => `engine:${engine}`),
        ...release.runtime_capabilities.executor_primitives,
      ],
      execution_policy: release.execution_policy,
      task_timeout_seconds: cfg.taskTimeout,
    },
    service,
    repository_setup: repositorySetup,
  });

  let cycleRunning = false;
  const abort = new AbortController();
  const runCycle = async () => {
    if (cycleRunning || abort.signal.aborted) return;
    cycleRunning = true;
    try {
      await worker.runCycle(abort.signal);
    } catch (error) {
      console.error("[kernel-worker] cycle failed:", error);
    } finally {
      cycleRunning = false;
    }
  };
  listen(app, cfg.port, (info) => console.log(`[supervisor] fresh kernel listening on :${info.port}`));
  await runCycle();
  setInterval(() => void runCycle(), cfg.kernelWorkerIntervalMs).unref();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      abort.abort(new Error(`received ${signal}`));
      if (epoch.db.open) epoch.db.close();
      process.exit(0);
    });
  }
}

main().catch((error: unknown) => {
  console.error("[supervisor] fatal fresh-kernel boot error:", error);
  process.exit(1);
});
