import { describe, expect, it } from "vitest";
import {
  composeBoundedTaskContext,
  ORDINARY_STAGE_TASK_CONTEXT_LIMIT,
} from "./admission-context.js";

describe("bounded Linear admission context", () => {
  it("matches the captured delegated wire shape and strips its nested parent issue", () => {
    const context = [
      `<issue identifier="OPE-113">`,
      `<title>Citation gate</title>`,
      `<description>Implement the child ticket.`,
      `<parent-issue identifier="OPE-108">`,
      `<title>Self-improvement parent</title>`,
      `<description>stale parent selection</description>`,
      `</parent-issue>`,
      `</description>`,
      `</issue>`,
      `<primary-directive-thread comment-id="directive">`,
      `<comment>Implement the current child ticket.</comment>`,
      `</primary-directive-thread>`,
      `<other-thread comment-id="history">`,
      `<comment>optional prior discussion</comment>`,
      `</other-thread>`,
    ].join("\n");

    const result = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "OPE-113",
    });

    expect(result.selectionError).toBeUndefined();
    expect(result.ordinaryLimitError).toBeUndefined();
    expect(result.selectionContext).toContain("Implement the child ticket.");
    expect(result.selectionContext).toContain("Implement the current child ticket.");
    expect(result.selectionContext).not.toContain("OPE-108");
    expect(result.selectionContext).not.toContain("stale parent selection");
    expect(result.selectionContext).not.toContain("optional prior discussion");
    expect(result.context).not.toContain("OPE-108");
    expect(result.context).not.toContain("stale parent selection");
    expect(result.context).toContain("optional prior discussion");
    expect(result.pruning).toMatchObject({
      droppedParentSections: 0,
      summarizedParentSections: 0,
    });
  });

  it.each(["issue", "parent-issue", "other-thread"] as const)(
    "removes nested %s history from directive selection authority",
    (kind) => {
      const context = [
        `<issue identifier="OPE-139">`,
        `<title>Child issue</title>`,
        `<description>Use the default graph.</description>`,
        `</issue>`,
        `<primary-directive-thread comment-id="directive">`,
        `<comment>Implement the current ticket.</comment>`,
        `<${kind}${kind === "issue" || kind === "parent-issue" ? ` identifier="OPE-OLD"` : ""}>`,
        `<description>stale ${kind} selection</description>`,
        `</${kind}>`,
        `</primary-directive-thread>`,
      ].join("\n");

      const result = composeBoundedTaskContext(context, {
        requireLinearSections: true,
        expectedIssueIdentifier: "OPE-139",
      });

      expect(result.selectionError).toBeUndefined();
      expect(result.selectionContext).toContain("Implement the current ticket.");
      expect(result.selectionContext).not.toContain(`stale ${kind} selection`);
      expect(result.context).not.toContain(`stale ${kind} selection`);
    }
  );

  it("rejects a supplied prompt whose issue identifier does not match the session", () => {
    const result = composeBoundedTaskContext(
      `<issue identifier="OPE-OTHER"><description>wrong ticket</description></issue>`,
      { requireLinearSections: true, expectedIssueIdentifier: "OPE-139" }
    );

    expect(result.selectionContext).toBe("");
    expect(result.selectionError).toContain("does not match the authenticated session issue");
  });

  it("rejects supplied sectionless context while preserving the no-prompt fallback", () => {
    const supplied = composeBoundedTaskContext("# unwrapped prompt", {
      requireLinearSections: true,
      expectedIssueIdentifier: "OPE-139",
    });
    const fallback = composeBoundedTaskContext("# OPE-139\n\nNo prompt context supplied.");

    expect(supplied.selectionError).toContain("invalid top-level section structure");
    expect(fallback.selectionError).toBeUndefined();
    expect(fallback.selectionContext).toContain("No prompt context supplied.");
  });

  it.each([
    [
      "duplicate top-level issue",
      [
        `<issue identifier="OPE-139"><description>current child</description></issue>`,
        `<issue identifier="OPE-139"><description>duplicate child</description></issue>`,
      ].join("\n"),
    ],
    [
      "duplicate primary directive",
      [
        `<issue identifier="OPE-139"><description>current child</description></issue>`,
        `<primary-directive-thread><comment>current directive</comment></primary-directive-thread>`,
        `<primary-directive-thread><comment>duplicate directive</comment></primary-directive-thread>`,
      ].join("\n"),
    ],
    [
      "parent issue after an other thread",
      [
        `<issue identifier="OPE-139"><description>current child</description></issue>`,
        `<primary-directive-thread><comment>current directive</comment></primary-directive-thread>`,
        `<other-thread><comment>history</comment></other-thread>`,
        `<parent-issue identifier="OPE-100"><description>parent</description></parent-issue>`,
      ].join("\n"),
    ],
    [
      "unclosed required issue",
      `<issue identifier="OPE-139"><description>unclosed child</description>`,
    ],
  ])("rejects %s context", (_name, context) => {
    const result = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "OPE-139",
    });

    expect(result.selectionContext).toBe("");
    expect(result.selectionError).toContain("invalid top-level section structure");
  });

  it("drops oversized optional history and keeps required child context bounded", () => {
    const context = [
      `<issue identifier="OPE-139"><description>required child</description></issue>`,
      `<primary-directive-thread><comment>required directive</comment></primary-directive-thread>`,
      `<other-thread><comment>${"optional history ".repeat(5_000)}</comment></other-thread>`,
    ].join("\n");

    const result = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "OPE-139",
    });

    expect(result.ordinaryLimitError).toBeUndefined();
    expect(Buffer.byteLength(result.context, "utf8")).toBeLessThanOrEqual(ORDINARY_STAGE_TASK_CONTEXT_LIMIT);
    expect(result.context).toContain("required child");
    expect(result.context).toContain("required directive");
    expect(result.context).not.toContain("optional history");
    expect(result.pruning?.droppedOtherThreads).toBe(1);
  });

  it("rejects required child context above the shared bound", () => {
    const context = [
      `<issue identifier="OPE-139">`,
      `<description>${"required child context ".repeat(4_000)}</description>`,
      `</issue>`,
    ].join("\n");

    const result = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "OPE-139",
    });

    expect(result.ordinaryLimitError).toContain(
      `required content exceeds ${ORDINARY_STAGE_TASK_CONTEXT_LIMIT} bytes`
    );
  });
});
