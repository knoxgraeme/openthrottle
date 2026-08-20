// openthrottle ship <file.md>
//
// Validates the exact committed definition bundle and its pipeline/plan
// relationship before it performs any Linear mutation.

import { existsSync, readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import {
  validatePlanFileForPipeline,
  type LocalPipelineCompiler,
  type PipelinePlanValidation,
} from "./plan.js";
import { getErrorMessage, linearGraphQL, readEnv, requireEnv } from "./util.js";

interface ParsedMarkdown {
  title: string;
  body: string;
}

export interface ShipCommandOptions {
  directory?: string;
  compiler?: LocalPipelineCompiler;
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (headingIndex === -1) {
    throw new Error('No "# Heading" found in the file — the first line must be a level-1 markdown heading.');
  }
  return {
    title: lines[headingIndex]!.replace(/^#\s+/, "").trim(),
    body: lines.slice(headingIndex + 1).join("\n").trim(),
  };
}

export function parseShipArgs(args: string[]): { file?: string; pipelineId?: string } {
  const parsed: { file?: string; pipelineId?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--pipeline") {
      parsed.pipelineId = args[++index];
      if (!parsed.pipelineId) throw new Error("--pipeline requires a pipeline ID");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    } else if (!parsed.file) {
      parsed.file = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

export function validatePipelineSelectionForShip(
  file: string,
  options: {
    pipelineId?: string;
    directory?: string;
    compiler?: LocalPipelineCompiler;
  } = {},
): PipelinePlanValidation {
  return validatePlanFileForPipeline(file, options);
}

interface Team {
  id: string;
  key: string;
  name: string;
}

interface TeamsResponse {
  teams: { nodes: Team[] };
}

async function resolveTeamId(apiKey: string): Promise<string> {
  const envTeamId = readEnv("LINEAR_TEAM_ID");
  if (envTeamId) return envTeamId;

  const data = await linearGraphQL<TeamsResponse>(
    apiKey,
    "query { teams { nodes { id key name } } }",
  );
  const teams = data.teams.nodes;
  if (teams.length === 0) throw new Error("No Linear teams visible to this API key.");
  if (teams.length === 1) return teams[0]!.id;

  const choice = await p.select({
    message: "Which Linear team should this issue go to? (set LINEAR_TEAM_ID to skip this prompt)",
    options: teams.map((team) => ({ value: team.id, label: `${team.key} — ${team.name}` })),
  });
  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return choice;
}

interface IssueCreateResponse {
  issueCreate: {
    success: boolean;
    issue: { id: string; identifier: string; url: string };
  };
}

async function createIssue(
  apiKey: string,
  teamId: string,
  title: string,
  description: string,
): Promise<{ id: string; identifier: string; url: string }> {
  const data = await linearGraphQL<IssueCreateResponse>(
    apiKey,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    { input: { teamId, title, description } },
  );
  if (!data.issueCreate.success) throw new Error("issueCreate returned success: false");
  return data.issueCreate.issue;
}

export async function delegateIssue(
  apiKey: string,
  issueId: string,
  agentAppId: string,
): Promise<void> {
  const data = await linearGraphQL<{ issueUpdate: { success: boolean } }>(
    apiKey,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { delegateId: agentAppId } },
  );
  if (!data.issueUpdate.success) throw new Error("issueUpdate returned success: false");
}

export default async function ship(
  args: string[] | string | undefined,
  options: ShipCommandOptions = {},
): Promise<void> {
  const parsed = parseShipArgs(Array.isArray(args) ? args : args ? [args] : []);
  const file = parsed.file;
  if (!file) {
    console.error("Usage: openthrottle ship <file.md> [--pipeline <id>]");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  p.intro("openthrottle ship");
  const content = readFileSync(file, "utf8");
  let title: string;
  let body: string;
  try {
    ({ title, body } = parseMarkdown(content));
    validatePipelineSelectionForShip(file, {
      ...(parsed.pipelineId === undefined ? {} : { pipelineId: parsed.pipelineId }),
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      ...(options.compiler === undefined ? {} : { compiler: options.compiler }),
    });
  } catch (error) {
    p.log.error(getErrorMessage(error));
    process.exit(1);
  }

  // Definition and plan validation deliberately precede all credential access,
  // team discovery, issue creation, and delegation.
  const apiKey = requireEnv("LINEAR_API_KEY", "a plain Linear API key with issue-create access");
  p.log.info(`Title: ${title}`);

  const spinner = p.spinner();
  spinner.start("Resolving Linear team");
  let teamId: string;
  try {
    teamId = await resolveTeamId(apiKey);
    spinner.stop("Team resolved.");
  } catch (error) {
    spinner.stop("Failed to resolve team.");
    p.log.error(getErrorMessage(error));
    process.exit(1);
  }

  spinner.start("Creating Linear issue");
  let issue: { id: string; identifier: string; url: string };
  try {
    issue = await createIssue(apiKey, teamId, title, body);
    spinner.stop(`Created ${issue.identifier}`);
  } catch (error) {
    spinner.stop("Failed to create issue.");
    p.log.error(getErrorMessage(error));
    process.exit(1);
  }

  const agentAppId = readEnv("OT_AGENT_APP_ID");
  if (agentAppId) {
    spinner.start("Delegating to the OpenThrottle agent");
    try {
      await delegateIssue(apiKey, issue.id, agentAppId);
      spinner.stop("Delegated. The supervisor should pick this up shortly.");
    } catch (error) {
      spinner.stop("Automatic delegation failed.");
      p.log.warn(
        `Could not delegate ${issue.identifier} automatically (${getErrorMessage(error)}).\n` +
        `  Open the issue and delegate it to the OpenThrottle agent manually:\n` +
        `  ${issue.url}`,
      );
    }
  } else {
    p.log.info(
      "OT_AGENT_APP_ID is not set — skipping automatic delegation.\n" +
      `  Delegate it to the OpenThrottle agent in Linear, or @-mention the agent:\n` +
      `  ${issue.url}`,
    );
  }
  p.outro(`${issue.identifier}: ${issue.url}`);
}
