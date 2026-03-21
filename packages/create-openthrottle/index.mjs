#!/usr/bin/env node
// =============================================================================
// create-openthrottle — Set up openthrottle in any Node.js project.
//
// Usage: npx create-openthrottle
//
// Detects the project, prompts for config, generates .openthrottle.yml +
// wake-sandbox.yml, creates a Daytona snapshot from GHCR, and prints next steps.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
import { stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// ---------------------------------------------------------------------------
// 1. Detect project
// ---------------------------------------------------------------------------

function detectProject() {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error('No package.json found. create-openthrottle currently supports Node.js projects only.');
    process.exit(1);
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    console.error('Could not parse package.json. Is it valid JSON?');
    process.exit(1);
  }
  const scripts = pkg.scripts || {};
  const rawName = pkg.name?.replace(/^@[^/]+\//, '') || 'project';
  const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  // Detect package manager
  let pm = 'npm';
  if (pkg.packageManager?.startsWith('pnpm')) pm = 'pnpm';
  else if (pkg.packageManager?.startsWith('yarn')) pm = 'yarn';
  else if (existsSync(join(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (existsSync(join(cwd, 'yarn.lock'))) pm = 'yarn';
  else if (existsSync(join(cwd, 'package-lock.json'))) pm = 'npm';

  // Detect base branch
  let baseBranch = 'main';
  try {
    const head = execFileSync('git', ['remote', 'show', 'origin'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = head.match(/HEAD branch:\s*(\S+)/);
    if (match) baseBranch = match[1];
  } catch {
    // Not a git repo or no remote — default to main
  }

  return {
    name,
    pm,
    baseBranch,
    test: scripts.test ? `${pm} test` : '',
    build: scripts.build ? `${pm} build` : '',
    lint: scripts.lint ? `${pm} lint` : '',
    format: scripts.format ? `${pm} run format` : (pkg.devDependencies?.prettier ? 'npx prettier --write .' : ''),
    dev: scripts.dev ? `${pm} dev --port 8080 --hostname 0.0.0.0` : '',
  };
}

// ---------------------------------------------------------------------------
// 2. Prompt for config
// ---------------------------------------------------------------------------

async function promptConfig(detected) {
  console.log(`\n  Detected: package.json (${detected.pm})\n`);

  const response = await prompts([
    { type: 'text', name: 'baseBranch', message: 'Base branch', initial: detected.baseBranch },
    { type: 'text', name: 'test', message: 'Test command', initial: detected.test },
    { type: 'text', name: 'build', message: 'Build command', initial: detected.build },
    { type: 'text', name: 'lint', message: 'Lint command', initial: detected.lint },
    { type: 'text', name: 'format', message: 'Format command', initial: detected.format },
    { type: 'text', name: 'dev', message: 'Dev command', initial: detected.dev },
    { type: 'text', name: 'postBootstrap', message: 'Post-bootstrap command', initial: `${detected.pm} install` },
    {
      type: 'select', name: 'agent', message: 'Agent runtime',
      choices: [
        { title: 'Claude', value: 'claude' },
        { title: 'Codex', value: 'codex' },
        { title: 'Aider', value: 'aider' },
      ],
      initial: 0,
    },
    {
      type: 'select', name: 'notifications', message: 'Notifications',
      choices: [
        { title: 'Telegram', value: 'telegram' },
        { title: 'None', value: 'none' },
      ],
      initial: 0,
    },
    { type: 'confirm', name: 'reviewEnabled', message: 'Enable automated PR review?', initial: true },
    {
      type: (prev) => prev ? 'number' : null,
      name: 'maxRounds', message: 'Max review rounds', initial: 3, min: 1, max: 10,
    },
    { type: 'text', name: 'snapshotName', message: 'Daytona snapshot name', initial: 'openthrottle' },
  ], { onCancel: () => { console.log('\nCancelled.'); process.exit(0); } });

  return { ...detected, ...response };
}

// ---------------------------------------------------------------------------
// 3. Generate .openthrottle.yml
// ---------------------------------------------------------------------------

function generateConfig(config) {
  const doc = {
    base_branch: config.baseBranch,
    test: config.test || undefined,
    dev: config.dev || undefined,
    format: config.format || undefined,
    lint: config.lint || undefined,
    build: config.build || undefined,
    notifications: config.notifications === 'none' ? undefined : config.notifications,
    agent: config.agent,
    snapshot: config.snapshotName || 'openthrottle',
    post_bootstrap: [config.postBootstrap],
    mcp_servers: {},
    review: {
      enabled: config.reviewEnabled,
      max_rounds: config.maxRounds ?? 3,
    },
  };

  // Remove undefined fields
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined) delete doc[key];
  }

  const header = [
    '# openthrottle.yml — project config for Open Throttle (Daytona runtime)',
    '# Generated by npx create-openthrottle. Committed to the repo so the',
    '# sandbox knows how to work with this project.',
    '',
  ].join('\n');

  return header + stringify(doc);
}

// ---------------------------------------------------------------------------
// 4. Copy wake-sandbox.yml
// ---------------------------------------------------------------------------

function copyWorkflow() {
  const src = join(__dirname, 'templates', 'wake-sandbox.yml');
  const destDir = join(cwd, '.github', 'workflows');
  const dest = join(destDir, 'wake-sandbox.yml');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// 5. Create Daytona snapshot from pre-built GHCR image
// ---------------------------------------------------------------------------

function setupDaytona(config) {
  const snapshotName = config.snapshotName || 'openthrottle';
  const image = 'knoxgraeme/openthrottle:v1';

  // Check daytona CLI is available
  try {
    execFileSync('daytona', ['--version'], { stdio: 'pipe' });
  } catch {
    console.log(`\n  daytona CLI not found. Install it, then run:`);
    console.log(`    daytona snapshot create ${snapshotName} --image ${image} --cpu 2 --memory 4 --disk 10\n`);
    return { snapshotName, skipped: true };
  }

  // Create snapshot from pre-built image
  try {
    execFileSync('daytona', [
      'snapshot', 'create', snapshotName,
      '--image', image,
      '--cpu', '2', '--memory', '4', '--disk', '10',
    ], { stdio: 'inherit' });
    console.log(`  ✓ Created Daytona snapshot: ${snapshotName}`);
  } catch (err) {
    if (err.stderr?.toString().includes('already exists')) {
      console.log(`  ✓ Snapshot already exists: ${snapshotName}`);
    } else {
      console.log(`  ✗ Snapshot creation failed. You can create it manually:`);
      console.log(`    daytona snapshot create ${snapshotName} --image ${image} --cpu 2 --memory 4 --disk 10`);
    }
  }

  return { snapshotName };
}

// ---------------------------------------------------------------------------
// 7. Print next steps
// ---------------------------------------------------------------------------

function printNextSteps(config) {
  const agentSecret =
    config.agent === 'claude'
      ? '     ANTHROPIC_API_KEY            ← option a: pay-per-use API key\n     CLAUDE_CODE_OAUTH_TOKEN      ← option b: subscription token (claude setup-token)'
      : config.agent === 'codex'
        ? '     OPENAI_API_KEY               ← required for Codex'
        : '     OPENAI_API_KEY               ← or ANTHROPIC_API_KEY (depends on your Aider model)';
  const secrets = [
    '     DAYTONA_API_KEY              ← required',
    agentSecret,
  ];

  console.log(`
  Next steps:

  1. Set GitHub repo secrets:
${secrets.join('\n')}
     TELEGRAM_BOT_TOKEN            ← optional (notifications)
     TELEGRAM_CHAT_ID              ← optional (notifications)

  2. Commit and push:
     git add .openthrottle.yml .github/workflows/wake-sandbox.yml
     git commit -m "feat: add openthrottle config"
     git push

  3. Ship your first prompt:
     gh issue create --title "My first feature" \\
       --body-file docs/prds/my-feature.md \\
       --label prd-queued
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n  create-openthrottle\n');

  // Step 1: Detect
  const detected = detectProject();

  // Step 2: Prompt
  const config = await promptConfig(detected);

  // Step 3: Generate config
  const configPath = join(cwd, '.openthrottle.yml');
  if (existsSync(configPath)) {
    const { overwrite } = await prompts({
      type: 'confirm', name: 'overwrite',
      message: '.openthrottle.yml already exists. Overwrite?', initial: false,
    }, { onCancel: () => { console.log('\nCancelled.'); process.exit(0); } });
    if (!overwrite) { console.log('  Skipped .openthrottle.yml'); }
    else { writeFileSync(configPath, generateConfig(config)); console.log('  ✓ Generated .openthrottle.yml'); }
  } else {
    writeFileSync(configPath, generateConfig(config));
    console.log('  ✓ Generated .openthrottle.yml');
  }

  // Step 4: Copy workflow
  const workflowPath = join(cwd, '.github', 'workflows', 'wake-sandbox.yml');
  if (existsSync(workflowPath)) {
    const { overwrite } = await prompts({
      type: 'confirm', name: 'overwrite',
      message: 'wake-sandbox.yml already exists. Overwrite?', initial: false,
    }, { onCancel: () => { console.log('\nCancelled.'); process.exit(0); } });
    if (!overwrite) { console.log('  Skipped wake-sandbox.yml'); }
    else { copyWorkflow(); console.log('  ✓ Copied .github/workflows/wake-sandbox.yml'); }
  } else {
    copyWorkflow();
    console.log('  ✓ Copied .github/workflows/wake-sandbox.yml');
  }

  // Step 5: Create Daytona snapshot
  setupDaytona(config);

  // Step 6: Next steps
  printNextSteps(config);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
