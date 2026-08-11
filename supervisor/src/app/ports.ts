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

export type ControlProvider = "linear" | "github";

export interface ResolvedControlLabel {
  name: string;
  parentName?: string;
}

export interface ControlLabelPort {
  fetchThreadLabels(threadId: string): Promise<ResolvedControlLabel[]>;
}

export interface ControlThread {
  id: string;
  identifier: string;
  provider: ControlProvider;
  route?: { id?: string; key?: string; name?: string };
  labels?: Array<{ id?: string; name: string }> | { nodes?: Array<{ name: string }> };
}

export interface ControlThreadEvent {
  provider: ControlProvider;
  action: "created" | "prompted";
  providerActivatedAt?: string;
  providerActivationId?: string;
  providerActivationAdvances?: boolean;
  providerActivationPreviousId?: string;
  promptContext?: string;
  agentSession: {
    id: string;
    threadId?: string;
    thread?: ControlThread;
  };
  activity?: {
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

export interface RepositoryPackageFileSnapshot extends RepositoryFileSnapshot {
  size: number;
}

export interface RepositoryDirectorySnapshot {
  repository: string;
  commit: string;
  directory: string;
  files: RepositoryPackageFileSnapshot[];
}

export interface RepositoryReadPort {
  branchExists(repository: string, branch: string): Promise<boolean>;
  getRepositoryConfigAtCommit(repository: string, branch: string): Promise<RepositoryConfigSnapshot>;
  getRepositoryFileAtCommit(
    repository: string,
    commit: string,
    path: string
  ): Promise<RepositoryFileSnapshot>;
  getRepositoryDirectoryAtCommit(
    repository: string,
    commit: string,
    directory: string
  ): Promise<RepositoryDirectorySnapshot>;
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
