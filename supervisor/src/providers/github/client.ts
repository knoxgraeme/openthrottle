import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
  compareCodeUnits,
  type TrustedRepositoryDefinitionSource,
} from "@openthrottle/contracts";
import { RepositoryRefConflictError } from "../../app/ports.js";
import { assertGithubResponseOk, githubApiResponse } from "../../shared/github-request.js";
import { buildGithubPullRequestBody } from "./pull-request-body.js";

const GITHUB_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_DEFINITION_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const CONTROL_LABEL = "openthrottle";
const WEBHOOK_EVENTS = [
  "issues",
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "workflow_run",
  "check_suite",
] as const;
const DEFINITION_ROOT = ".openthrottle";
const SAFE_DEFINITION_PATH = /^[A-Za-z0-9._/-]+$/;
const DEFINITION_BLOB_CONCURRENCY = 8;

interface GithubPullRequest {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  head: { ref: string; sha?: string; repo: { full_name: string } };
  base: { ref: string };
}

interface GithubRepositoryHook {
  id: number;
  config?: { url?: string };
}

interface GithubDefinitionTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface GithubDefinitionFileEntry extends GithubDefinitionTreeEntry {
  size: number;
  virtualPath: string;
}

export interface GithubClient {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export interface RepositoryReadiness {
  repo: string;
  baseBranch: string;
  webhookId: number;
  webhookAction: "created" | "updated";
}

export type GithubRepositoryPermission =
  | "none"
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

async function githubRequest<T>(
  client: GithubClient,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await assertGithubResponseOk(await githubApiResponse(client, path, init));
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

export function isAuthorizedGithubControlPermission(
  permission: GithubRepositoryPermission,
): boolean {
  return ["triage", "write", "maintain", "admin"].includes(permission);
}

export async function getRepositoryCollaboratorPermission(
  client: GithubClient,
  repo: string,
  username: string,
): Promise<GithubRepositoryPermission> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
    throw new Error("GitHub collaborator permission lookup requires a safe username");
  }
  const permission = await githubRequest<{
    permission?: string;
    role_name?: string;
  }>(
    client,
    `/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
  );
  const role = String(permission.role_name ?? "").toLowerCase();
  if (role === "admin") return "admin";
  if (role === "maintain") return "maintain";
  if (role === "write" || role === "push") return "write";
  if (role === "triage") return "triage";
  if (role === "read" || role === "pull") return "read";
  const basePermission = String(permission.permission ?? "none").toLowerCase();
  if (basePermission === "admin") return "admin";
  if (basePermission === "write" || basePermission === "push") return "write";
  if (basePermission === "read" || basePermission === "pull") return "read";
  return "none";
}

function githubWebhookConfiguration(input: {
  webhookUrl: string;
  webhookSecret: string;
}) {
  return {
    active: true,
    events: WEBHOOK_EVENTS,
    config: {
      url: input.webhookUrl,
      content_type: "json",
      secret: input.webhookSecret,
      insecure_ssl: "0",
    },
  };
}

async function patchRepositoryWebhook(
  client: GithubClient,
  repo: string,
  hookId: number,
  configuration: ReturnType<typeof githubWebhookConfiguration>,
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(client, `/repos/${repo}/hooks/${hookId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
  });
}

async function createRepositoryWebhook(
  client: GithubClient,
  repo: string,
  configuration: ReturnType<typeof githubWebhookConfiguration>,
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(client, `/repos/${repo}/hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web", ...configuration }),
  });
}

export async function ensureRepositoryControlLabel(
  client: GithubClient,
  repo: string,
): Promise<"unchanged" | "created" | "renamed"> {
  for (let page = 1; page <= 10; page += 1) {
    const labels = await githubRequest<Array<{ name: string }>>(
      client,
      `/repos/${repo}/labels?per_page=100${page === 1 ? "" : `&page=${page}`}`,
    );
    const exact = labels.find((label) => label.name === CONTROL_LABEL);
    if (exact) return "unchanged";
    const caseVariant = labels.find((label) => label.name.toLowerCase() === CONTROL_LABEL);
    if (caseVariant) {
      await githubRequest(client, `/repos/${repo}/labels/${encodeURIComponent(caseVariant.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: CONTROL_LABEL }),
      });
      return "renamed";
    }
    if (labels.length < 100) break;
  }
  await githubRequest(client, `/repos/${repo}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: CONTROL_LABEL,
      color: "0e8a16",
      description: "Delegate this GitHub Issue to OpenThrottle",
    }),
  });
  return "created";
}

export async function prepareRepository(
  client: GithubClient,
  input: {
    repo: string;
    requestedBaseBranch?: string;
    webhookUrl: string;
    webhookSecret: string;
  },
): Promise<RepositoryReadiness> {
  const repository = await githubRequest<{
    full_name: string;
    default_branch: string;
  }>(client, `/repos/${input.repo}`);
  const baseBranch = input.requestedBaseBranch || repository.default_branch;
  await githubRequest(
    client,
    `/repos/${repository.full_name}/branches/${encodeURIComponent(baseBranch)}`,
  );

  const hooks = await githubRequest<GithubRepositoryHook[]>(
    client,
    `/repos/${repository.full_name}/hooks?per_page=100`,
  );
  const existing = hooks.find((hook) => hook.config?.url === input.webhookUrl);
  const hookConfiguration = githubWebhookConfiguration(input);
  const hook = existing
    ? await patchRepositoryWebhook(client, repository.full_name, existing.id, hookConfiguration)
    : await createRepositoryWebhook(client, repository.full_name, hookConfiguration);

  return {
    repo: repository.full_name,
    baseBranch,
    webhookId: hook.id,
    webhookAction: existing ? "updated" : "created",
  };
}

function assertTaskRefInput(ref: string, sha: string): void {
  if (!/^refs\/heads\/(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/.test(ref)) {
    throw new Error("GitHub task ref must be a safe refs/heads name");
  }
  if (!GITHUB_COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error("GitHub task ref requires an exact lowercase commit SHA");
  }
}

async function getRepositoryRef(
  client: GithubClient,
  repository: string,
  ref: string,
): Promise<string | undefined> {
  const response = await githubApiResponse(
    client,
    `/repos/${repository}/git/ref/${encodeURIComponent(ref.replace(/^refs\//, ""))}`,
  );
  if (response.status === 404) return undefined;
  await assertGithubResponseOk(response);
  const value = await response.json() as { object?: { sha?: unknown } };
  const sha = value.object?.sha;
  if (typeof sha !== "string" || !GITHUB_COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error("GitHub returned an invalid task ref SHA");
  }
  return sha;
}

export async function publishRepositoryTaskBranch(
  client: GithubClient,
  input: {
    repository: string;
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
    title: string;
    body: string;
    ownershipMarker: string;
  },
): Promise<{ sha: string; url: string }> {
  assertTaskRefInput(`refs/heads/${input.branch}`, input.expectedHeadSha);
  assertTaskRefInput(`refs/heads/${input.baseBranch}`, input.expectedHeadSha);
  if (!/^[a-z0-9:_-]{16,200}$/.test(input.ownershipMarker)) {
    throw new Error("GitHub publication ownership marker is invalid");
  }
  if (input.title.length < 1 || input.title.length > 256 || input.body.length > 32_000) {
    throw new Error("GitHub publication title or body exceeds its bound");
  }
  const remoteHead = await getRepositoryRef(
    client,
    input.repository,
    `refs/heads/${input.branch}`,
  );
  if (remoteHead !== input.expectedHeadSha) {
    throw new RepositoryRefConflictError(
      `repository ref conflict: refs/heads/${input.branch} expected ${input.expectedHeadSha} but found ${remoteHead ?? "missing"}`,
    );
  }
  const [owner] = input.repository.split("/");
  if (!owner) throw new Error("GitHub publication repository is invalid");
  const canonicalBody = buildGithubPullRequestBody(input.body, input.ownershipMarker);
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${input.branch}`,
    base: input.baseBranch,
    per_page: "10",
  });
  const listOwned = async (): Promise<GithubPullRequest | undefined> => {
    const pulls = await githubRequest<GithubPullRequest[]>(
      client,
      `/repos/${input.repository}/pulls?${query.toString()}`,
    );
    const matching = pulls.filter((pull) =>
      pull.head.ref === input.branch &&
      pull.head.repo.full_name.toLowerCase() === input.repository.toLowerCase() &&
      pull.base.ref === input.baseBranch
    );
    if (matching.length > 1) {
      throw new RepositoryRefConflictError("multiple open pull requests target the task branch");
    }
    const existing = matching[0];
    if (!existing) return undefined;
    if (
      existing.head.sha !== input.expectedHeadSha ||
      existing.title !== input.title ||
      existing.body !== canonicalBody
    ) {
      throw new RepositoryRefConflictError(
        "an unowned or stale pull request already targets the task branch",
      );
    }
    return existing;
  };
  const existing = await listOwned();
  if (existing) return { sha: input.expectedHeadSha, url: existing.html_url };

  const response = await githubApiResponse(client, `/repos/${input.repository}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: canonicalBody,
      head: input.branch,
      base: input.baseBranch,
    }),
  });
  if (response.status === 422) {
    const raced = await listOwned();
    if (raced) return { sha: input.expectedHeadSha, url: raced.html_url };
    throw new RepositoryRefConflictError(
      "pull request creation conflicted without owned retry evidence",
    );
  }
  await assertGithubResponseOk(response);
  const created = await response.json() as GithubPullRequest;
  if (
    created.head.sha !== input.expectedHeadSha ||
    created.head.ref !== input.branch ||
    created.base.ref !== input.baseBranch ||
    created.head.repo.full_name.toLowerCase() !== input.repository.toLowerCase() ||
    created.title !== input.title || created.body !== canonicalBody
  ) {
    throw new Error("GitHub created a pull request with an unexpected publication fence");
  }
  return { sha: input.expectedHeadSha, url: created.html_url };
}

function assertDefinitionSha(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !GITHUB_DEFINITION_SHA_PATTERN.test(value)) {
    throw new Error(`GitHub returned an invalid ${context} SHA`);
  }
}

function assertSafeDefinitionPath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    !SAFE_DEFINITION_PATH.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !path.toLowerCase().startsWith(`${DEFINITION_ROOT}/`)
  ) {
    throw new Error(`${path}: must be a safe relative POSIX path inside ${DEFINITION_ROOT}/`);
  }
}

function parseDefinitionTree(
  value: unknown,
  expectedSha: string,
  context: string,
): GithubDefinitionTreeEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub returned an invalid ${context} tree`);
  }
  const tree = value as Record<string, unknown>;
  assertDefinitionSha(tree.sha, `${context} tree`);
  if (tree.sha !== expectedSha) {
    throw new Error(`GitHub returned a mismatched ${context} tree SHA`);
  }
  if (typeof tree.truncated !== "boolean") {
    throw new Error(`GitHub returned invalid ${context} tree truncation evidence`);
  }
  if (tree.truncated) {
    throw new Error(`${context} tree exceeds the GitHub recursive tree limit`);
  }
  if (!Array.isArray(tree.tree)) {
    throw new Error(`GitHub returned an invalid ${context} tree`);
  }
  return tree.tree.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`GitHub returned an invalid ${context} tree entry at index ${index}`);
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.mode !== "string" ||
      typeof entry.type !== "string"
    ) {
      throw new Error(`GitHub returned an invalid ${context} tree entry at index ${index}`);
    }
    assertDefinitionSha(entry.sha, `${context} tree entry`);
    if (entry.size !== undefined && !Number.isSafeInteger(entry.size)) {
      throw new Error(`GitHub returned an invalid ${context} tree entry size at index ${index}`);
    }
    return {
      path: entry.path,
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha,
      ...(entry.size === undefined ? {} : { size: entry.size as number }),
    };
  });
}

function decodeDefinitionBlob(content: unknown, path: string): Uint8Array {
  if (typeof content !== "string" || /[^A-Za-z0-9+/=\r\n]/.test(content)) {
    throw new Error(`${path}: GitHub blob content must be valid base64`);
  }
  const compact = content.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error(`${path}: GitHub blob content must be valid base64`);
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64") !== compact) {
    throw new Error(`${path}: GitHub blob content must be valid base64`);
  }
  return new Uint8Array(decoded);
}

async function readDefinitionBlob(
  client: GithubClient,
  repository: string,
  blobSha: string,
  path: string,
): Promise<{ bytes: Uint8Array; size: number }> {
  const blob = await githubRequest<Record<string, unknown>>(
    client,
    `/repos/${repository}/git/blobs/${blobSha}`,
  );
  assertDefinitionSha(blob.sha, "definition blob");
  if (blob.sha !== blobSha) {
    throw new Error(`${path}: GitHub definition blob SHA does not match tree metadata`);
  }
  if (blob.encoding !== "base64") {
    throw new Error(`${path}: GitHub definition blob encoding must be base64`);
  }
  if (
    !Number.isSafeInteger(blob.size) ||
    (blob.size as number) < 0 ||
    (blob.size as number) > VIRTUAL_DEFINITION_MAX_FILE_BYTES
  ) {
    throw new Error(
      `${path}: GitHub definition blob exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES} bytes`,
    );
  }
  const bytes = decodeDefinitionBlob(blob.content, path);
  if (bytes.byteLength !== blob.size) {
    throw new Error(`${path}: content size does not match GitHub blob metadata`);
  }
  return { bytes, size: blob.size as number };
}

/** Snapshot the complete repository-authored definition tree at one exact Git commit. */
export async function getRepositoryDefinitionSourceAtCommit(
  client: GithubClient,
  repository: string,
  commit: string,
): Promise<TrustedRepositoryDefinitionSource> {
  if (!GITHUB_DEFINITION_SHA_PATTERN.test(commit)) {
    throw new Error("repository definition read requires a full commit SHA");
  }
  const commitObject = await githubRequest<Record<string, unknown>>(
    client,
    `/repos/${repository}/git/commits/${commit}`,
  );
  assertDefinitionSha(commitObject.sha, "definition commit");
  if (commitObject.sha !== commit) {
    throw new Error("GitHub returned a mismatched definition commit SHA");
  }
  if (
    !commitObject.tree ||
    typeof commitObject.tree !== "object" ||
    Array.isArray(commitObject.tree)
  ) {
    throw new Error("GitHub returned an invalid definition commit tree");
  }
  const rootTreeSha = (commitObject.tree as Record<string, unknown>).sha;
  assertDefinitionSha(rootTreeSha, "definition root tree");

  const rootTree = parseDefinitionTree(
    await githubRequest<unknown>(client, `/repos/${repository}/git/trees/${rootTreeSha}`),
    rootTreeSha,
    "repository root",
  );
  const rootVariants = rootTree
    .filter((entry) => entry.path.toLowerCase() === DEFINITION_ROOT)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (rootVariants.length === 0) {
    return { source_commit: commit, files: new Map() };
  }
  if (rootVariants.length > 1) {
    throw new Error(
      `definition files: case-colliding roots are forbidden: ${rootVariants.map(({ path }) => path).join(" and ")}`,
    );
  }
  const definitionRoot = rootVariants[0]!;
  if (definitionRoot.path !== DEFINITION_ROOT) {
    throw new Error(
      `${definitionRoot.path}: definition root must use the exact ${DEFINITION_ROOT} casing`,
    );
  }
  if (definitionRoot.type !== "tree" || definitionRoot.mode !== "040000") {
    throw new Error(`${DEFINITION_ROOT}: must be a Git tree, not a symlink or non-directory`);
  }

  const definitionTree = parseDefinitionTree(
    await githubRequest<unknown>(
      client,
      `/repos/${repository}/git/trees/${definitionRoot.sha}?recursive=1`,
    ),
    definitionRoot.sha,
    "definition",
  ).sort((left, right) => compareCodeUnits(left.path, right.path));

  const seenPaths = new Map<string, { path: string; type: "file" | "directory" }>();
  const regularFiles: GithubDefinitionFileEntry[] = [];
  let totalBytes = 0;
  for (const entry of definitionTree) {
    const virtualPath = `${DEFINITION_ROOT}/${entry.path}`;
    assertSafeDefinitionPath(virtualPath);
    const caseKey = virtualPath.toLowerCase();
    const existing = seenPaths.get(caseKey);
    if (existing !== undefined) {
      if (existing.path === virtualPath) {
        throw new Error(`${virtualPath}: duplicate definition path is forbidden`);
      }
      throw new Error(
        `definition files: case-colliding paths are forbidden: ${existing.path} and ${virtualPath}`,
      );
    }
    for (
      let separator = caseKey.lastIndexOf("/");
      separator > DEFINITION_ROOT.length;
      separator = caseKey.lastIndexOf("/", separator - 1)
    ) {
      const ancestor = seenPaths.get(caseKey.slice(0, separator));
      if (ancestor?.type === "file") {
        throw new Error(`${virtualPath}: definition path descends through file ${ancestor.path}`);
      }
      if (ancestor && !virtualPath.startsWith(`${ancestor.path}/`)) {
        throw new Error(
          `definition files: case-colliding paths are forbidden: ${ancestor.path} and ${virtualPath}`,
        );
      }
    }

    if (entry.type === "tree" && entry.mode === "040000") {
      seenPaths.set(caseKey, { path: virtualPath, type: "directory" });
      continue;
    }
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(`${virtualPath}: must be a regular file with Git mode 100644 or 100755`);
    }
    seenPaths.set(caseKey, { path: virtualPath, type: "file" });
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0) {
      throw new Error(`${virtualPath}: GitHub tree must declare a valid file size`);
    }
    if (entry.size! > VIRTUAL_DEFINITION_MAX_FILE_BYTES) {
      throw new Error(`${virtualPath}: file exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES} bytes`);
    }
    if (regularFiles.length >= VIRTUAL_DEFINITION_MAX_FILES) {
      throw new Error(`definition files: file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`);
    }
    totalBytes += entry.size!;
    if (totalBytes > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
      throw new Error(`definition files: total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`);
    }
    regularFiles.push({ ...entry, size: entry.size!, virtualPath });
  }

  const uniqueBlobs = new Map<string, string>();
  for (const file of regularFiles) {
    if (!uniqueBlobs.has(file.sha)) uniqueBlobs.set(file.sha, file.virtualPath);
  }
  const blobWork = [...uniqueBlobs.entries()]
    .map(([sha, path]) => ({ sha, path }))
    .sort((left, right) => compareCodeUnits(left.sha, right.sha));
  const blobResults = new Map<string, { bytes: Uint8Array; size: number } | Error>();
  let nextBlob = 0;
  await Promise.all(
    Array.from({ length: Math.min(DEFINITION_BLOB_CONCURRENCY, blobWork.length) }, async () => {
      while (nextBlob < blobWork.length) {
        const blob = blobWork[nextBlob++]!;
        try {
          blobResults.set(
            blob.sha,
            await readDefinitionBlob(client, repository, blob.sha, blob.path),
          );
        } catch (error) {
          blobResults.set(blob.sha, error instanceof Error ? error : new Error(String(error)));
        }
      }
    }),
  );

  const files = new Map<string, {
    type: "file";
    content: Uint8Array;
    blob_sha: string;
  }>();
  let bytesRead = 0;
  for (const file of regularFiles) {
    const blob = blobResults.get(file.sha);
    if (!blob) throw new Error(`${file.virtualPath}: definition blob result is missing`);
    if (blob instanceof Error) throw blob;
    if (blob.size !== file.size) {
      throw new Error(`${file.virtualPath}: content size does not match GitHub tree metadata`);
    }
    bytesRead += blob.bytes.byteLength;
    if (bytesRead > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
      throw new Error(`definition files: total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`);
    }
    files.set(file.virtualPath, {
      type: "file",
      content: new Uint8Array(blob.bytes),
      blob_sha: file.sha,
    });
  }
  return { source_commit: commit, files };
}
