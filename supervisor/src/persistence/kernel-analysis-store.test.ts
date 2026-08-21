import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKernelHistoricalAnalysisStore } from "./kernel-analysis-store.js";
import {
  KERNEL_FIXTURE_BUNDLE_HASH,
  KERNEL_FIXTURE_NOW,
  KERNEL_FIXTURE_REQUEST_HASH,
  KERNEL_FIXTURE_SUBJECT,
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe("kernel historical analysis capability", () => {
  it("reads settled shared history and refuses active runs", () => {
    const fixture = freshKernelFixture();
    fixtures.push(fixture);
    seedKernelRun({ db: fixture.db, run_id: "active-run" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "active-run",
      id: "active-attempt",
      status: "running",
    });
    seedKernelRun({ db: fixture.db, run_id: "settled-run", status: "completed" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "settled-run",
      id: "settled-attempt",
      status: "settled",
    });
    fixture.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
        payload_schema, inline_payload, attempt_id, request_hash,
        definition_bundle_hash, input_subject, original_candidate_hash,
        normalized_candidate_hash, created_at
      ) VALUES (
        'settled-result', 'settled-run', 2, ?, 'result', 'settled-result',
        'result/v1', '{}', 'settled-attempt', ?, ?, ?, ?, ?, ?
      )
    `).run(
      "c".repeat(64),
      KERNEL_FIXTURE_REQUEST_HASH,
      KERNEL_FIXTURE_BUNDLE_HASH,
      KERNEL_FIXTURE_SUBJECT,
      "d".repeat(64),
      "e".repeat(64),
      KERNEL_FIXTURE_NOW,
    );
    const analysis = createKernelHistoricalAnalysisStore(fixture.db);
    expect(analysis.listSettledRuns()).toEqual([
      expect.objectContaining({
        pipeline_run_id: "settled-run",
        terminal_outcome: "completed",
        attempt_count: 1,
        result_count: 1,
        normalized_result_count: 1,
      }),
    ]);
    expect(analysis.listSettledRecordMetadata({
      pipeline_run_id: "settled-run",
      kind: "result",
    }))
      .toEqual([expect.objectContaining({ id: "settled-result", kind: "result" })]);
    expect(() => analysis.listSettledRecordMetadata({ pipeline_run_id: "active-run" }))
      .toThrow(/only a settled pipeline run/);
  });

  it("is not imported by live reducer, admission, or effect workers", () => {
    const pipelineKernel = new URL("../pipeline/kernel/", import.meta.url);
    const liveDecisionFiles = readdirSync(pipelineKernel)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => new URL(name, pipelineKernel));
    for (const url of [
      ...liveDecisionFiles,
      new URL("../app/kernel-admission.ts", import.meta.url),
      new URL("../persistence/kernel-store.ts", import.meta.url),
      new URL("../operations/kernel-effects.ts", import.meta.url),
    ]) {
      const source = readFileSync(url, "utf8");
      const relative = url.pathname.slice(url.pathname.indexOf("/supervisor/src/") + 16);
      expect(source, relative).not.toContain("kernel-analysis-store");
      expect(source, relative).not.toContain("KernelHistoricalAnalysisPort");
    }
  });
});
