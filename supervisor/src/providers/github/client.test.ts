import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
} from "@openthrottle/contracts";
import { describe, expect, it, vi } from "vitest";
import * as appPortsModule from "../../app/ports.js";
import * as githubClientModule from "./client.js";
import {
  ensureRepositoryControlLabel,
  getRepositoryCollaboratorPermission,
  getRepositoryDefinitionSourceAtCommit,
  isAuthorizedGithubControlPermission,
  prepareRepository,
  publishRepositoryTaskBranch,
  type GithubClient,
} from "./client.js";

const WEBHOOK_EVENTS = [
  "issues",
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "workflow_run",
  "check_suite",
] as const;

describe("GitHub kernel client", () => {
  it("exports only the production kernel surface", () => {
    expect(Object.keys(githubClientModule).sort()).toEqual([
      "ensureRepositoryControlLabel",
      "getRepositoryCollaboratorPermission",
      "getRepositoryDefinitionSourceAtCommit",
      "isAuthorizedGithubControlPermission",
      "prepareRepository",
      "publishRepositoryTaskBranch",
    ]);
    expect(Object.keys(appPortsModule)).toEqual(["RepositoryRefConflictError"]);
  });

  it("uses the configured API target to prepare a repository and create its webhook", async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, authorization: headers?.Authorization });
      if (url === "https://github.example/api/v3/repos/acme/widget") {
        return Response.json({ full_name: "Acme/Widget", default_branch: "trunk" });
      }
      if (url.endsWith("/branches/develop")) return Response.json({ name: "develop" });
      if (url.endsWith("/hooks?per_page=100")) return Response.json([]);
      if (url.endsWith("/hooks") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          name: "web",
          active: true,
          events: WEBHOOK_EVENTS,
          config: {
            url: "https://ot.test/webhooks/github",
            content_type: "json",
            secret: "webhook-secret",
            insecure_ssl: "0",
          },
        });
        return Response.json({ id: 42 }, { status: 201 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    const client: GithubClient = {
      token: "github-token",
      apiBaseUrl: "https://github.example/api/v3",
      fetch: fetchMock,
    };

    await expect(prepareRepository(client, {
      repo: "acme/widget",
      requestedBaseBranch: "develop",
      webhookUrl: "https://ot.test/webhooks/github",
      webhookSecret: "webhook-secret",
    })).resolves.toEqual({
      repo: "Acme/Widget",
      baseBranch: "develop",
      webhookId: 42,
      webhookAction: "created",
    });
    expect(requests).toHaveLength(4);
    expect(requests.every(({ authorization }) => authorization === "Bearer github-token")).toBe(true);
  });

  it("updates the matching repository webhook and defaults to the repository base branch", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) {
        return Response.json({ full_name: "acme/widget", default_branch: "main" });
      }
      if (url.endsWith("/branches/main")) return Response.json({ name: "main" });
      if (url.endsWith("/hooks?per_page=100")) {
        return Response.json([{ id: 7, config: { url: "https://ot.test/webhooks/github" } }]);
      }
      if (url.endsWith("/hooks/7") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          active: true,
          events: WEBHOOK_EVENTS,
          config: {
            url: "https://ot.test/webhooks/github",
            content_type: "json",
            secret: "webhook-secret",
            insecure_ssl: "0",
          },
        });
        return Response.json({ id: 7 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(prepareRepository(
      { token: "github", fetch: fetchMock },
      {
        repo: "acme/widget",
        webhookUrl: "https://ot.test/webhooks/github",
        webhookSecret: "webhook-secret",
      },
    )).resolves.toEqual({
      repo: "acme/widget",
      baseBranch: "main",
      webhookId: 7,
      webhookAction: "updated",
    });
  });

  it("keeps, renames, or creates the exact lowercase control label", async () => {
    const exactFetch = vi.fn(async () => Response.json([{ name: "openthrottle" }])) as unknown as typeof fetch;
    await expect(ensureRepositoryControlLabel(
      { token: "github", fetch: exactFetch },
      "acme/widget",
    )).resolves.toBe("unchanged");
    expect(exactFetch).toHaveBeenCalledTimes(1);

    const renameFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/labels?per_page=100")) {
        return Response.json([{ name: "OpenThrottle" }]);
      }
      expect(url).toContain("/labels/OpenThrottle");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ new_name: "openthrottle" });
      return Response.json({ name: "openthrottle" });
    }) as unknown as typeof fetch;
    await expect(ensureRepositoryControlLabel(
      { token: "github", fetch: renameFetch },
      "acme/widget",
    )).resolves.toBe("renamed");

    const createFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/labels?per_page=100")) return Response.json([]);
      expect(url).toMatch(/\/labels$/);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "openthrottle",
        color: "0e8a16",
        description: "Delegate this GitHub Issue to OpenThrottle",
      });
      return Response.json({ name: "openthrottle" }, { status: 201 });
    }) as unknown as typeof fetch;
    await expect(ensureRepositoryControlLabel(
      { token: "github", fetch: createFetch },
      "acme/widget",
    )).resolves.toBe("created");
  });

  it("maps current GitHub collaborator permissions and authorizes triage or stronger", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json({
        permission: "read",
        role_name: requests.length === 1 ? "triage" : "pull",
      });
    }) as unknown as typeof fetch;

    await expect(getRepositoryCollaboratorPermission(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      "octocat",
    )).resolves.toBe("triage");
    await expect(getRepositoryCollaboratorPermission(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      "octocat",
    )).resolves.toBe("read");
    expect(isAuthorizedGithubControlPermission("triage")).toBe(true);
    expect(isAuthorizedGithubControlPermission("read")).toBe(false);
    expect(requests[0]).toBe(
      "https://api.github.com/repos/owner/repo/collaborators/octocat/permission",
    );
  });

  it.each([
    ["custom-write", "write", "write", true],
    ["custom-read", "read", "read", false],
  ] as const)(
    "falls back from GitHub role %s to its %s base permission",
    async (roleName, basePermission, expected, authorized) => {
      const fetchMock = vi.fn(async () => Response.json({
        permission: basePermission,
        role_name: roleName,
      })) as unknown as typeof fetch;

      const permission = await getRepositoryCollaboratorPermission(
        { token: "read-token", fetch: fetchMock },
        "owner/repo",
        "octocat",
      );
      expect(permission).toBe(expected);
      expect(isAuthorizedGithubControlPermission(permission)).toBe(authorized);
    },
  );

  it("publishes only the exact task branch and then reuses its owned pull request", async () => {
    const sha = "b".repeat(40);
    const marker = "openthrottle:publish:pipeline-1:attempt-1";
    let created = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads%2Fot%2Fissue-1")) {
        return Response.json({ object: { sha } });
      }
      if (url.includes("/pulls?") && init?.method === undefined) {
        return Response.json(created ? [{
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          body: `<!-- ${marker} -->`,
          head: { ref: "ot/issue-1", sha, repo: { full_name: "o/r" } },
          base: { ref: "main" },
        }] : []);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        expect(body).toMatchObject({
          title: "fix: complete OPE-187",
          head: "ot/issue-1",
          base: "main",
        });
        expect(body.body).toBe(`Implements the approved task.\n\n<!-- ${marker} -->\n`);
        created = true;
        return Response.json({
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          body: body.body,
          head: { ref: "ot/issue-1", sha, repo: { full_name: "o/r" } },
          base: { ref: "main" },
        }, { status: 201 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const input = {
      repository: "o/r",
      branch: "ot/issue-1",
      baseBranch: "main",
      expectedHeadSha: sha,
      title: "fix: complete OPE-187",
      body: "Implements the approved task.",
      ownershipMarker: marker,
    };

    await expect(publishRepositoryTaskBranch({ token: "github", fetch: fetchMock }, input))
      .resolves.toEqual({ sha, url: "https://github.com/o/r/pull/7" });
    await expect(publishRepositoryTaskBranch({ token: "github", fetch: fetchMock }, input))
      .resolves.toEqual({ sha, url: "https://github.com/o/r/pull/7" });
  });

  it("fails closed for a missing head or an unowned pull request", async () => {
    const sha = "b".repeat(40);
    const input = {
      repository: "o/r",
      branch: "ot/issue-1",
      baseBranch: "main",
      expectedHeadSha: sha,
      title: "fix: complete OPE-187",
      body: "Implements the approved task.",
      ownershipMarker: "openthrottle:publish:pipeline-1:attempt-1",
    };
    const missingFetch = vi.fn(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
    await expect(publishRepositoryTaskBranch(
      { token: "github", fetch: missingFetch },
      input,
    )).rejects.toThrow(/expected .* but found missing/);

    const unownedFetch = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/git/ref/heads%2Fot%2Fissue-1")) {
        return Response.json({ object: { sha } });
      }
      return Response.json([{
        number: 7,
        html_url: "https://github.com/o/r/pull/7",
        body: "human-created",
        head: { ref: "ot/issue-1", sha, repo: { full_name: "o/r" } },
        base: { ref: "main" },
      }]);
    }) as unknown as typeof fetch;
    await expect(publishRepositoryTaskBranch(
      { token: "github", fetch: unownedFetch },
      input,
    )).rejects.toMatchObject({ name: "RepositoryRefConflictError", retryable: false });
  });

  it("adopts an exactly owned pull request created during a publication race", async () => {
    const sha = "b".repeat(40);
    const marker = "openthrottle:publish:pipeline-1:attempt-1";
    let listed = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("/git/ref/heads%2Fot%2Fissue-1")) {
        return Response.json({ object: { sha } });
      }
      if (url.includes("/pulls?")) {
        listed += 1;
        return Response.json(listed === 1 ? [] : [{
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          body: `<!-- ${marker} -->`,
          head: { ref: "ot/issue-1", sha, repo: { full_name: "o/r" } },
          base: { ref: "main" },
        }]);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response("already exists", { status: 422 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(publishRepositoryTaskBranch(
      { token: "github", fetch: fetchMock },
      {
        repository: "o/r",
        branch: "ot/issue-1",
        baseBranch: "main",
        expectedHeadSha: sha,
        title: "fix: complete OPE-187",
        body: "Implements the approved task.",
        ownershipMarker: marker,
      },
    )).resolves.toEqual({ sha, url: "https://github.com/o/r/pull/7" });
  });

  it("reads raw definition bytes only from the exact commit's .openthrottle tree", async () => {
    const commit = "a".repeat(40);
    const rootTreeSha = "b".repeat(40);
    const definitionTreeSha = "c".repeat(40);
    const sharedBlobSha = "d".repeat(40);
    const coreBlobSha = "e".repeat(40);
    const sharedBytes = Buffer.from([0xff, 0x00, 0x0a]);
    const coreBytes = Buffer.from("reader keeps core paths\n");
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(`/git/commits/${commit}`)) {
        return Response.json({ sha: commit, tree: { sha: rootTreeSha } });
      }
      if (url.endsWith(`/git/trees/${rootTreeSha}`)) {
        return Response.json({
          sha: rootTreeSha,
          truncated: false,
          tree: [
            { path: "README.md", mode: "100644", type: "blob", sha: "f".repeat(40), size: 5 },
            { path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTreeSha },
          ],
        });
      }
      if (url.endsWith(`/git/trees/${definitionTreeSha}?recursive=1`)) {
        return Response.json({
          sha: definitionTreeSha,
          truncated: false,
          tree: [
            { path: "skills/core/kept/SKILL.md", mode: "100755", type: "blob", sha: coreBlobSha, size: coreBytes.byteLength },
            { path: "agents/z-agent", mode: "040000", type: "tree", sha: "1".repeat(40) },
            { path: "config.yml", mode: "100644", type: "blob", sha: sharedBlobSha, size: sharedBytes.byteLength },
            { path: "agents/z-agent/instructions.md", mode: "100644", type: "blob", sha: sharedBlobSha, size: sharedBytes.byteLength },
          ],
        });
      }
      if (url.endsWith(`/git/blobs/${sharedBlobSha}`)) {
        return Response.json({
          sha: sharedBlobSha,
          encoding: "base64",
          content: `${sharedBytes.toString("base64")}\n`,
          size: sharedBytes.byteLength,
        });
      }
      if (url.endsWith(`/git/blobs/${coreBlobSha}`)) {
        return Response.json({
          sha: coreBlobSha,
          encoding: "base64",
          content: coreBytes.toString("base64"),
          size: coreBytes.byteLength,
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const source = await getRepositoryDefinitionSourceAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      commit,
    );

    expect(source.source_commit).toBe(commit);
    expect([...source.files.keys()]).toEqual([
      ".openthrottle/agents/z-agent/instructions.md",
      ".openthrottle/config.yml",
      ".openthrottle/skills/core/kept/SKILL.md",
    ]);
    const config = source.files.get(".openthrottle/config.yml");
    expect(config).toMatchObject({ type: "file", blob_sha: sharedBlobSha });
    if (!config || config.type !== "file" || typeof config.content === "string") {
      throw new Error("expected raw config bytes");
    }
    expect([...config.content]).toEqual([...sharedBytes]);
    expect(requested.filter((url) => url.includes(`/git/blobs/${sharedBlobSha}`))).toHaveLength(1);
    expect(requested.some((url) => url.includes(`${rootTreeSha}?recursive=1`))).toBe(false);
  });

  it("returns an empty pinned definition source when .openthrottle is absent", async () => {
    const commit = "a".repeat(40);
    const rootTreeSha = "b".repeat(40);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/git/commits/${commit}`)) {
        return Response.json({ sha: commit, tree: { sha: rootTreeSha } });
      }
      if (url.endsWith(`/git/trees/${rootTreeSha}`)) {
        return Response.json({
          sha: rootTreeSha,
          truncated: false,
          tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "c".repeat(40), size: 5 }],
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(getRepositoryDefinitionSourceAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      commit,
    )).resolves.toEqual({ source_commit: commit, files: new Map() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous roots, unsafe files, and tree bounds before reading blobs", async () => {
    const commit = "a".repeat(40);
    const rootTreeSha = "b".repeat(40);
    const definitionTreeSha = "c".repeat(40);
    const valid = {
      path: "config.yml",
      mode: "100644",
      type: "blob",
      sha: "d".repeat(40),
      size: 1,
    };
    const cases: Array<{
      rootEntries?: Array<Record<string, unknown>>;
      entries?: Array<Record<string, unknown>>;
      truncated?: boolean;
      error: RegExp;
    }> = [
      {
        rootEntries: [{ path: ".OpenThrottle", mode: "040000", type: "tree", sha: definitionTreeSha }],
        error: /exact \.openthrottle casing/,
      },
      {
        rootEntries: [
          { path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTreeSha },
          { path: ".OpenThrottle", mode: "040000", type: "tree", sha: "e".repeat(40) },
        ],
        error: /case-colliding roots/,
      },
      { entries: [{ ...valid, mode: "120000" }], error: /regular file/ },
      { entries: [{ ...valid, path: "../escape.yml" }], error: /safe relative POSIX path/ },
      {
        entries: [valid, { ...valid, path: "CONFIG.yml", sha: "e".repeat(40) }],
        error: /case-colliding paths/,
      },
      {
        entries: [{ ...valid, size: VIRTUAL_DEFINITION_MAX_FILE_BYTES + 1 }],
        error: new RegExp(`exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES}`),
      },
      {
        entries: Array.from({ length: VIRTUAL_DEFINITION_MAX_FILES + 1 }, (_, index) => ({
          ...valid,
          path: `files/${String(index).padStart(3, "0")}.yml`,
        })),
        error: new RegExp(`file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`),
      },
      { truncated: true, entries: [], error: /recursive tree limit/ },
    ];

    for (const testCase of cases) {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/git/commits/${commit}`)) {
          return Response.json({ sha: commit, tree: { sha: rootTreeSha } });
        }
        if (url.endsWith(`/git/trees/${rootTreeSha}`)) {
          return Response.json({
            sha: rootTreeSha,
            truncated: false,
            tree: testCase.rootEntries ?? [
              { path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTreeSha },
            ],
          });
        }
        if (url.endsWith(`/git/trees/${definitionTreeSha}?recursive=1`)) {
          return Response.json({
            sha: definitionTreeSha,
            truncated: testCase.truncated ?? false,
            tree: testCase.entries ?? [],
          });
        }
        throw new Error(`blob read escaped definition preflight: ${url}`);
      }) as unknown as typeof fetch;

      await expect(getRepositoryDefinitionSourceAtCommit(
        { token: "github", fetch: fetchMock },
        "owner/repo",
        commit,
      )).rejects.toThrow(testCase.error);
      expect(fetchMock).toHaveBeenCalledTimes(testCase.rootEntries ? 2 : 3);
    }
  });

  it("caps definition blob reads at eight and deduplicates shared SHAs", async () => {
    const commit = "a".repeat(40);
    const rootTreeSha = "b".repeat(40);
    const definitionTreeSha = "c".repeat(40);
    const entries = Array.from({ length: 10 }, (_, index) => ({
      path: `files/${String(index).padStart(2, "0")}.yml`,
      mode: "100644",
      type: "blob",
      sha: (index + 1).toString(16).repeat(40),
      size: 1,
    }));
    entries.push({ ...entries[0]!, path: "files/shared.yml" });
    let active = 0;
    let maximumActive = 0;
    const blobRequests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/git/commits/${commit}`)) {
        return Response.json({ sha: commit, tree: { sha: rootTreeSha } });
      }
      if (url.endsWith(`/git/trees/${rootTreeSha}`)) {
        return Response.json({
          sha: rootTreeSha,
          truncated: false,
          tree: [{ path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTreeSha }],
        });
      }
      if (url.endsWith(`/git/trees/${definitionTreeSha}?recursive=1`)) {
        return Response.json({ sha: definitionTreeSha, truncated: false, tree: entries });
      }
      const sha = url.split("/git/blobs/")[1];
      if (sha) {
        blobRequests.push(sha);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return Response.json({
          sha,
          encoding: "base64",
          content: Buffer.from("x").toString("base64"),
          size: 1,
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const source = await getRepositoryDefinitionSourceAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      commit,
    );
    expect(source.files).toHaveLength(11);
    expect(blobRequests).toHaveLength(10);
    expect(maximumActive).toBe(8);
  });

  it("rejects invalid commit and blob provenance evidence", async () => {
    const noFetch = vi.fn() as unknown as typeof fetch;
    await expect(getRepositoryDefinitionSourceAtCommit(
      { token: "github", fetch: noFetch },
      "owner/repo",
      "main",
    )).rejects.toThrow(/full commit SHA/);
    expect(noFetch).not.toHaveBeenCalled();

    const commit = "a".repeat(40);
    const rootTreeSha = "b".repeat(40);
    const definitionTreeSha = "c".repeat(40);
    const blobSha = "d".repeat(40);
    const blobCases: Array<{ response: Record<string, unknown>; error: RegExp }> = [
      {
        response: { sha: "e".repeat(40), encoding: "base64", content: "eA==", size: 1 },
        error: /blob SHA/,
      },
      {
        response: { sha: blobSha, encoding: "utf-8", content: "eA==", size: 1 },
        error: /base64/,
      },
      {
        response: { sha: blobSha, encoding: "base64", content: "eA=", size: 1 },
        error: /base64/,
      },
      {
        response: { sha: blobSha, encoding: "base64", content: "eA==", size: 2 },
        error: /content size/,
      },
      {
        response: { sha: blobSha, encoding: "base64", content: "eHg=", size: 2 },
        error: /tree metadata/,
      },
    ];

    for (const testCase of blobCases) {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/git/commits/${commit}`)) {
          return Response.json({ sha: commit, tree: { sha: rootTreeSha } });
        }
        if (url.endsWith(`/git/trees/${rootTreeSha}`)) {
          return Response.json({
            sha: rootTreeSha,
            truncated: false,
            tree: [{ path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTreeSha }],
          });
        }
        if (url.endsWith(`/git/trees/${definitionTreeSha}?recursive=1`)) {
          return Response.json({
            sha: definitionTreeSha,
            truncated: false,
            tree: [{ path: "config.yml", mode: "100644", type: "blob", sha: blobSha, size: 1 }],
          });
        }
        if (url.endsWith(`/git/blobs/${blobSha}`)) return Response.json(testCase.response);
        throw new Error(`unexpected request ${url}`);
      }) as unknown as typeof fetch;

      await expect(getRepositoryDefinitionSourceAtCommit(
        { token: "github", fetch: fetchMock },
        "owner/repo",
        commit,
      )).rejects.toThrow(testCase.error);
    }
  });
});
