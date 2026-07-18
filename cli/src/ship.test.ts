import { describe, expect, it, vi } from "vitest";
import { delegateIssue, parseMarkdown } from "./ship.js";

describe("ship", () => {
  it("uses the first level-one heading as title", () => {
    expect(parseMarkdown("preface\n# Ship it\n\nPlan body\n")).toEqual({
      title: "Ship it",
      body: "Plan body",
    });
    expect(() => parseMarkdown("## Not enough")).toThrow(/Heading/);
  });

  it("delegates with IssueUpdateInput.delegateId", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: { issueUpdate: { success: true } } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await delegateIssue("linear-key", "issue-1", "app-actor-1");
      const init = fetchMock.mock.calls[0]![1]!;
      expect(JSON.parse(String(init.body))).toMatchObject({
        variables: { id: "issue-1", input: { delegateId: "app-actor-1" } },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a false issueUpdate success result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: { issueUpdate: { success: false } } })
    ) as unknown as typeof fetch;
    try {
      await expect(delegateIssue("linear-key", "issue-1", "app-actor-1")).rejects.toThrow(
        "success: false"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
