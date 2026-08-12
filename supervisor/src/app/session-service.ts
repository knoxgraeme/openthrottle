import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type {
  ActivityPublicationPort,
  ControlLabelPort,
  ControlThreadEvent,
  MergePort,
  RepositoryReadPort,
} from "./ports.js";
import type { ValidatedPipelineCatalog } from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "../runtime/contracts.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import type { RunOutcome } from "../pipeline/store.js";
import { handleCreated } from "./admission.js";
import { handlePrompted } from "./thread-control.js";

export interface SessionServicePorts {
  activityPublisher: ActivityPublicationPort;
  labelResolver: ControlLabelPort;
  repositoryReader: RepositoryReadPort;
  merger: MergePort;
}

export interface PipelineCoordinatorContext {
  catalog: ValidatedPipelineCatalog;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  store: PipelineStore;
  drainEffects?: () => Promise<void>;
  tuneCorpus?: {
    listRunOutcomes(query: {
      outcome?: string;
      reason?: string;
      attribution?: string;
      graph?: string;
      skillDigest?: string;
      from?: string;
      to?: string;
      limit?: number;
    }): RunOutcome[];
  };
}

export async function handleControlEvent(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: ControlThreadEvent,
  coordinator: PipelineCoordinatorContext,
  preflight?: AdmissionPreflight,
  receivedAt?: string
): Promise<void> {
  if (payload.action === "created") {
    await handleCreated(cfg, store, providers, payload, coordinator, preflight);
  } else {
    await handlePrompted(cfg, store, providers, payload, coordinator, receivedAt);
  }
}
