export const GITHUB_PUBLICATION_TITLE_MAX_LENGTH = 72;
export const GITHUB_PUBLICATION_BODY_MAX_LENGTH = 12_000;

export interface GithubPublicationSelectionEvidence {
  result_record_id: string;
  acceptance_decision_record_id: string;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  input_subject: string;
}

export interface GithubPublicationProvenance {
  work_item_id: string;
  source_provider: "linear" | "github" | "operator";
  source_id: string;
  source_reference: string;
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return object;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value.includes("\0")
  ) throw new Error(`${label} is invalid`);
  return value;
}

export function validateGithubPublicationSelection(
  value: unknown,
  pipelineRunId: string,
): GithubPublicationSelectionEvidence {
  const selection = exactObject(value, "GitHub publication selection", [
    "result_record_id", "acceptance_decision_record_id", "pipeline_run_id",
    "definition_bundle_hash", "input_subject",
  ]);
  if (
    typeof selection.result_record_id !== "string" ||
    !/^result-[a-f0-9]{48}$/.test(selection.result_record_id) ||
    typeof selection.acceptance_decision_record_id !== "string" ||
    !/^decision-[a-f0-9]{48}$/.test(selection.acceptance_decision_record_id) ||
    selection.pipeline_run_id !== pipelineRunId ||
    typeof selection.definition_bundle_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(selection.definition_bundle_hash) ||
    typeof selection.input_subject !== "string" ||
    !/^[a-f0-9]{40}$/.test(selection.input_subject)
  ) throw new Error("GitHub publication selection is invalid or inconsistent");
  return selection as unknown as GithubPublicationSelectionEvidence;
}

export function validateGithubPublicationProvenance(
  value: unknown,
): GithubPublicationProvenance {
  const provenance = exactObject(value, "GitHub publication provenance", [
    "work_item_id", "source_provider", "source_id", "source_reference",
  ]);
  boundedString(provenance.work_item_id, "GitHub publication work item ID", 200);
  boundedString(provenance.source_id, "GitHub publication source ID", 300);
  boundedString(provenance.source_reference, "GitHub publication source reference", 300);
  if (!(["linear", "github", "operator"] as const).includes(
    provenance.source_provider as "linear" | "github" | "operator",
  )) throw new Error("GitHub publication source provider is invalid");
  return provenance as unknown as GithubPublicationProvenance;
}

export function validateGithubVerifiedGateRecordIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("GitHub publication verified gate record IDs are invalid");
  }
  const ids = value.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      !/^(?:result|decision)-[a-f0-9]{48}$/.test(candidate)
    ) throw new Error("GitHub publication verified gate record IDs are invalid");
    return candidate;
  });
  const canonical = [...new Set(ids)].sort();
  if (canonical.length !== ids.length || canonical.some((id, index) => id !== ids[index])) {
    throw new Error("GitHub publication verified gate record IDs are not canonical");
  }
  return ids;
}

export function assertGithubPublicationCopy(title: unknown, body: unknown): asserts title is string {
  if (
    typeof title !== "string" || title.length < 1 ||
    title.length > GITHUB_PUBLICATION_TITLE_MAX_LENGTH ||
    typeof body !== "string" || body.length < 1 ||
    body.length > GITHUB_PUBLICATION_BODY_MAX_LENGTH
  ) throw new Error("GitHub publication title or body is empty or exceeds its bound");
}

export function isGithubPublicationOwnershipMarker(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9:_-]{16,200}$/.test(value);
}

export function buildGithubPullRequestBody(body: string, ownershipMarker: string): string {
  return `${body.trimEnd()}\n\n<!-- ${ownershipMarker} -->\n`;
}
