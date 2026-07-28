#!/usr/bin/env node
// =============================================================================
// openthrottle CLI entrypoint — a plain argv router, no CLI framework.
//
// Usage: openthrottle <setup|init|plan|validate|ship|status|stop|logs> [args]
// =============================================================================

const USAGE = `openthrottle — plan-first autonomous coding pipeline CLI

Usage:
  openthrottle setup               Check one-time platform prerequisites and
                                    print the Fly supervisor secrets checklist.
  openthrottle init                Register the current GitHub repository and
                                    Linear team, verify readiness, and write
                                    .openthrottle.yml.
  openthrottle plan validate <file.md>
                                    Validate the plan's execution-plan block.
  openthrottle plan prepare <file.md>
                                    Prepare or update the execution-plan block.
  openthrottle validate <file.md>   Alias for plan validate.
  openthrottle ship <file.md>      Create a Linear issue from a markdown
                                    file and delegate it to the agent.
  openthrottle status              Show ticket status from the supervisor.
  openthrottle stop <ticket>       Stop a ticket's active run and workspace.
  openthrottle logs <ticket>       Print sanitized sandbox logs.

  openthrottle --help              Show this message.
  openthrottle --version           Print the CLI version.
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'setup': {
      const { default: setup } = await import('./setup.js');
      await setup();
      break;
    }
    case 'init': {
      const { default: init } = await import('./init.js');
      await init();
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
      await status(rest[0]);
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
