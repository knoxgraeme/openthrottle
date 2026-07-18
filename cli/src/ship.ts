// =============================================================================
// openthrottle ship <file.md>
//
// Creates a Linear issue from a markdown file (title = first `#` heading,
// body = the rest) via raw GraphQL using LINEAR_API_KEY, then attempts to
// delegate it to the OpenThrottle agent app so the supervisor picks it up.
//
// SPEC-DEVIATION: the Linear Agent API (Developer Preview) does not document
// a dedicated "delegate this issue to an app" mutation as of this writing.
// The delegate step here assumes delegation == assigning the issue to the
// agent app's actor user (`issueUpdate(input: { assigneeId })`), which is
// the mechanism described informally for triggering an AgentSessionEvent.
// This is UNVERIFIED — see TODO(verify-linear-api) below. If it's wrong,
// `ship` still creates the issue and prints manual delegate instructions.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import { getErrorMessage, readEnv, requireEnv, linearGraphQL } from './util.js';

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

// TODO(verify-linear-api): confirm the delegate mechanism. Candidates seen in
// Linear's (Developer Preview) Agent API docs/community examples:
//   1. issueUpdate(input: { assigneeId: <app actor id> }) — assign to the app.
//   2. A dedicated agentSessionCreate/delegate mutation that isn't stable yet.
// This implementation tries (1) and treats any GraphQL error as "delegation
// isn't wired up" rather than a hard failure — `ship` always succeeds at
// creating the issue even if delegation fails.
async function attemptDelegate(apiKey: string, issueId: string, agentAppId: string): Promise<boolean> {
  await linearGraphQL(
    apiKey,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { assigneeId: agentAppId } }
  );
  return true;
}

export default async function ship(file: string | undefined): Promise<void> {
  if (!file) {
    console.error('Usage: openthrottle ship <file.md>');
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  p.intro('openthrottle ship');

  const apiKey = requireEnv('LINEAR_API_KEY', 'a plain Linear API key with issue-create access');
  const content = readFileSync(file, 'utf8');

  let title: string;
  let body: string;
  try {
    ({ title, body } = parseMarkdown(content));
  } catch (err: unknown) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

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
      await attemptDelegate(apiKey, issue.id, agentAppId);
      s.stop('Delegated. The supervisor should pick this up shortly.');
    } catch (err: unknown) {
      s.stop('Automatic delegation failed.');
      p.log.warn(
        `SPEC-DEVIATION: could not delegate ${issue.identifier} automatically (${getErrorMessage(err)}).\n` +
          `  Open the issue and delegate it to the OpenThrottle agent manually:\n` +
          `  ${issue.url}`
      );
    }
  } else {
    p.log.info(
      'OT_AGENT_APP_ID is not set — skipping automatic delegation.\n' +
        `  Delegate it in Linear (assign the issue to the OpenThrottle agent, or @-mention it):\n` +
        `  ${issue.url}`
    );
  }

  p.outro(`${issue.identifier}: ${issue.url}`);
}
