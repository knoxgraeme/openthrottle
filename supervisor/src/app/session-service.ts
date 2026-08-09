import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type {
  ActivityPublicationPort,
  LinearAgentSessionEvent,
  LinearLabelPort,
  MergePort,
  RepositoryReadPort,
} from "./ports.js";
import type { ValidatedPipelineCatalog } from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "../runtime/contracts.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import { handleCreated } from "./admission.js";
import { handlePrompted } from "./thread-control.js";

export interface SessionServicePorts {
  activityPublisher: ActivityPublicationPort;
  labelResolver: LinearLabelPort;
  repositoryReader: RepositoryReadPort;
  merger: MergePort;
}

export interface PipelineCoordinatorContext {
  catalog: ValidatedPipelineCatalog;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  store: PipelineStore;
  drainEffects?: () => Promise<void>;
  reconcileWaitingProviderSuccessor?: (instanceId: string) => Promise<void>;
}

export async function handleLinearEvent(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: LinearAgentSessionEvent,
  coordinator: PipelineCoordinatorContext,
  preflight?: AdmissionPreflight
): Promise<void> {
  if (payload.action === "created") {
    await handleCreated(cfg, store, providers, payload, coordinator, preflight);
  } else {
    await handlePrompted(cfg, store, providers, payload, coordinator);
  }
}
