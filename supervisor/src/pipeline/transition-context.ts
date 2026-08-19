import { canonicalJson } from "@openthrottle/contracts";
import type { PipelineCoordinatorEvent } from "./coordinator.js";

function transitionFindings(value: unknown): Array<{ severity: string; code: string | null; summary: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, 20)
    .map((item) => ({
      severity: typeof item.severity === "string" ? item.severity.slice(0, 20) : "",
      code: typeof item.code === "string" ? item.code.slice(0, 100) : null,
      summary: typeof item.summary === "string" ? item.summary.slice(0, 500) : "",
    }));
}

export function transitionContext(event: PipelineCoordinatorEvent, fromStage: string): string {
  const stageResult = event.artifacts?.find((artifact) => artifact.kind === "stage_result");
  const review = event.artifacts?.find((artifact) => artifact.kind === "review");
  let summary = "";
  let evidence: string[] = [];
  let findings: ReturnType<typeof transitionFindings> = [];
  if (stageResult) {
    try {
      const payload = JSON.parse(stageResult.payload) as { summary?: unknown; evidence?: unknown; findings?: unknown };
      if (typeof payload.summary === "string") summary = payload.summary.slice(0, 2_000);
      if (Array.isArray(payload.evidence)) {
        evidence = payload.evidence
          .filter((item): item is string => typeof item === "string")
          .slice(0, 20)
          .map((item) => item.slice(0, 1_000));
      }
      findings = transitionFindings(payload.findings);
    } catch {
      // Gate validation owns artifact syntax; control-event fixtures may omit it.
    }
  }
  if (findings.length === 0 && review) {
    try {
      findings = transitionFindings((JSON.parse(review.payload) as { findings?: unknown }).findings);
    } catch {
      // Same rationale as above.
    }
  }
  return canonicalJson({ from_stage: fromStage, event_kind: event.kind, outcome: event.outcome, summary, evidence, findings });
}
