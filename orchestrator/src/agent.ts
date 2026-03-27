import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { TaskContext, AgentResult, ProjectMcpServerConfig } from "./types.js";
import {
  guardHook,
  createLogCommandsHook,
  createAutoFormatHook,
} from "./hooks.js";
import { createTelegramMcpServer } from "./telegram.js";
import { resolveSession } from "./lib/session.js";
import { log } from "./lib/logger.js";

export interface InvokeOptions {
  prompt: string;
  taskKey: string;
  taskId: string;
  ctx: TaskContext;
  timeoutMs: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  extraMcpServers?: Record<string, ProjectMcpServerConfig>;
}

export async function invokeAgent(opts: InvokeOptions): Promise<AgentResult> {
  const { ctx } = opts;
  const session = resolveSession(ctx.sessionsDir, opts.taskKey, ctx.fromPr);

  // Build MCP servers: telegram tools + project-specific servers
  const mcpServers: Record<string, any> = {};

  // Add Telegram custom tool (ask_human) if credentials available
  if (ctx.telegramBotToken && ctx.telegramChatId) {
    mcpServers["telegram-tools"] = createTelegramMcpServer();
  }

  // Add context7 (always available)
  mcpServers["context7"] = {
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
  };

  // Add project-specific MCP servers from config
  if (opts.extraMcpServers) {
    Object.assign(mcpServers, opts.extraMcpServers);
  }

  // Build hooks
  const logCommandsHook = createLogCommandsHook(ctx.logDir, opts.taskId);
  const autoFormatHook = createAutoFormatHook(ctx.repo);

  // Build stop hooks from lint/test commands.
  // Stop hooks fire when the agent wants to stop. If lint/test fails, we
  // return stopReason to prevent stopping (so the agent can fix the issue).
  const stopHookCallbacks: HookCallback[] = [];
  for (const cmd of [ctx.config.lint, ctx.config.test].filter(Boolean)) {
    const hookFn: HookCallback = async (_input, _toolUseId, _options) => {
      const { execSync } = await import("node:child_process");
      try {
        execSync(cmd, { cwd: ctx.repo, timeout: 120_000, stdio: "pipe" });
      } catch (err: any) {
        return { stopReason: `Stop hook failed: ${cmd}\n${err?.stderr?.toString().slice(0, 500) ?? err?.message}` };
      }
      return {};
    };
    stopHookCallbacks.push(hookFn);
  }

  // Determine allowed tools
  const allowedTools = [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Glob",
    "Grep",
    "Agent",
    "Skill",
    "TodoWrite",
    "NotebookEdit",
    "WebSearch",
    "WebFetch",
    "mcp__telegram-tools__ask_human",
    "mcp__context7__*",
  ];

  // Add Supabase tool permissions if configured
  if (ctx.config.mcp_servers.supabase) {
    allowedTools.push(
      "mcp__supabase__create_branch",
      "mcp__supabase__delete_branch",
      "mcp__supabase__list_branches",
      "mcp__supabase__reset_branch",
      "mcp__supabase__list_tables",
      "mcp__supabase__get_schemas",
      "mcp__supabase__list_migrations",
      "mcp__supabase__get_project_url",
      "mcp__supabase__search_docs",
      "mcp__supabase__get_logs",
    );
  }

  const disallowedTools: string[] = [];
  if (ctx.config.mcp_servers.supabase) {
    disallowedTools.push(
      "mcp__supabase__execute_sql",
      "mcp__supabase__apply_migration",
      "mcp__supabase__deploy_edge_function",
      "mcp__supabase__merge_branch",
    );
  }

  // Set up timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let result: AgentResult = {
    sessionId: session.sessionId,
    costUsd: null,
    numTurns: null,
    inputTokens: null,
    outputTokens: null,
    durationApiMs: null,
    resultText: "",
    isError: false,
  };

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: {
        cwd: ctx.repo,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools,
        disallowedTools,
        maxTurns: opts.maxTurns ?? ctx.config.limits.max_turns,
        maxBudgetUsd: opts.maxBudgetUsd ?? ctx.config.limits.max_budget_usd,
        mcpServers,
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [guardHook] }],
          PostToolUse: [
            { matcher: "Bash", hooks: [logCommandsHook] },
            { matcher: "Write|Edit", hooks: [autoFormatHook] },
          ],
          ...(stopHookCallbacks.length > 0
            ? { Stop: [{ hooks: stopHookCallbacks }] }
            : {}),
        },
        ...(session.isResume ? { resume: session.sessionId } : {}),
        settingSources: ["project"],
        abortController: controller,
      },
    })) {
      // Capture session ID from init message
      if (
        (message as any).type === "system" &&
        (message as any).subtype === "init"
      ) {
        const initSessionId = (message as any).session_id;
        if (initSessionId) {
          result.sessionId = initSessionId;
          // Persist for cross-sandbox resume
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          writeFileSync(
            join(ctx.sessionsDir, `${opts.taskKey}.id`),
            initSessionId,
          );
        }
      }

      // Capture final result
      if ("result" in message) {
        const r = message as any;
        const isError = r.is_error ?? false;
        result = {
          sessionId: result.sessionId,
          costUsd: r.total_cost_usd ?? null,
          numTurns: r.num_turns ?? null,
          inputTokens: r.usage?.input_tokens ?? null,
          outputTokens: r.usage?.output_tokens ?? null,
          durationApiMs: r.duration_api_ms ?? null,
          resultText: isError
            ? (r.errors?.join("\n") ?? "Agent error (no details)")
            : (r.result ?? ""),
          isError,
        };
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      log(`Agent timed out after ${opts.timeoutMs / 1000}s`);
      result.isError = true;
      result.resultText = `Timed out after ${opts.timeoutMs / 1000}s`;
    } else {
      log(`Agent error: ${err?.message ?? err}`);
      result.isError = true;
      result.resultText = `Error: ${err?.message ?? err}`;
    }
  } finally {
    clearTimeout(timer);
  }

  return result;
}
