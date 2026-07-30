export type ActivityPublicationInput =
  | {
      id?: string;
      sessionId: string;
      type: "thought" | "elicitation" | "response" | "error";
      body: string;
      ephemeral?: boolean;
    }
  | {
      id?: string;
      sessionId: string;
      type: "action";
      action: string;
      parameter: string;
      result?: string;
      ephemeral?: boolean;
    };

export interface ActivityPublicationPort {
  publishActivity(
    activity: ActivityPublicationInput,
    issueId?: string,
    runId?: string
  ): Promise<void>;

  publishError(
    sessionId: string | undefined,
    issueId: string | undefined,
    message: string
  ): Promise<void>;
}

export interface ResolvedLinearLabel {
  name: string;
  parentName?: string;
}

export interface LinearLabelPort {
  fetchIssueLabels(issueId: string): Promise<ResolvedLinearLabel[]>;
}

export interface LinearIssueEventPayload {
  id: string;
  identifier: string;
  team?: { id?: string; key?: string; name?: string };
  labels?: Array<{ id?: string; name: string }> | { nodes?: Array<{ name: string }> };
}

export interface LinearAgentSessionEvent {
  action: "created" | "prompted";
  promptContext?: string;
  agentSession: {
    id: string;
    issueId?: string;
    issue?: LinearIssueEventPayload;
  };
  agentActivity?: {
    id: string;
    signal?: string;
    content?: { type?: string; body?: string };
    body?: string;
  };
}

export interface RepositoryConfigSnapshot {
  repository: string;
  branch: string;
  baseCommit: string;
  blobSha: string;
  content: string;
}

export interface RepositoryFileSnapshot {
  repository: string;
  commit: string;
  path: string;
  blobSha: string;
  content: string;
}

export interface RepositoryReadPort {
  branchExists(repository: string, branch: string): Promise<boolean>;
  getRepositoryConfigAtCommit(repository: string, branch: string): Promise<RepositoryConfigSnapshot>;
  getRepositoryFileAtCommit(
    repository: string,
    commit: string,
    path: string
  ): Promise<RepositoryFileSnapshot>;
}

export interface PullRequestRef {
  host: string;
  repo: string;
  number: number;
}

export interface PullRequestReadiness {
  mergeable: boolean;
  draft: boolean;
  checksPresent: boolean;
  checksGreen: boolean;
  headSha: string;
}

export interface MergePort {
  parsePullRequestUrl(url: string): PullRequestRef;
  getMergeReadiness(repo: string, pullNumber: number): Promise<PullRequestReadiness>;
  mergePullRequest(
    repo: string,
    pullNumber: number,
    expectedHeadSha: string
  ): Promise<{ merged: boolean; message?: string }>;
}
