import { afterEach, describe, expect, it } from "vitest";
import {
  freshKernelFixture,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";
import { SqliteKernelRunEnvironmentStore } from "./kernel-runtime-context-store.js";

let fixture: FreshKernelFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("SqliteKernelRunEnvironmentStore", () => {
  it("loads one exact fresh-epoch run-to-registration join", () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db });
    const store = new SqliteKernelRunEnvironmentStore({ db: fixture.db });

    expect(store.loadExactRunEnvironment("run-1")).toEqual({
      pipeline_run_id: "run-1",
      work_item_id: "work-run-1",
      repository_registration_id: "repo",
      repository: "owner/repo",
      base_branch: "main",
      runtime_snapshot: "snapshot",
      control_provider: "linear",
      source_provider: "linear",
      source_id: "source-run-1",
      source_reference: "OPE-run-1",
      title: "Work for run-1",
      current_subject: "1".repeat(40),
    });
  });

  it("fails closed instead of returning partial or arbitrary registration state", () => {
    fixture = freshKernelFixture();
    const store = new SqliteKernelRunEnvironmentStore({ db: fixture.db });
    expect(() => store.loadExactRunEnvironment("missing")).toThrow(/no exact execution environment/);
  });
});
