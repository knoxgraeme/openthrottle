#!/usr/bin/env node
// create-openthrottle is an alias for `openthrottle init`.
// Delegates to the openthrottle package so `npx create-openthrottle` works.

import { execFileSync } from 'node:child_process';

try {
  execFileSync('npx', ['openthrottle', 'init'], { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
