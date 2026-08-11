import { createHash, randomBytes } from "node:crypto";

const OPENTHROTTLE_MARKER_PREFIX = "<!-- openthrottle:";
const WRITE_INTENT_TTL_MS = 5 * 60 * 1000;

interface CommentProvenanceSettings {
  acquireSupervisorLease(
    name: string,
    owner: string,
    nowIso: string,
    leaseUntilIso: string
  ): boolean;
  releaseSupervisorLease(name: string, owner: string): boolean;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export interface GithubSupervisorCommentWriteIntent {
  repository: string;
  issueNumber: number;
  marker: string;
  leaseName: string;
  owner: string;
}

interface PendingCommentWrite {
  state: "pending";
  expires_at: string;
}

function markerFromBody(body: string | null | undefined): string | undefined {
  const marker = body?.split("\n", 1)[0];
  if (!marker || marker.length > 512 ||
      !marker.startsWith(OPENTHROTTLE_MARKER_PREFIX) || !marker.endsWith(" -->")) {
    return undefined;
  }
  return marker;
}

function writeIntentKey(repository: string, issueNumber: number, marker: string): string {
  const identity = createHash("sha256")
    .update(repository.toLowerCase())
    .update("\0")
    .update(String(issueNumber))
    .update("\0")
    .update(marker)
    .digest("hex");
  return `github-supervisor-comment-write:${identity}`;
}

export function beginGithubSupervisorCommentWrite(
  settings: Pick<CommentProvenanceSettings, "acquireSupervisorLease" | "setSetting">,
  repository: string,
  issueNumber: number,
  marker: string,
  now = new Date()
): GithubSupervisorCommentWriteIntent {
  const validated = markerFromBody(marker);
  if (validated !== marker || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("GitHub supervisor comment write has an invalid target or marker");
  }
  const key = writeIntentKey(repository, issueNumber, marker);
  const leaseName = `github-comment-write:${key.slice(key.lastIndexOf(":") + 1)}`;
  const owner = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + WRITE_INTENT_TTL_MS).toISOString();
  if (!settings.acquireSupervisorLease(leaseName, owner, now.toISOString(), expiresAt)) {
    throw new Error("GitHub supervisor comment publication is already in flight");
  }
  settings.setSetting(
    key,
    JSON.stringify({
      state: "pending",
      expires_at: expiresAt,
    } satisfies PendingCommentWrite)
  );
  return { repository, issueNumber, marker, leaseName, owner };
}

export function settleGithubSupervisorCommentWrite(
  settings: Pick<
    CommentProvenanceSettings,
    "acquireSupervisorLease" | "releaseSupervisorLease" | "setSetting"
  >,
  intent: GithubSupervisorCommentWriteIntent,
  commentId: number,
  now = new Date()
): void {
  // Revalidate and renew ownership before mutating the shared intent. A writer
  // that resumes after its lease expired must not overwrite a successor's
  // pending state with a stale settlement.
  if (!settings.acquireSupervisorLease(
    intent.leaseName,
    intent.owner,
    now.toISOString(),
    new Date(now.getTime() + WRITE_INTENT_TTL_MS).toISOString()
  )) {
    throw new Error("GitHub supervisor comment write lease was lost before settlement");
  }
  settings.setSetting(
    writeIntentKey(intent.repository, intent.issueNumber, intent.marker),
    JSON.stringify({ state: "settled", comment_id: commentId })
  );
  if (!settings.releaseSupervisorLease(intent.leaseName, intent.owner)) {
    throw new Error("GitHub supervisor comment write lease was lost before settlement");
  }
}

export function githubSupervisorCommentWriteIsPending(
  settings: Pick<CommentProvenanceSettings, "getSetting">,
  repository: string,
  issueNumber: number,
  body: string | null | undefined,
  now = new Date()
): boolean {
  const marker = markerFromBody(body);
  if (!marker) return false;
  const raw = settings.getSetting(writeIntentKey(repository, issueNumber, marker));
  if (!raw) return false;
  try {
    const intent = JSON.parse(raw) as Partial<PendingCommentWrite>;
    return intent.state === "pending" &&
      typeof intent.expires_at === "string" &&
      Date.parse(intent.expires_at) > now.getTime();
  } catch {
    return false;
  }
}
