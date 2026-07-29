// =============================================================================
// openthrottle ship <file.md>
//
// Creates a Linear issue from a markdown file (title = first `#` heading,
// body = the rest) via raw GraphQL using LINEAR_API_KEY, then delegates it
// to the OpenThrottle app with IssueUpdateInput.delegateId.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import { extractExecutionPlanBlocks, readExecutionPlanFromMarkdown, validateLocalGraphSelection, validatePlanFileForGraph } from './plan.js';
import { getErrorMessage, readEnv, requireEnv, linearGraphQL } from './util.js';

export const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";

interface ParsedMarkdown {
  title: string;
  body: string;
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const lines = content.split('\n');
  const headingIdx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (headingIdx === -1) {
    throw new Error('No "# Heading" found in the file — the first line must be a level-1 markdown heading.');
  }
  const title = lines[headingIdx]!.replace(/^#\s+/, '').trim();
  const body = lines
    .slice(headingIdx + 1)
    .join('\n')
    .trim();
  return { title, body };
}

export function parseShipArgs(args: string[]): { file?: string; graphId?: string } {
  const parsed: { file?: string; graphId?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--graph") {
      parsed.graphId = args[++index];
      if (!parsed.graphId) throw new Error("--graph requires a graph ID");
    } else if (!parsed.file) {
      parsed.file = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

export function validateGraphSelectionForShip(file: string, graphId?: string): void {
  if (!graphId) return;
  if (graphId === "simple") {
    const graph = validateLocalGraphSelection({ graphId });
    if (graph.consumesUnits) {
      validatePlanFileForGraph(file, { graphId });
      return;
    }
    const content = readFileSync(file, "utf8");
    if (extractExecutionPlanBlocks(content).length === 0) return;
    const result = readExecutionPlanFromMarkdown(content, file);
    if (result.plan.value.graph_id !== graphId) {
      throw new Error(`${file}: execution_plan.graph_id must match selected graph ${graphId}`);
    }
    return;
  }
  validatePlanFileForGraph(file, { graphId });
}

function buildShipSelectionBlock(graphId: string): string {
  return [
    `\`\`\`json ${SHIP_SELECTION_FENCE}`,
    JSON.stringify({ schema: SHIP_SELECTION_FENCE, graph_id: graphId }, null, 2),
    "```",
  ].join("\n");
}

export function buildShipDescription(body: string, graphId?: string): string {
  if (!graphId) return body;
  return `${body.trim()}\n\n${buildShipSelectionBlock(graphId)}`;
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
  const envTeamId = readEnv('LINEAR_TEAM_ID');
  if (envTeamId) return envTeamId;

  const data = await linearGraphQL<TeamsResponse>(
    apiKey,
    `query { teams { nodes { id key name } } }`
  );
  const teams = data.teams.nodes;

  if (teams.length === 0) {
    throw new Error('No Linear teams visible to this API key.');
  }
  if (teams.length === 1) {
    return teams[0]!.id;
  }

  const choice = await p.select({
    message: 'Which Linear team should this issue go to? (set LINEAR_TEAM_ID to skip this prompt)',
    options: teams.map((t) => ({ value: t.id, label: `${t.key} — ${t.name}` })),
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
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

async function createIssue(apiKey: string, teamId: string, title: string, description: string) {
  const data = await linearGraphQL<IssueCreateResponse>(
    apiKey,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    { input: { teamId, title, description } }
  );
  if (!data.issueCreate.success) {
    throw new Error('issueCreate returned success: false');
  }
  return data.issueCreate.issue;
}

export async function delegateIssue(
  apiKey: string,
  issueId: string,
  agentAppId: string
): Promise<void> {
  const data = await linearGraphQL<{ issueUpdate: { success: boolean } }>(
    apiKey,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { delegateId: agentAppId } }
  );
  if (!data.issueUpdate.success) {
    throw new Error('issueUpdate returned success: false');
  }
}

export default async function ship(args: string[] | string | undefined): Promise<void> {
  const parsed = parseShipArgs(Array.isArray(args) ? args : args ? [args] : []);
  const file = parsed.file;
  if (!file) {
    console.error('Usage: openthrottle ship <file.md> [--graph <id>]');
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  p.intro('openthrottle ship');

  const content = readFileSync(file, 'utf8');

  let title: string;
  let body: string;
  try {
    ({ title, body } = parseMarkdown(content));
    validateGraphSelectionForShip(file, parsed.graphId);
    body = buildShipDescription(body, parsed.graphId);
  } catch (err: unknown) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  const apiKey = requireEnv('LINEAR_API_KEY', 'a plain Linear API key with issue-create access');

  p.log.info(`Title: ${title}`);

  const s = p.spinner();
  s.start('Resolving Linear team');
  let teamId: string;
  try {
    teamId = await resolveTeamId(apiKey);
    s.stop('Team resolved.');
  } catch (err: unknown) {
    s.stop('Failed to resolve team.');
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  s.start('Creating Linear issue');
  let issue: { id: string; identifier: string; url: string };
  try {
    issue = await createIssue(apiKey, teamId, title, body);
    s.stop(`Created ${issue.identifier}`);
  } catch (err: unknown) {
    s.stop('Failed to create issue.');
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  const agentAppId = readEnv('OT_AGENT_APP_ID');
  if (agentAppId) {
    s.start('Delegating to the OpenThrottle agent');
    try {
      await delegateIssue(apiKey, issue.id, agentAppId);
      s.stop('Delegated. The supervisor should pick this up shortly.');
    } catch (err: unknown) {
      s.stop('Automatic delegation failed.');
      p.log.warn(
        `Could not delegate ${issue.identifier} automatically (${getErrorMessage(err)}).\n` +
          `  Open the issue and delegate it to the OpenThrottle agent manually:\n` +
          `  ${issue.url}`
      );
    }
  } else {
    p.log.info(
      'OT_AGENT_APP_ID is not set — skipping automatic delegation.\n' +
        `  Delegate it to the OpenThrottle agent in Linear, or @-mention the agent:\n` +
        `  ${issue.url}`
    );
  }

  p.outro(`${issue.identifier}: ${issue.url}`);
}
