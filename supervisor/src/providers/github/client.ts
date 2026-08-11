import { createHmac, timingSafeEqual } from "node:crypto";
import type { ControlThreadEvent } from "../../app/ports.js";

const HTTP_TIMEOUT_MS = 15_000;
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export function isGithubPullRequestUrl(value: unknown): value is string {
  return typeof value === "string" && GITHUB_PULL_REQUEST_URL_PATTERN.test(value);
}

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !/^sha256=[a-f\d]{64}$/i.test(signatureHeader)) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`,
    "utf8"
  );
  const actual = Buffer.from(signatureHeader, "utf8");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

interface GithubPullRequest {
  number: number;
  html_url: string;
  merged?: boolean;
  head: { ref: string; sha?: string };
  base: { ref: string };
}

interface GithubEventBase {
  repository: { full_name: string };
  sender?: { login?: string };
}

interface GithubPullRequestEvent extends GithubEventBase {
  kind: "pull_request";
  action: string;
  pull_request: GithubPullRequest;
}

interface GithubReviewEvent extends GithubEventBase {
  kind: "pull_request_review";
  action: string;
  pull_request: GithubPullRequest;
  review: {
    id: number;
    state: string;
    html_url: string;
    user?: { login: string };
  };
}

interface GithubWorkflowRunEvent extends GithubEventBase {
  kind: "workflow_run";
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    html_url: string;
  };
}

interface GithubCheckSuiteEvent extends GithubEventBase {
  kind: "check_suite";
  action: string;
  check_suite: {
    id: number;
    status: string;
    conclusion: string | null;
    head_branch: string | null;
    head_sha: string;
    url: string;
  };
}

export interface GithubIssueThread {
  number: number;
  title: string;
  html_url: string;
  state?: "open" | "closed";
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  body?: string | null;
  user?: { login: string };
  labels?: Array<{ id?: string; name: string }> | { nodes?: Array<{ name: string }> };
}

export interface GithubIssuesEvent extends GithubEventBase {
  kind: "issues";
  action: string;
  issue: GithubIssueThread;
  label?: { name?: string };
}

export interface GithubIssueCommentEvent extends GithubEventBase {
  kind: "issue_comment";
  action: string;
  issue: {
    number: number;
    pull_request?: { url?: string };
  };
  comment: {
    id: number;
    body?: string;
    html_url: string;
    created_at?: string;
    updated_at?: string;
    user?: { login: string; type?: string };
  };
}

export type GithubWebhookEvent =
  | GithubPullRequestEvent
  | GithubReviewEvent
  | GithubIssuesEvent
  | GithubIssueCommentEvent
  | GithubWorkflowRunEvent
  | GithubCheckSuiteEvent;

function parseObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub webhook body must be an object");
  }
  return value as Record<string, unknown>;
}

function recordField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const child = value[field];
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return child as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result === "") {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return result;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return result;
}

function validatePullRequestShape(payload: Record<string, unknown>): Record<string, unknown> {
  const pullRequest = recordField(payload, "pull_request");
  numberField(pullRequest, "number");
  stringField(pullRequest, "html_url");
  stringField(recordField(pullRequest, "head"), "ref");
  stringField(recordField(pullRequest, "base"), "ref");
  return pullRequest;
}

function validatePullRequestEvent(payload: Record<string, unknown>): void {
  const pullRequest = validatePullRequestShape(payload);
  if (typeof pullRequest.merged !== "boolean") {
    throw new Error("GitHub webhook is missing pull_request.merged");
  }
}

const OPENTHROTTLE_WEBHOOK_EVENTS = [
  "issues",
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "workflow_run",
  "check_suite",
] as const;

export { OPENTHROTTLE_WEBHOOK_EVENTS };

export type GithubIssueCommentClassification = "pull_request_comment" | "plain_issue_comment";
export type GithubIssueControlWebhookEvent = GithubIssuesEvent | GithubIssueCommentEvent;
export const GITHUB_CONTROL_LABEL = "openthrottle";
export const GITHUB_ISSUE_CONTEXT_LIMIT = 64_000;
export const GITHUB_ISSUE_CONTEXT_PAGE_LIMIT = 10;
export const GITHUB_ISSUE_CONTEXT_FETCH_BYTE_LIMIT = 8 * 1024 * 1024;

export function classifyGithubIssueComment(
  event: GithubIssueCommentEvent
): GithubIssueCommentClassification {
  return event.issue.pull_request ? "pull_request_comment" : "plain_issue_comment";
}

export function githubIssueControlEvent(
  event: GithubIssueControlWebhookEvent,
  options: { promptContext?: string; sessionId?: string } = {}
): ControlThreadEvent {
  const isIssue = event.kind === "issues";
  const repository = event.repository.full_name;
  const issueNumber = event.issue.number;
  const threadId = `${repository}#${issueNumber}`;
  const htmlUrl =
    "html_url" in event.issue && typeof event.issue.html_url === "string"
      ? event.issue.html_url
      : `https://github.com/${repository}/issues/${issueNumber}`;
  const body =
    isIssue
      ? event.issue.body ?? undefined
      : event.comment.body;
  return {
    provider: "github",
    action: isIssue ? "created" : "prompted",
    promptContext: isIssue ? options.promptContext ?? body : undefined,
    agentSession: {
      id: options.sessionId ?? `github:${threadId}`,
      threadId,
      thread: {
        id: threadId,
        identifier: `GH-${issueNumber}`,
        provider: "github",
        route: { key: repository },
        labels: isIssue ? event.issue.labels : undefined,
      },
    },
    activity: event.kind === "issue_comment"
      ? {
          id: `github-comment:${event.comment.id}`,
          content: { type: "text", body: body ?? "" },
          body: body ?? "",
        }
      : {
          id: `github-issue:${threadId}`,
          content: { type: "text", body: body ?? "" },
          body: htmlUrl,
        },
  };
}

export function parseGithubWebhook(eventName: string | undefined, raw: string): GithubWebhookEvent {
  const payload = parseObject(raw);
  if (!eventName) throw new Error("Missing X-GitHub-Event header");
  if (!(OPENTHROTTLE_WEBHOOK_EVENTS as readonly string[]).includes(eventName)) {
    throw new Error(`Unsupported GitHub event: ${eventName}`);
  }
  if (typeof payload.action !== "string") throw new Error("GitHub webhook is missing action");
  stringField(recordField(payload, "repository"), "full_name");
  if (eventName === "pull_request") {
    validatePullRequestEvent(payload);
  } else if (eventName === "pull_request_review") {
    validatePullRequestShape(payload);
  }
  if (eventName === "issues") {
    const issue = recordField(payload, "issue");
    numberField(issue, "number");
    stringField(issue, "title");
    stringField(issue, "html_url");
    if (issue.pull_request !== undefined) {
      throw new Error("GitHub issues webhook unexpectedly references a pull request");
    }
    if (payload.label !== undefined) {
      stringField(recordField(payload, "label"), "name");
    }
  } else if (eventName === "pull_request_review") {
    const review = recordField(payload, "review");
    numberField(review, "id");
    stringField(review, "state");
    stringField(review, "html_url");
  } else if (eventName === "issue_comment") {
    numberField(recordField(payload, "issue"), "number");
    const comment = recordField(payload, "comment");
    numberField(comment, "id");
    stringField(comment, "html_url");
  } else if (eventName === "workflow_run") {
    const run = recordField(payload, "workflow_run");
    numberField(run, "id");
    stringField(run, "name");
    stringField(run, "status");
    stringField(run, "head_branch");
    stringField(run, "head_sha");
    stringField(run, "html_url");
  } else if (eventName === "check_suite") {
    const suite = recordField(payload, "check_suite");
    numberField(suite, "id");
    stringField(suite, "status");
    stringField(suite, "head_sha");
    stringField(suite, "url");
    if (suite.head_branch !== null && typeof suite.head_branch !== "string") {
      throw new Error("GitHub webhook has invalid check_suite.head_branch");
    }
  }
  return { ...payload, kind: eventName } as unknown as GithubWebhookEvent;
}

export function githubIssueHasExactControlLabel(
  labels: GithubIssueThread["labels"] | undefined
): boolean {
  const nodes = Array.isArray(labels) ? labels : labels?.nodes ?? [];
  return nodes.some((label) => label.name === GITHUB_CONTROL_LABEL);
}

export function githubIssuesEventCarriesExactControlLabel(event: GithubIssuesEvent): boolean {
  if (event.action === "labeled") return event.label?.name === GITHUB_CONTROL_LABEL;
  if (event.action === "opened" || event.action === "reopened") {
    return githubIssueHasExactControlLabel(event.issue.labels);
  }
  return false;
}

export type GithubRepositoryPermission =
  | "none"
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

export function isAuthorizedGithubControlPermission(permission: GithubRepositoryPermission): boolean {
  return ["triage", "write", "maintain", "admin"].includes(permission);
}

export async function getRepositoryCollaboratorPermission(
  client: GithubClient,
  repo: string,
  username: string
): Promise<GithubRepositoryPermission> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
    throw new Error("GitHub collaborator permission lookup requires a safe username");
  }
  const permission = await githubRequest<{
    permission?: string;
    role_name?: string;
  }>(
    client,
    `/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`
  );
  const role = String(permission.role_name ?? permission.permission ?? "none").toLowerCase();
  if (role === "admin") return "admin";
  if (role === "maintain") return "maintain";
  if (role === "write" || role === "push") return "write";
  if (role === "triage") return "triage";
  if (role === "read" || role === "pull") return "read";
  return "none";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function boundedGithubIssueContext(input: {
  identifier: string;
  title: string;
  body: string;
  comments: Array<{
    id: number;
    body: string;
    author: string;
    url: string;
    createdAt: string;
  }>;
  paginationTruncated: boolean;
}): string {
  const title = input.title.slice(0, 1_000);
  const body = input.body.slice(0, 20_000);
  const issue = [
    `<issue identifier="${escapeXml(input.identifier)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<description>${escapeXml(body)}</description>`,
    `</issue>`,
  ].join("");
  const primary = [
    `<primary-directive-thread comment-id="github-issue-body">`,
    `<comment>${escapeXml(body || title)}</comment>`,
    `</primary-directive-thread>`,
  ].join("");
  const optional = [...input.comments]
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id - right.id
    )
    .map((comment) => [
    `<other-thread comment-id="github-comment-${comment.id}" author="${escapeXml(comment.author)}" url="${escapeXml(comment.url)}" created-at="${escapeXml(comment.createdAt)}">`,
    `<comment>${escapeXml(comment.body.slice(0, 4_000))}</comment>`,
    `</other-thread>`,
  ].join(""));
  const selected: string[] = [];
  let omitted = 0;
  const omissionSection = (count: number) => [
    `<other-thread comment-id="github-comments-omitted" author="openthrottle" omitted-count="${count}" pagination-truncated="${input.paginationTruncated}">`,
    `<comment>Older GitHub Issue comments were omitted by the deterministic context bound.</comment>`,
    `</other-thread>`,
  ].join("");
  for (let index = optional.length - 1; index >= 0; index -= 1) {
    const candidate = optional[index]!;
    const marker = omissionSection(omitted + index);
    const parts = [issue, primary, marker, candidate, ...selected];
    if (Buffer.byteLength(parts.join("\n"), "utf8") <= GITHUB_ISSUE_CONTEXT_LIMIT) {
      selected.unshift(candidate);
    } else {
      omitted += 1;
    }
  }
  const includeOmission = omitted > 0 || input.paginationTruncated;
  const omission = includeOmission
    ? omissionSection(omitted)
    : undefined;
  const parts = [issue, primary, ...(omission ? [omission] : []), ...selected];
  while (Buffer.byteLength(parts.join("\n"), "utf8") > GITHUB_ISSUE_CONTEXT_LIMIT && selected.length > 0) {
    selected.shift();
    omitted += 1;
    parts.splice(2, parts.length - 2,
      omissionSection(omitted),
      ...selected
    );
  }
  return parts.join("\n");
}

export async function fetchGithubIssueLabels(
  client: GithubClient,
  repo: string,
  issueNumber: number
): Promise<Array<{ name: string }>> {
  const issue = await githubRequest<GithubIssueThread>(client, `/repos/${repo}/issues/${issueNumber}`);
  const labels = Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes ?? [];
  return labels.map((label) => ({ name: label.name }));
}

export async function fetchGithubIssueLifecycle(
  client: GithubClient,
  repo: string,
  issueNumber: number
): Promise<{ state: "open" | "closed"; updatedAt: string }> {
  const issue = await githubRequest<GithubIssueThread>(client, `/repos/${repo}/issues/${issueNumber}`);
  if (issue.state !== "open" && issue.state !== "closed") {
    throw new Error("GitHub Issue lifecycle lookup returned an invalid state");
  }
  const updatedAt = issue.updated_at ?? issue.created_at;
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("GitHub Issue lifecycle lookup returned an invalid timestamp");
  }
  return { state: issue.state, updatedAt };
}

export async function fetchGithubIssueContext(
  client: GithubClient,
  repo: string,
  issueNumber: number
): Promise<string> {
  const issue = await githubRequest<GithubIssueThread>(client, `/repos/${repo}/issues/${issueNumber}`);
  const comments: Array<{
    id: number;
    body?: string | null;
    html_url?: string;
    created_at?: string;
    user?: { login?: string };
  }> = [];
  let fetchedBytes = 0;
  let paginationTruncated = false;
  for (let page = 1; page <= GITHUB_ISSUE_CONTEXT_PAGE_LIMIT; page += 1) {
    const pageComments = await githubRequest<typeof comments>(
      client,
      `/repos/${repo}/issues/${issueNumber}/comments?per_page=100${page === 1 ? "" : `&page=${page}`}`
    );
    for (const comment of pageComments) {
      const serializedBytes = Buffer.byteLength(JSON.stringify(comment), "utf8");
      if (fetchedBytes + serializedBytes > GITHUB_ISSUE_CONTEXT_FETCH_BYTE_LIMIT) {
        paginationTruncated = true;
        break;
      }
      fetchedBytes += serializedBytes;
      comments.push(comment);
    }
    if (paginationTruncated || pageComments.length < 100) break;
    if (page === GITHUB_ISSUE_CONTEXT_PAGE_LIMIT) paginationTruncated = true;
  }
  return boundedGithubIssueContext({
    identifier: `GH-${issue.number}`,
    title: issue.title,
    body: issue.body ?? "",
    comments: comments
      .map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        author: comment.user?.login ?? "unknown",
        url: comment.html_url ?? `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${comment.id}`,
        createdAt: comment.created_at ?? "9999-12-31T23:59:59.999Z",
      }))
      .filter((comment) => comment.body.length > 0),
    paginationTruncated,
  });
}

export function isOpenthrottleBranch(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ref.startsWith("ot/");
}

export function parsePullRequestUrl(url: string): {
  host: string;
  repo: string;
  number: number;
} {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error(`Invalid GitHub pull request URL: ${url}`);
  return {
    host: parsed.host,
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  };
}

export interface GithubClient {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  actorLogin?: string;
}

async function githubRequest<T>(
  client: GithubClient,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(`${client.apiBaseUrl ?? "https://api.github.com"}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

async function githubTextTailRequest(
  client: GithubClient,
  path: string,
  maxChars: number,
  init: RequestInit = {}
): Promise<string> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(`${client.apiBaseUrl ?? "https://api.github.com"}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Accept: "text/plain",
      Authorization: `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  if (!response.body) return logTail(await response.text(), maxChars);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true }).slice(-maxChars * 2);
    tail += chunk;
    if (tail.length > maxChars * 2) tail = tail.slice(-maxChars * 2);
  }
  tail += decoder.decode();
  return logTail(tail, maxChars);
}

export interface RepositoryReadiness {
  repo: string;
  baseBranch: string;
  webhookId: number;
  webhookAction: "created" | "updated";
}

export interface RepositoryWebhookReconciliation {
  repo: string;
  webhookId: number;
  webhookAction: "unchanged" | "updated" | "created";
  missingEvents: string[];
}

interface GithubRepositoryHook {
  id: number;
  active: boolean;
  events: string[];
  config?: { url?: string };
}

function githubWebhookConfiguration(input: {
  webhookUrl: string;
  webhookSecret: string;
}) {
  return {
    active: true,
    events: OPENTHROTTLE_WEBHOOK_EVENTS,
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
  configuration: ReturnType<typeof githubWebhookConfiguration>
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
  configuration: ReturnType<typeof githubWebhookConfiguration>
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(client, `/repos/${repo}/hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web", ...configuration }),
  });
}

export async function ensureRepositoryControlLabel(
  client: GithubClient,
  repo: string
): Promise<"unchanged" | "created" | "renamed"> {
  for (let page = 1; page <= 10; page += 1) {
    const labels = await githubRequest<Array<{ name: string }>>(
      client,
      `/repos/${repo}/labels?per_page=100${page === 1 ? "" : `&page=${page}`}`
    );
    const exact = labels.find((label) => label.name === GITHUB_CONTROL_LABEL);
    if (exact) return "unchanged";
    const caseVariant = labels.find(
      (label) => label.name.toLowerCase() === GITHUB_CONTROL_LABEL
    );
    if (caseVariant) {
      await githubRequest(client, `/repos/${repo}/labels/${encodeURIComponent(caseVariant.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: GITHUB_CONTROL_LABEL }),
      });
      return "renamed";
    }
    if (labels.length < 100) break;
  }
  await githubRequest(client, `/repos/${repo}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: GITHUB_CONTROL_LABEL,
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
  }
): Promise<RepositoryReadiness> {
  const repository = await githubRequest<{
    full_name: string;
    default_branch: string;
  }>(client, `/repos/${input.repo}`);
  const baseBranch = input.requestedBaseBranch || repository.default_branch;
  await githubRequest(client, `/repos/${repository.full_name}/branches/${encodeURIComponent(baseBranch)}`);

  const hooks = await githubRequest<GithubRepositoryHook[]>(
    client,
    `/repos/${repository.full_name}/hooks?per_page=100`
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

export async function reconcileRepositoryWebhook(
  client: GithubClient,
  input: {
    repo: string;
    webhookId: number;
    webhookUrl: string;
    webhookSecret: string;
  }
): Promise<RepositoryWebhookReconciliation> {
  let hook: GithubRepositoryHook;
  try {
    hook = await githubRequest<GithubRepositoryHook>(
      client,
      `/repos/${input.repo}/hooks/${input.webhookId}`
    );
  } catch (error) {
    if (!String(error).includes("GitHub API error (404)")) throw error;
    const hooks = await githubRequest<GithubRepositoryHook[]>(
      client,
      `/repos/${input.repo}/hooks?per_page=100`
    );
    const existing = hooks.find((candidate) => candidate.config?.url === input.webhookUrl);
    if (existing) {
      hook = existing;
    } else {
      const created = await createRepositoryWebhook(
        client,
        input.repo,
        githubWebhookConfiguration(input)
      );
      return {
        repo: input.repo,
        webhookId: created.id,
        webhookAction: "created",
        missingEvents: [...OPENTHROTTLE_WEBHOOK_EVENTS],
      };
    }
  }
  const missingEvents = OPENTHROTTLE_WEBHOOK_EVENTS.filter(
    (event) => !hook.events.includes(event)
  );
  const replacementHook = hook.id !== input.webhookId;
  const needsPatch = replacementHook || missingEvents.length > 0 || !hook.active || hook.config?.url !== input.webhookUrl;
  if (needsPatch) {
    await patchRepositoryWebhook(client, input.repo, hook.id, githubWebhookConfiguration(input));
  }
  return {
    repo: input.repo,
    webhookId: hook.id,
    webhookAction: needsPatch ? "updated" : "unchanged",
    missingEvents,
  };
}

export interface FailedRepositoryWebhookDelivery {
  id: number;
  guid: string;
  status_code: number;
  redelivery: boolean;
  delivered_at: string;
}

export async function listFailedRepositoryWebhookDeliveries(
  client: GithubClient,
  repo: string,
  hookId: number,
  limit = 50
): Promise<FailedRepositoryWebhookDelivery[]> {
  if (!Number.isSafeInteger(hookId) || hookId <= 0) {
    throw new Error("GitHub webhook id must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("GitHub webhook delivery limit must be between 1 and 100");
  }
  const deliveries = await githubRequest<FailedRepositoryWebhookDelivery[]>(
    client,
    `/repos/${repo}/hooks/${hookId}/deliveries?per_page=${limit}`
  );
  return deliveries
    .filter((delivery) => delivery.status_code < 200 || delivery.status_code >= 300)
    .slice(0, limit)
    .map((delivery) => ({
      id: delivery.id,
      guid: delivery.guid,
      status_code: delivery.status_code,
      redelivery: delivery.redelivery,
      delivered_at: delivery.delivered_at,
    }));
}

export async function redeliverRepositoryWebhookDelivery(
  client: GithubClient,
  repo: string,
  hookId: number,
  deliveryId: number
): Promise<void> {
  if (![hookId, deliveryId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("GitHub webhook and delivery ids must be positive safe integers");
  }
  await githubRequest<void>(
    client,
    `/repos/${repo}/hooks/${hookId}/deliveries/${deliveryId}/attempts`,
    { method: "POST" }
  );
}

export async function branchExists(
  client: GithubClient,
  repo: string,
  branch: string
): Promise<boolean> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(
    `${client.apiBaseUrl ?? "https://api.github.com"}/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  return true;
}

export interface RepositoryConfigAtCommit {
  repository: string;
  branch: string;
  baseCommit: string;
  blobSha: string;
  content: string;
}

// Resolve branch state once, then fetch repository configuration by that exact
// commit. The returned blob/commit pair is suitable for sealing into a pipeline
// instance; later branch or working-tree changes cannot reinterpret it.
export async function getRepositoryConfigAtCommit(
  client: GithubClient,
  repository: string,
  branch: string
): Promise<RepositoryConfigAtCommit> {
  const commit = await githubRequest<{ sha: string }>(
    client,
    `/repos/${repository}/commits/${encodeURIComponent(branch)}`
  );
  if (!/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error("GitHub returned an invalid base commit SHA");
  const file = await githubRequest<{
    type: string;
    sha: string;
    encoding: string;
    content: string;
    size: number;
  }>(
    client,
    `/repos/${repository}/contents/.openthrottle.yml?ref=${encodeURIComponent(commit.sha)}`
  );
  if (file.type !== "file" || file.encoding !== "base64" || !/^[a-f0-9]{40}$/i.test(file.sha)) {
    throw new Error("GitHub returned an invalid .openthrottle.yml blob");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 256 * 1024) {
    throw new Error(".openthrottle.yml exceeds the 256 KiB snapshot limit");
  }
  const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(content, "utf8") !== file.size) {
    throw new Error(".openthrottle.yml content size does not match GitHub metadata");
  }
  return {
    repository,
    branch,
    baseCommit: commit.sha.toLowerCase(),
    blobSha: file.sha.toLowerCase(),
    content,
  };
}

export interface RepositoryFileAtCommit {
  repository: string;
  commit: string;
  path: string;
  blobSha: string;
  content: string;
}

export interface RepositoryPackageFileAtCommit extends RepositoryFileAtCommit {
  size: number;
}

export interface RepositoryDirectoryAtCommit {
  repository: string;
  commit: string;
  directory: string;
  files: RepositoryPackageFileAtCommit[];
}

function assertSafeRepositoryPath(path: string, kind: "file" | "directory"): void {
  if (
    !path ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`repository ${kind} read requires a safe relative path`);
  }
}

async function readRepositoryBlob(
  client: GithubClient,
  repository: string,
  blobSha: string,
  path: string,
  maxSize: number
): Promise<{ content: string; size: number }> {
  if (!/^[a-f0-9]{40}$/i.test(blobSha)) throw new Error(`GitHub returned an invalid repository blob SHA for ${path}`);
  const blob = await githubRequest<{
    sha: string;
    encoding: string;
    content: string;
    size: number;
  }>(
    client,
    `/repos/${repository}/git/blobs/${blobSha}`
  );
  if (blob.sha.toLowerCase() !== blobSha.toLowerCase() || blob.encoding !== "base64") {
    throw new Error(`GitHub returned an invalid repository file blob for ${path}`);
  }
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > maxSize) {
    throw new Error(`${path} exceeds the ${maxSize} byte snapshot limit`);
  }
  const content = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(content, "utf8") !== blob.size) {
    throw new Error(`${path} content size does not match GitHub metadata`);
  }
  return { content, size: blob.size };
}

export async function getRepositoryFileAtCommit(
  client: GithubClient,
  repository: string,
  commit: string,
  path: string
): Promise<RepositoryFileAtCommit> {
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("repository file read requires a full commit SHA");
  assertSafeRepositoryPath(path, "file");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = await githubRequest<{
    type: string;
    sha: string;
    encoding: string;
    content: string;
    size: number;
  }>(
    client,
    `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(commit)}`
  );
  if (file.type !== "file" || file.encoding !== "base64" || !/^[a-f0-9]{40}$/i.test(file.sha)) {
    throw new Error(`GitHub returned an invalid repository file blob for ${path}`);
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 256 * 1024) {
    throw new Error(`${path} exceeds the 256 KiB snapshot limit`);
  }
  const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(content, "utf8") !== file.size) {
    throw new Error(`${path} content size does not match GitHub metadata`);
  }
  return {
    repository,
    commit: commit.toLowerCase(),
    path,
    blobSha: file.sha.toLowerCase(),
    content,
  };
}

export async function getRepositoryDirectoryAtCommit(
  client: GithubClient,
  repository: string,
  commit: string,
  directory: string
): Promise<RepositoryDirectoryAtCommit> {
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("repository directory read requires a full commit SHA");
  assertSafeRepositoryPath(directory, "directory");
  if (directory.endsWith("/")) throw new Error("repository directory read requires a safe relative path");
  const commitObject = await githubRequest<{ tree: { sha: string } }>(
    client,
    `/repos/${repository}/git/commits/${commit}`
  );
  if (!/^[a-f0-9]{40}$/i.test(commitObject.tree.sha)) {
    throw new Error("GitHub returned an invalid repository tree SHA");
  }
  const tree = await githubRequest<{
    truncated?: boolean;
    tree: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
      size?: number;
    }>;
  }>(
    client,
    `/repos/${repository}/git/trees/${commitObject.tree.sha}?recursive=1`
  );
  if (tree.truncated) throw new Error(`${directory} package tree exceeds the GitHub recursive tree limit`);
  const prefix = `${directory}/`;
  const entries = tree.tree
    .filter((entry) => entry.path === directory || entry.path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
  const files: RepositoryPackageFileAtCommit[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.path === directory || entry.type === "tree") continue;
    assertSafeRepositoryPath(entry.path, "file");
    if (!entry.path.startsWith(prefix)) throw new Error(`${entry.path} escapes repository package ${directory}`);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(`${entry.path} is not a regular file in repository package ${directory}`);
    }
    if (files.length >= 64) throw new Error(`${directory} package exceeds the 64 file limit`);
    const blob = await readRepositoryBlob(client, repository, entry.sha, entry.path, 256 * 1024);
    if (entry.size !== undefined && entry.size !== blob.size) {
      throw new Error(`${entry.path} content size does not match GitHub tree metadata`);
    }
    totalBytes += blob.size;
    if (totalBytes > 256 * 1024) throw new Error(`${directory} package exceeds the 256 KiB snapshot limit`);
    files.push({
      repository,
      commit: commit.toLowerCase(),
      path: entry.path,
      blobSha: entry.sha.toLowerCase(),
      content: blob.content,
      size: blob.size,
    });
  }
  if (files.length === 0) throw new Error(`${directory} package contains no regular files`);
  return { repository, commit: commit.toLowerCase(), directory, files };
}
// Every supervisor-authored comment starts with this prefix. Marker text is a
// stable upsert identity, not provenance: webhook handling trusts exact
// persisted comment IDs and only defers a marker while its durable write
// intent is still in flight.
export const OPENTHROTTLE_COMMENT_MARKER_PREFIX = "<!-- openthrottle:";

export function pipelineSummaryCommentMarker(identity: string): string {
  if (!/^[A-Za-z0-9_.:/#-]{1,200}$/.test(identity)) {
    throw new Error("GitHub comment identity is unsafe");
  }
  return `${OPENTHROTTLE_COMMENT_MARKER_PREFIX}pipeline-summary:${identity} -->`;
}

async function upsertIssueCommentWithMarker(
  client: GithubClient,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string
): Promise<{ id: number; html_url: string }> {
  if (!marker.startsWith(OPENTHROTTLE_COMMENT_MARKER_PREFIX) || !marker.endsWith(" -->")) {
    throw new Error("GitHub comment marker is unsafe");
  }
  if (!body.startsWith(marker)) throw new Error("GitHub comment is missing its stable marker");
  const candidates: Array<{
    id: number;
    body?: string;
    html_url: string;
    user?: { login?: string };
  }> = [];
  for (let page = 1; page <= 10; page += 1) {
    const comments = await githubRequest<typeof candidates>(
      client,
      `/repos/${repo}/issues/${issueNumber}/comments?per_page=100${page === 1 ? "" : `&page=${page}`}`
    );
    candidates.push(...comments.filter((comment) =>
      comment.body === marker || comment.body?.startsWith(`${marker}\n`) === true
    ));
    if (comments.length < 100) break;
  }
  let actorLogin = client.actorLogin;
  if (!actorLogin && candidates.some((comment) => comment.user?.login)) {
    try {
      actorLogin = (await githubRequest<{ login?: string }>(client, "/user")).login;
    } catch {
      // Without an authenticated identity, never adopt an attributed comment:
      // a user can type a syntactically valid marker too.
    }
  }
  const existing = candidates.find((comment) =>
    !comment.user?.login ||
    (actorLogin !== undefined && comment.user.login.toLowerCase() === actorLogin.toLowerCase())
  );
  if (existing) {
    return githubRequest(client, `/repos/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
  return githubRequest(client, `/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export async function upsertPullRequestComment(
  client: GithubClient,
  repo: string,
  pullNumber: number,
  identity: string,
  body: string
): Promise<{ id: number; html_url: string }> {
  return upsertIssueCommentWithMarker(
    client,
    repo,
    pullNumber,
    pipelineSummaryCommentMarker(identity),
    body
  );
}

export async function upsertIssueStatusComment(
  client: GithubClient,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string
): Promise<{ id: number; html_url: string }> {
  return upsertIssueCommentWithMarker(client, repo, issueNumber, marker, body);
}

export async function pinIssueComment(
  client: GithubClient,
  repo: string,
  commentId: number
): Promise<void> {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error("GitHub Issue comment id must be a positive safe integer");
  }
  await githubRequest<void>(client, `/repos/${repo}/issues/comments/${commentId}/pin`, {
    method: "PUT",
    headers: { "X-GitHub-Api-Version": "2026-03-10" },
  });
}

export interface MergeReadiness {
  mergeable: boolean;
  draft: boolean;
  checksPresent: boolean;
  checksGreen: boolean;
  headSha: string;
}

export async function getMergeReadiness(
  client: GithubClient,
  repo: string,
  pullNumber: number
): Promise<MergeReadiness> {
  const pull = await githubRequest<{
    mergeable: boolean | null;
    draft: boolean;
    head: { sha: string };
  }>(client, `/repos/${repo}/pulls/${pullNumber}`);
  const checks = await githubRequest<{
    check_runs: Array<{ status: string; conclusion: string | null }>;
  }>(client, `/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`);
  const passingConclusions = new Set(["success", "neutral", "skipped"]);
  return {
    mergeable: pull.mergeable === true,
    draft: pull.draft,
    checksPresent: checks.check_runs.length > 0,
    checksGreen:
      checks.check_runs.length > 0 &&
      checks.check_runs.every(
        (check) => check.status === "completed" && passingConclusions.has(check.conclusion ?? "")
      ),
    headSha: pull.head.sha,
  };
}

export interface GithubFailedCheckDetail {
  workflowName: string;
  jobName: string;
  stepNames: string[];
  logTail: string | null;
  htmlUrl: string | null;
}

interface GithubActionsJob {
  id: number;
  name: string;
  html_url?: string | null;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
  workflow_name?: string | null;
}

function failingConclusion(conclusion: string | null | undefined): boolean {
  return ["failure", "timed_out", "cancelled", "action_required"].includes(conclusion ?? "");
}

function logTail(text: string, maxChars = 2_000): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function stepNames(steps: GithubActionsJob["steps"]): string[] {
  return (steps ?? [])
    .filter((step) => failingConclusion(step.conclusion))
    .map((step) => step.name)
    .filter((name) => name.length > 0)
    .slice(0, 10);
}

async function jobLogTail(client: GithubClient, repo: string, jobId: number): Promise<string | null> {
  try {
    return await githubTextTailRequest(client, `/repos/${repo}/actions/jobs/${jobId}/logs`, 2_000);
  } catch {
    return null;
  }
}

async function detailFromJob(
  client: GithubClient,
  repo: string,
  job: GithubActionsJob,
  fallbackWorkflowName: string,
  fallbackJobName = job.name,
  fallbackHtmlUrl: string | null = null
): Promise<GithubFailedCheckDetail> {
  return {
    workflowName: job.workflow_name ?? fallbackWorkflowName,
    jobName: job.name || fallbackJobName,
    stepNames: stepNames(job.steps),
    logTail: await jobLogTail(client, repo, job.id),
    htmlUrl: job.html_url ?? fallbackHtmlUrl,
  };
}

export async function getFailingGithubCheckDetails(
  client: GithubClient,
  repo: string,
  input: {
    headSha: string;
    workflowRunId?: number;
    workflowName?: string;
  }
): Promise<GithubFailedCheckDetail[]> {
  if (input.workflowRunId !== undefined) {
    const jobs = await githubRequest<{ jobs: GithubActionsJob[] }>(
      client,
      `/repos/${repo}/actions/runs/${input.workflowRunId}/jobs?filter=latest&per_page=100`
    );
    const failingJobs = jobs.jobs.filter((job) => failingConclusion(job.conclusion)).slice(0, 3);
    return Promise.all(failingJobs.map((job) =>
      detailFromJob(client, repo, job, input.workflowName ?? "GitHub workflow")
    ));
  }

  const checks = await githubRequest<{
    check_runs: Array<{
      id: number;
      name: string;
      conclusion: string | null;
      details_url?: string | null;
      external_id?: string | null;
      html_url?: string | null;
    }>;
  }>(client, `/repos/${repo}/commits/${input.headSha}/check-runs?per_page=100`);
  const failingChecks = checks.check_runs.filter((check) => failingConclusion(check.conclusion)).slice(0, 3);
  return Promise.all(failingChecks.map(async (check) => {
    const parsedJobId = check.details_url?.match(/\/job\/(\d+)(?:\?|$)/)?.[1];
    const jobId = Number(parsedJobId ?? check.external_id);
    if (Number.isSafeInteger(jobId) && jobId > 0) {
      try {
        const job = await githubRequest<GithubActionsJob>(client, `/repos/${repo}/actions/jobs/${jobId}`);
        return detailFromJob(
          client,
          repo,
          job,
          input.workflowName ?? "GitHub check suite",
          check.name,
          check.html_url ?? null
        );
      } catch {
        // Fall back to check-run metadata below.
      }
    }
    return {
      workflowName: input.workflowName ?? "GitHub check suite",
      jobName: check.name,
      stepNames: [],
      logTail: null,
      htmlUrl: check.html_url ?? check.details_url ?? null,
    };
  }));
}

export function mergePullRequest(
  client: GithubClient,
  repo: string,
  pullNumber: number,
  expectedHeadSha: string
): Promise<{ merged: boolean; message: string }> {
  return githubRequest(client, `/repos/${repo}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
  });
}
