import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildActivityEvent, writeActivityEvent } from "./ot-activity.mjs";

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
});
