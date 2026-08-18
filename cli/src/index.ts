#!/usr/bin/env node
// =============================================================================
// openthrottle CLI entrypoint — a plain argv router, no CLI framework.
//
// Usage: openthrottle <setup|init|plan|validate|ship|status|stop|logs|operator-skill|planning-skill> [args]
// =============================================================================

const USAGE = `openthrottle — plan-first autonomous coding pipeline CLI

Usage:
  openthrottle setup [--profile <name>] [--check] [--yes] [--legacy-checklist]
                                    Guided one-time platform onboarding from
                                    the CLI's pinned release manifest: verify
                                    credentials, approve mutations, provision
                                    the runtime snapshot and supervisor, and
                                    persist readiness evidence. --check is a
                                    read-only readiness report; --yes
                                    pre-approves mutations; --legacy-checklist
                                    prints the manual secrets checklist.
  openthrottle init [--profile <name>] [--editable-skills] [--dry-run]
                                    Register the current GitHub repository and
                                    control route, install local authoring/operator
                                    skills, verify readiness, and write
                                    .openthrottle.yml. --profile selects saved
                                    onboarding state; the optional flag also
                                    scaffolds the editable simple pipeline;
                                    --dry-run prints its refresh classifications
                                    without writing or registering anything.
  openthrottle plan validate <file.md>
                                    Validate the plan's execution-plan block.
  openthrottle plan prepare <file.md> [--graph <id>]
                                    Prepare the execution plan using the configured
                                    local engine and canonical planning skill.
  openthrottle validate <file.md>   Alias for plan validate.
  openthrottle ship <file.md>      Create a Linear issue from a markdown
                                    file and delegate it to the agent.
  openthrottle status [<ticket>] [--admission]
                                    Show provider-neutral status, or the exact
                                    accepted automatic plan and review evidence.
  openthrottle stop <ticket>       Stop a ticket's active run and workspace.
  openthrottle logs <ticket>       Print sanitized sandbox logs.
  openthrottle analysis [flags]    Read-only run_outcomes evidence for
                                    improvement proposals: --outcome, --reason,
                                    --attribution, --graph, --skill-digest,
                                    --from, --to, --limit.
  openthrottle operator-skill <install|status|refresh|remove> [--json]
                                    Manage the explicit local OpenThrottle
                                    operator skill through pinned Skillfish.
  openthrottle planning-skill <install|status|refresh|remove> [--json]
                                    Manage the local ot-plan authoring skill
                                    through pinned Skillfish.

  openthrottle --help              Show this message.
  openthrottle --version           Print the CLI version.
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'setup': {
      const { default: setup } = await import('./setup.js');
      await setup(rest);
      break;
    }
    case 'init': {
      const { default: init } = await import('./init.js');
      await init(rest);
      break;
    }
    case 'ship': {
      const { default: ship } = await import('./ship.js');
      await ship(rest);
      break;
    }
    case 'plan': {
      const { plan } = await import('./plan.js');
      await plan(rest);
      break;
    }
    case 'validate': {
      const { validate } = await import('./plan.js');
      await validate(rest);
      break;
    }
    case 'status': {
      const { default: status } = await import('./status.js');
      await status(rest);
      break;
    }
    case 'stop': {
      const { default: stop } = await import('./stop.js');
      await stop(rest[0]);
      break;
    }
    case 'logs': {
      const { default: logs } = await import('./logs.js');
      await logs(rest[0]);
      break;
    }
    case 'analysis': {
      const { default: analysis } = await import('./analysis.js');
      await analysis(rest);
      break;
    }
    case 'operator-skill': {
      const { default: operatorSkill } = await import('./operator-skill.js');
      await operatorSkill(rest);
      break;
    }
    case 'planning-skill': {
      const { planningSkill } = await import('./operator-skill.js');
      await planningSkill(rest);
      break;
    }
    case '--version':
    case '-v': {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
      console.log(pkg.version);
      break;
    }
    case '--help':
    case '-h':
    case undefined: {
      console.log(USAGE);
      break;
    }
    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
