// =============================================================================
// openthrottle init
//
// 1. Detect the current project (package manager, base branch, scripts).
// 2. Prompt to confirm/edit, then write .openthrottle.yml (schema: SPEC.md
//    "`.openthrottle.yml` (lives in the TARGET repo)").
// 3. Create/update the Daytona snapshot used to run sandboxes, via the
//    declarative builder (`@daytonaio/sdk` `Image`).
// 4. Print the supervisor secrets checklist as copy-pasteable `fly secrets
//    set` lines.
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { stringify } from 'yaml';
import { getErrorMessage, readEnv } from './util.js';

const cwd = process.cwd();

// ---------------------------------------------------------------------------
// 1. Detect project
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
}

interface Detected {
  pm: 'npm' | 'pnpm' | 'yarn';
  baseBranch: string;
  test: string;
  build: string;
  lint: string;
  dev: string;
}

function detectPackageManager(pkg: PackageJson): 'npm' | 'pnpm' | 'yarn' {
  if (pkg.packageManager?.startsWith('pnpm')) return 'pnpm';
  if (pkg.packageManager?.startsWith('yarn')) return 'yarn';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function detectBaseBranch(): string {
  try {
    const out = execFileSync('git', ['remote', 'show', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = out.match(/HEAD branch:\s*(\S+)/);
    if (match?.[1]) return match[1];
  } catch {
    // Not a git repo, no remote, or offline — fall back to main.
  }
  return 'main';
}

function detectProject(): Detected {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error('No package.json found in the current directory.');
    console.error('openthrottle init must be run from the root of a Node.js project.');
    process.exit(1);
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  } catch {
    console.error('Could not parse package.json — is it valid JSON?');
    process.exit(1);
  }

  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(pkg);
  const run = (script: string): string => (scripts[script] ? `${pm} run ${script}` : '');

  return {
    pm,
    baseBranch: detectBaseBranch(),
    test: run('test'),
    build: run('build'),
    lint: run('lint'),
    dev: scripts.dev ? `${pm} run dev -- --port 3000 --hostname 0.0.0.0` : '',
  };
}

// ---------------------------------------------------------------------------
// 2. Prompt to confirm, write .openthrottle.yml
// ---------------------------------------------------------------------------

interface Config {
  base_branch: string;
  agent: 'claude' | 'codex';
  test: string;
  build: string;
  lint: string;
  dev: string;
  post_bootstrap: string[];
  limits: { max_turns: number; task_timeout: number };
  mcp_servers: Record<string, unknown>;
}

async function promptConfig(detected: Detected): Promise<Config> {
  const result = await p.group(
    {
      base_branch: () => p.text({ message: 'Base branch', initialValue: detected.baseBranch }),
      agent: () =>
        p.select({
          message: 'Default agent',
          options: [
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex CLI' },
          ],
          initialValue: 'claude',
        }),
      test: () => p.text({ message: 'Test command (blank to skip)', initialValue: detected.test }),
      build: () => p.text({ message: 'Build command (blank to skip)', initialValue: detected.build }),
      lint: () => p.text({ message: 'Lint command (blank to skip)', initialValue: detected.lint }),
      dev: () => p.text({ message: 'Dev command (blank to skip)', initialValue: detected.dev }),
      post_bootstrap: () =>
        p.text({ message: 'Post-bootstrap command', initialValue: `${detected.pm} install` }),
      max_turns: () => p.text({ message: 'Max turns per agent run', initialValue: '200' }),
      task_timeout: () => p.text({ message: 'Task timeout (seconds)', initialValue: '7200' }),
    },
    { onCancel: () => { p.cancel('Cancelled.'); process.exit(0); } }
  );

  return {
    base_branch: result.base_branch,
    agent: result.agent as 'claude' | 'codex',
    test: result.test,
    build: result.build,
    lint: result.lint,
    dev: result.dev,
    post_bootstrap: result.post_bootstrap ? [result.post_bootstrap] : [],
    limits: {
      max_turns: Number(result.max_turns) || 200,
      task_timeout: Number(result.task_timeout) || 7200,
    },
    mcp_servers: {},
  };
}

function writeConfig(config: Config): void {
  const doc: Record<string, unknown> = { ...config };
  // Drop empty strings so the generated file only lists commands that exist.
  for (const key of ['test', 'build', 'lint', 'dev'] as const) {
    if (!config[key]) delete doc[key];
  }

  const header = [
    '# .openthrottle.yml — project config for OpenThrottle (Daytona runtime)',
    '# Generated by `openthrottle init`. Committed to the repo so the sandbox',
    '# knows how to build, test, and run this project. See docs/SPEC.md.',
    '',
  ].join('\n');

  writeFileSync(join(cwd, '.openthrottle.yml'), header + stringify(doc));
}

// ---------------------------------------------------------------------------
// 3. Daytona snapshot (declarative builder)
// ---------------------------------------------------------------------------

/**
 * Looks for a `sandbox/Dockerfile` starting at `cwd` and walking up a few
 * parent directories — true when `openthrottle init` is run from within the
 * openthrottle-v2 monorepo itself (dogfooding), where the canonical sandbox
 * image lives. Most end users run this in an unrelated target repo, where no
 * such file exists and we fall back to the declarative Image mirror below.
 */
function findSandboxDockerfile(): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'sandbox', 'Dockerfile');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function buildSnapshot(snapshotName: string): Promise<void> {
  const apiKey = readEnv('DAYTONA_API_KEY');
  if (!apiKey) {
    p.log.warn(
      'DAYTONA_API_KEY is not set — skipping snapshot creation.\n' +
        '  Set it and re-run `openthrottle init`, or create the snapshot manually\n' +
        '  with the Daytona CLI/dashboard using the image described in sandbox/Dockerfile.'
    );
    return;
  }

  // TODO(verify-sdk): confirm `Daytona`/`Image`/`SnapshotService` constructor
  // and option names against the installed @daytonaio/sdk version — the SDK
  // is under active development and field names may drift.
  const { Daytona, Image } = await import('@daytonaio/sdk');
  const daytona = new Daytona({ apiKey });

  const dockerfilePath = findSandboxDockerfile();
  let image: ReturnType<typeof Image.base>;

  if (dockerfilePath) {
    p.log.step(`Found ${dockerfilePath} — building snapshot from it (Image.fromDockerfile).`);
    // TODO(verify-sdk): Image.fromDockerfile(path) — confirm path is resolved
    // relative to cwd and that build context defaults to the Dockerfile's dir.
    image = Image.fromDockerfile(dockerfilePath);
  } else {
    p.log.step(
      'No sandbox/Dockerfile found nearby — building snapshot declaratively ' +
        '(mirrors sandbox/Dockerfile per docs/SPEC.md "Sandbox contract").'
    );
    // Mirrors sandbox/Dockerfile's documented contents: base node:22-bookworm,
    // git/curl/jq/yq/ripgrep/gh CLI, pnpm+yarn via corepack, Claude Code +
    // Codex CLI global installs, non-root `agent` user, gosu.
    // TODO(verify-sdk): confirm runCommands()/env()/dockerfileCommands() are
    // the right calls for apt installs + user creation (vs. needing a real
    // Dockerfile for anything requiring multi-stage/USER directives).
    image = Image.base('node:22-bookworm')
      .runCommands(
        'apt-get update && apt-get install -y --no-install-recommends git curl jq ripgrep gosu ca-certificates',
        'curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq',
        'curl -sS https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg',
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
        'apt-get update && apt-get install -y gh',
        'corepack enable && corepack prepare pnpm@latest --activate && corepack prepare yarn@stable --activate',
        'npm install -g @anthropic-ai/claude-code @openai/codex',
        'useradd --create-home --shell /bin/bash agent || true',
        'rm -rf /var/lib/apt/lists/*'
      )
      .runCommands('mkdir -p /opt/openthrottle')
      .workdir('/home/agent');

    p.log.warn(
      'This declarative image mirrors the documented sandbox contract but does ' +
        'NOT copy /opt/openthrottle/{entrypoint.sh,runner,skills,safety} — those ' +
        'live in the openthrottle-v2 monorepo\'s sandbox/ directory. Re-run this ' +
        'command from within that repo (where sandbox/Dockerfile exists) to build ' +
        'the real, product-complete snapshot. // TODO(verify-sdk)'
    );
  }

  const s = p.spinner();
  s.start(`Creating/updating Daytona snapshot "${snapshotName}"`);
  try {
    // TODO(verify-sdk): SnapshotService.create() re-registers a snapshot by
    // name; confirm whether calling it again with the same name updates in
    // place or errors "already exists" (in which case we may need to delete
    // the old snapshot first). Uncertain without a live Daytona account.
    await daytona.snapshot.create(
      { name: snapshotName, image },
      { onLogs: (chunk: string) => s.message(chunk.trim().slice(-60) || 'building…') }
    );
    s.stop(`Snapshot "${snapshotName}" ready.`);
  } catch (err: unknown) {
    s.stop('Snapshot creation failed.');
    p.log.error(getErrorMessage(err));
    p.log.info(
      `You can retry later with the same DAYTONA_API_KEY, or inspect/build it via the\n` +
        `  Daytona dashboard using the image logic in cli/src/init.ts.`
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Supervisor secrets checklist
// ---------------------------------------------------------------------------

// Mirrors SPEC.md "Supervisor contract" → "Supervisor env (.env.example must
// list all)". Keep in sync with supervisor/.env.example.
const SUPERVISOR_ENV_VARS: Array<{ name: string; hint: string }> = [
  { name: 'PORT', hint: 'e.g. 3000' },
  { name: 'DATABASE_PATH', hint: 'e.g. /data/openthrottle.db' },
  { name: 'LINEAR_WEBHOOK_SECRET', hint: 'from the Linear webhook settings' },
  { name: 'LINEAR_CLIENT_ID', hint: 'Linear OAuth app (actor=app)' },
  { name: 'LINEAR_CLIENT_SECRET', hint: 'Linear OAuth app' },
  { name: 'GITHUB_WEBHOOK_SECRET', hint: 'GitHub repo/org webhook secret' },
  { name: 'GITHUB_TOKEN', hint: 'fine-grained PAT: contents rw, PRs rw' },
  { name: 'GITHUB_REPO', hint: 'owner/name' },
  { name: 'DAYTONA_API_KEY', hint: 'Daytona API key' },
  { name: 'DAYTONA_SNAPSHOT', hint: 'default: openthrottle' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', hint: 'or ANTHROPIC_API_KEY' },
  { name: 'ANTHROPIC_API_KEY', hint: 'or CLAUDE_CODE_OAUTH_TOKEN' },
  { name: 'CODEX_API_KEY', hint: 'or CODEX_AUTH_JSON' },
  { name: 'CODEX_AUTH_JSON', hint: 'raw contents of ~/.codex/auth.json, or CODEX_API_KEY' },
  { name: 'LINEAR_MCP_API_KEY', hint: 'plain Linear API key, used inside the sandbox' },
  { name: 'BASE_BRANCH', hint: 'default: main' },
  { name: 'MAX_TURNS', hint: 'default: 200' },
  { name: 'TASK_TIMEOUT', hint: 'seconds, default: 7200' },
  { name: 'DEV_PORT', hint: 'default: 3000' },
  { name: 'SWEEP_MAX_AGE_DAYS', hint: 'default: 14' },
];

function printSecretsChecklist(): void {
  console.log('\nSupervisor secrets checklist — set these on the Fly app running supervisor/:\n');
  for (const { name, hint } of SUPERVISOR_ENV_VARS) {
    console.log(`  fly secrets set ${name}="<value>"   # ${hint}`);
  }
  console.log(
    '\nRun these from the supervisor/ deploy, or paste multiple at once with `fly secrets import`.\n' +
      'See docs/SPEC.md "Supervisor contract" for the full contract.\n'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function init(): Promise<void> {
  p.intro('openthrottle init');

  const detected = detectProject();
  p.log.info(`Detected package manager: ${detected.pm}`);

  const config = await promptConfig(detected);

  const configPath = join(cwd, '.openthrottle.yml');
  if (existsSync(configPath)) {
    const overwrite = await p.confirm({ message: '.openthrottle.yml already exists. Overwrite?', initialValue: false });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.warn('Skipped writing .openthrottle.yml');
    } else {
      writeConfig(config);
      p.log.success('Wrote .openthrottle.yml');
    }
  } else {
    writeConfig(config);
    p.log.success('Wrote .openthrottle.yml');
  }

  const snapshotName = readEnv('DAYTONA_SNAPSHOT') ?? 'openthrottle';
  await buildSnapshot(snapshotName);

  printSecretsChecklist();

  p.outro('Next: deploy supervisor/, set the secrets above, then `openthrottle ship <plan.md>`.');
}
