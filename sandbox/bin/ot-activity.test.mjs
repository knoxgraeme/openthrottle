import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildActivityEvent,
  buildPlanEvent,
  normalizePlanStatus,
  parsePlanItem,
  writeActivityEvent,
} from "./ot-activity.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ot-activity", () => {
  it("builds a bounded run-scoped activity", () => {
    expect(buildActivityEvent({ runId: "run-1", type: "elicitation", message: "Add a plan" }))
      .toMatchObject({
        version: 1,
        kind: "activity",
        run_id: "run-1",
        type: "elicitation",
        body: "Add a plan",
      });
    expect(() =>
      buildActivityEvent({ runId: "run-1", type: "unknown", message: "no" })
    ).toThrow("Unsupported activity type");
    expect(() =>
      buildActivityEvent({ runId: "run-1", type: "response", message: "x".repeat(8_001) })
    ).toThrow("8,000");
  });

  it("writes a complete JSON record through an atomic rename", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "ot-outbox-"));
    tempDirs.push(outboxDir);

    const event = buildActivityEvent({ runId: "run-2", type: "action", message: "Tests passed" });
    await writeActivityEvent(event, outboxDir);

    const files = await readdir(outboxDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-activity-[0-9a-f-]+\.json$/);
    expect(JSON.parse(await readFile(join(outboxDir, files[0]), "utf8"))).toEqual(event);
  });

  it("builds structured action events with verb/parameter/result", () => {
    const started = buildActivityEvent({
      runId: "run-1",
      type: "action",
      action: "Running",
      parameter: "pnpm test",
    });
    expect(started).toMatchObject({
      type: "action",
      action: "Running",
      parameter: "pnpm test",
      body: "Running: pnpm test",
    });
    expect(started).not.toHaveProperty("result");

    const finished = buildActivityEvent({
      runId: "run-1",
      type: "action",
      action: "Ran",
      parameter: "pnpm test",
      result: "583 passed",
    });
    expect(finished).toMatchObject({
      action: "Ran",
      parameter: "pnpm test",
      result: "583 passed",
      body: "Ran: pnpm test → 583 passed",
    });

    // A bare single-string action stays backward-compatible as a Progress note.
    expect(buildActivityEvent({ runId: "run-1", type: "action", message: "Tests passed" }))
      .toMatchObject({ action: "Progress", parameter: "Tests passed" });
    expect(() => buildActivityEvent({ runId: "run-1", type: "action", action: "Ran" }))
      .toThrow("requires a parameter");
  });

  it("normalizes friendly plan statuses and rejects unknown ones", () => {
    expect(normalizePlanStatus("done")).toBe("completed");
    expect(normalizePlanStatus("Running")).toBe("inProgress");
    expect(normalizePlanStatus("skip")).toBe("canceled");
    expect(normalizePlanStatus("pending")).toBe("pending");
    expect(() => normalizePlanStatus("bogus")).toThrow("Unsupported plan status");
  });

  it("parses `content=status` plan items, splitting on the last `=`", () => {
    expect(parsePlanItem("Tests=completed")).toEqual({ content: "Tests", status: "completed" });
    expect(parsePlanItem("Build (a=b)=inProgress")).toEqual({
      content: "Build (a=b)",
      status: "inProgress",
    });
    expect(() => parsePlanItem("no-separator")).toThrow('content=status');
    expect(() => parsePlanItem("=completed")).toThrow("missing content");
  });

  it("builds a bounded, run-scoped plan event", () => {
    const event = buildPlanEvent({
      runId: "run-9",
      items: [
        { content: "Tests", status: "completed" },
        { content: "Build", status: "inProgress" },
      ],
    });
    expect(event).toMatchObject({
      version: 1,
      kind: "plan",
      run_id: "run-9",
      plan: [
        { content: "Tests", status: "completed" },
        { content: "Build", status: "inProgress" },
      ],
    });
    expect(() => buildPlanEvent({ runId: "run-9", items: [] })).toThrow("between 1 and");
    expect(() => buildPlanEvent({ runId: "../bad", items: [{ content: "x", status: "pending" }] }))
      .toThrow("RUN_ID");
  });

  it("writes a plan event under a -plan- filename", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "ot-outbox-"));
    tempDirs.push(outboxDir);

    const event = buildPlanEvent({ runId: "run-3", items: [{ content: "CI", status: "inProgress" }] });
    await writeActivityEvent(event, outboxDir);

    const files = await readdir(outboxDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-plan-[0-9a-f-]+\.json$/);
    expect(JSON.parse(await readFile(join(outboxDir, files[0]), "utf8"))).toEqual(event);
  });
});
