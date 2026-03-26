export interface OpenThrottleConfig {
  base_branch: string;
  test: string;
  lint: string;
  build: string;
  format: string;
  dev: string;
  agent: string;
  snapshot: string;
  notifications: string;
  post_bootstrap: string[];
  mcp_servers: Record<string, McpServerConfig>;
  limits: {
    max_turns: number;
    max_budget_usd: number;
    task_timeout: number;
  };
  review: {
    enabled: boolean;
    max_rounds: number;
  };
  env_files?: Record<string, string[]>;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type TaskType =
  | "prd"
  | "bug"
  | "review-fix"
  | "review"
  | "investigation";

export interface TaskContext {
  githubRepo: string;
  githubToken: string;
  taskType: TaskType;
  workItem: string;
  fromPr: string;
  sandboxHome: string;
  repo: string;
  logDir: string;
  sessionsDir: string;
  promptsDir: string;
  baseBranch: string;
  config: OpenThrottleConfig;
  telegramBotToken: string;
  telegramChatId: string;
  supabaseAccessToken: string;
}

export interface AgentResult {
  sessionId: string;
  costUsd: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationApiMs: number | null;
  resultText: string;
  isError: boolean;
}

export interface SessionInfo {
  sessionId: string;
  isResume: boolean;
}
