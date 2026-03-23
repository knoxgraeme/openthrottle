#!/usr/bin/env node
// =============================================================================
// openthrottle — CLI for Open Throttle.
//
// Usage: npx openthrottle <command>
//
// Commands:
//   ship <file.md> [--base <branch>]   Ship a prompt to a Daytona sandbox
//   status                             Show running, queued, and completed tasks
//   logs                               Show recent GitHub Actions workflow runs
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Constants + helpers
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;
const EXIT_MISSING_DEP = 2;

function die(message, code = EXIT_USER_ERROR) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function gh(args, { quiet = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || '';
    if (stderr.includes('auth login')) {
      die('gh auth expired -- run: gh auth login', EXIT_MISSING_DEP);
    }
    if (quiet) {
      // Exit code 1 with no stderr = no matching results (expected)
      if (err.status === 1 && !stderr) return '';
      // Real failure — warn but don't crash
      console.error(`warning: gh ${args.slice(0, 2).join(' ')} failed: ${stderr || err.message}`);
      return '';
    }
    throw err;
  }
}

function preflight() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    die(
      'gh CLI not found or not authenticated.\n  Install: https://cli.github.com\n  Auth:    gh auth login',
      EXIT_MISSING_DEP,
    );
  }
}

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  die('Could not detect GitHub repo. Run from a git repo with a github.com remote.');
}

function readConfig() {
  const configPath = join(process.cwd(), '.openthrottle.yml');
  if (!existsSync(configPath)) {
    return { baseBranch: 'main', snapshot: 'openthrottle' };
  }
  let content;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch (err) {
    die(`Could not read .openthrottle.yml: ${err.message}`);
  }
  const get = (key) => {
    const match = content.match(new RegExp(`^${key}:\\s*(.+)`, 'm'));
    if (!match) return undefined;
    return match[1].replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '');
  };
  return {
    baseBranch: get('base_branch') || 'main',
    snapshot: get('snapshot') || 'openthrottle',
  };
}

// ---------------------------------------------------------------------------
// 2. Command: ship
// ---------------------------------------------------------------------------

function cmdShip(args) {
  let file = null;
  let baseBranch = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) {
      baseBranch = args[++i];
    } else if (!file) {
      file = args[i];
    }
  }

  if (!file) die('Usage: openthrottle ship <file.md> [--base <branch>]');

  file = resolve(file);
  if (!existsSync(file)) die(`File not found: ${file}`);
  if (!file.endsWith('.md')) die(`Expected a markdown file, got: ${file}`);

  const config = readConfig();
  const base = baseBranch || config.baseBranch;
  const repo = detectRepo();

  // Extract title from first markdown heading
  const content = readFileSync(file, 'utf8');
  const headingMatch = content.match(/^#{1,6}\s+(.+)/m);
  let title = headingMatch ? headingMatch[1].trim() : file.replace(/\.md$/, '');
  if (!title.startsWith('PRD:')) title = `PRD: ${title}`;

  // Ensure labels exist (idempotent)
  const labels = [
    'prd-queued', 'prd-running', 'prd-complete', 'prd-failed',
    'needs-review', 'reviewing',
    'bug-queued', 'bug-running', 'bug-complete', 'bug-failed',
  ];
  for (const label of labels) {
    try {
      gh(['label', 'create', label, '--repo', repo, '--force']);
    } catch (err) {
      const stderr = err.stderr?.toString().trim() || err.message;
      console.error(`warning: failed to create label "${label}": ${stderr}`);
    }
  }

  // Build label list
  let issueLabels = 'prd-queued';
  if (base !== 'main') issueLabels += `,base:${base}`;

  // Create the issue
  let issueUrl;
  try {
    issueUrl = gh([
      'issue', 'create',
      '--repo', repo,
      '--title', title,
      '--body-file', file,
      '--label', issueLabels,
    ]);
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.message;
    die(`Failed to create issue: ${msg}`);
  }

  // Show queue position
  let queueCount = 0;
  try {
    const raw = gh([
      'issue', 'list', '--repo', repo,
      '--label', 'prd-queued', '--state', 'open',
      '--json', 'number', '--jq', 'length',
    ]);
    queueCount = parseInt(raw, 10) || 0;
  } catch {}

  let runningInfo = '';
  try {
    runningInfo = gh([
      'issue', 'list', '--repo', repo,
      '--label', 'prd-running', '--state', 'open',
      '--json', 'number,title',
      '--jq', '.[0] | "#\\(.number) -- \\(.title)"',
    ]);
  } catch {}

  console.log(`Shipped: ${issueUrl}`);
  if (queueCount > 1) {
    console.log(`Queue: ${queueCount} queued`);
  } else {
    console.log('Status: starting');
  }
  if (runningInfo) {
    console.log(`Running: ${runningInfo}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Command: status
// ---------------------------------------------------------------------------

function cmdStatus() {
  const repo = detectRepo();

  console.log('RUNNING');
  const running = gh([
    'issue', 'list', '--repo', repo,
    '--label', 'prd-running', '--state', 'open',
    '--json', 'number,title',
    '--jq', '.[] | "  #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  console.log(running || '  (none)');

  console.log('\nQUEUE');
  const queued = gh([
    'issue', 'list', '--repo', repo,
    '--label', 'prd-queued', '--state', 'open',
    '--json', 'number,title',
    '--jq', '.[] | "  #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  console.log(queued || '  (none)');

  console.log('\nREVIEW');
  const pending = gh([
    'pr', 'list', '--repo', repo,
    '--label', 'needs-review',
    '--json', 'number,title',
    '--jq', '.[] | "  pending: #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  const reviewing = gh([
    'pr', 'list', '--repo', repo,
    '--label', 'reviewing',
    '--json', 'number,title',
    '--jq', '.[] | "  active:  #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  const fixes = gh([
    'pr', 'list', '--repo', repo,
    '--search', 'review:changes_requested',
    '--json', 'number,title',
    '--jq', '.[] | "  fixes:   #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  const reviewOutput = [pending, reviewing, fixes].filter(Boolean).join('\n');
  console.log(reviewOutput || '  (none)');

  console.log('\nCOMPLETED (recent)');
  const completed = gh([
    'issue', 'list', '--repo', repo,
    '--label', 'prd-complete', '--state', 'closed',
    '--limit', '5',
    '--json', 'number,title',
    '--jq', '.[] | "  #\\(.number) -- \\(.title)"',
  ], { quiet: true });
  console.log(completed || '  (none)');
}

// ---------------------------------------------------------------------------
// 4. Command: logs
// ---------------------------------------------------------------------------

function cmdLogs() {
  const repo = detectRepo();

  let output;
  try {
    output = gh([
      'run', 'list',
      '--repo', repo,
      '--workflow', 'Wake Sandbox',
      '--limit', '10',
    ]);
  } catch {
    try {
      output = gh([
        'run', 'list',
        '--repo', repo,
        '--limit', '10',
      ]);
    } catch (err) {
      die(`Failed to list workflow runs: ${err.stderr?.toString().trim() || err.message}`);
    }
  }

  if (!output) {
    console.log('No workflow runs found.');
    return;
  }

  console.log(output);
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

const HELP = `Usage: openthrottle <command>

Commands:
  init                               Set up Open Throttle in your project
  ship <file.md> [--base <branch>]   Create a GitHub issue to trigger a sandbox
  status                             Show running, queued, and completed tasks
  logs                               Show recent GitHub Actions workflow runs

Options:
  --help, -h                         Show this help message
  --version, -v                      Show version`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(EXIT_OK);
  }

  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    process.exit(EXIT_OK);
  }

  if (command === 'init') {
    const { default: init } = await import('./init.mjs');
    await init();
    return;
  }

  preflight();

  switch (command) {
    case 'ship':
      cmdShip(args.slice(1));
      break;
    case 'status':
      cmdStatus();
      break;
    case 'logs':
      cmdLogs();
      break;
    default:
      die(`Unknown command: ${command}\n  Run "openthrottle --help" for usage.`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
