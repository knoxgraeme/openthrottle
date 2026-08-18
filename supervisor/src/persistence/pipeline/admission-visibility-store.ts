import type Database from "better-sqlite3";
import type {
  AdmissionDetailProjection,
  AdmissionProjection,
  PipelineStore,
} from "../../pipeline/store.js";

export interface AdmissionProjectionRow {
  pipeline_instance_id: string;
  proposed_route: AdmissionProjection["proposed_route"];
  final_route: AdmissionProjection["final_route"];
  semantic_repair_count: number;
  infrastructure_retry_count: number;
  terminal_state: string | null;
  questions: string;
  reviewer_verdict: AdmissionProjection["reviewer_verdict"];
  planner_skill_reference: string;
  planner_package_digest: string | null;
  reviewer_skill_reference: string;
  reviewer_package_digest: string | null;
  admission_basis_digest: string;
  effective_manifest_digest: string;
  generated_plan_digest: string | null;
  checkpoint_digest: string | null;
  accepted_plan_artifact_hash: string | null;
  reviewer_receipt_artifact_hash: string | null;
  created_at: string;
  updated_at: string;
}

export function mapAdmissionProjectionRow(row: AdmissionProjectionRow): AdmissionProjection {
  return {
    pipeline_instance_id: row.pipeline_instance_id,
    proposed_route: row.proposed_route,
    final_route: row.final_route,
    semantic_repair_count: row.semantic_repair_count,
    infrastructure_retry_count: row.infrastructure_retry_count,
    terminal_state: row.terminal_state,
    questions: JSON.parse(row.questions) as string[],
    reviewer_verdict: row.reviewer_verdict,
    planner: { reference: row.planner_skill_reference, package_digest: row.planner_package_digest },
    reviewer: { reference: row.reviewer_skill_reference, package_digest: row.reviewer_package_digest },
    admission_basis_digest: row.admission_basis_digest,
    effective_manifest_digest: row.effective_manifest_digest,
    generated_plan_digest: row.generated_plan_digest,
    checkpoint_digest: row.checkpoint_digest,
    accepted_plan_artifact_hash: row.accepted_plan_artifact_hash,
    reviewer_receipt_artifact_hash: row.reviewer_receipt_artifact_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsedArtifactPayload(
  db: Database.Database,
  instanceId: string,
  hash: string | null,
  kind: "execution_plan" | "standard_receipt",
  assurance?: "executor_verified"
): unknown | null {
  if (!hash) return null;
  const row = db.prepare(`
    SELECT payload FROM pipeline_artifacts
    WHERE pipeline_instance_id = ? AND artifact_hash = ? AND kind = ?
      AND (? IS NULL OR assurance = ?)
    LIMIT 1
  `).get(instanceId, hash, kind, assurance ?? null, assurance ?? null) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as unknown : null;
}

export function createAdmissionVisibilityStore(db: Database.Database): Pick<
  PipelineStore,
  "getAdmissionProjection" | "getAdmissionDetail"
> {
  const getProjection = (instanceId: string): AdmissionProjection | undefined => {
    const row = db.prepare("SELECT * FROM pipeline_admission_projections WHERE pipeline_instance_id = ?")
      .get(instanceId) as AdmissionProjectionRow | undefined;
    return row ? mapAdmissionProjectionRow(row) : undefined;
  };
  return {
    getAdmissionProjection: getProjection,
    getAdmissionDetail(instanceId: string): AdmissionDetailProjection | undefined {
      const value = getProjection(instanceId);
      if (!value) return undefined;
      const planArtifact = parsedArtifactPayload(
        db, instanceId, value.accepted_plan_artifact_hash, "execution_plan", "executor_verified"
      ) as
        | { execution_plan?: unknown }
        | null;
      const reviewArtifact = parsedArtifactPayload(
        db, instanceId, value.reviewer_receipt_artifact_hash, "standard_receipt"
      ) as
        | { details?: { receipt?: unknown } }
        | null;
      return {
        generated_content: true,
        warning: "Automatically generated content. Verify before relying on it.",
        accepted_plan: planArtifact?.execution_plan ?? null,
        reviewer_receipt: reviewArtifact?.details?.receipt ?? null,
      };
    },
  };
}
