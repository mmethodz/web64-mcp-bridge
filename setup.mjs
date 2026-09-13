#!/usr/bin/env node
// Bootstrap uses Node built-ins only, so it works before npm install.
import { main } from './src/setup.mjs';
main().catch(error => {
  process.stderr.write(`\nSetup stopped: ${error.message}\n`);
  process.exitCode = 1;
});
