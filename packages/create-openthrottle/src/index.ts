#!/usr/bin/env node
// create-openthrottle is an alias for `openthrottle init`.
// Delegates to the openthrottle package so `npx create-openthrottle` works.

import { execFileSync } from 'node:child_process';

try {
  execFileSync('npx', ['openthrottle', 'init'], { stdio: 'inherit' });
} catch (err: unknown) {
  if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
    console.error('error: npx not found. Ensure Node.js is installed and npx is in your PATH.');
  }
  const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : undefined;
  process.exit(status || 1);
}
