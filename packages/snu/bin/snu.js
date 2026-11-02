#!/usr/bin/env node

import('../dist/cli/index.js')
  .then((m) => m.runCli())
  .catch((err) => {
    console.error('[snu] Fatal error:', err?.message || err);
    // Allow stderr and any pending handles to drain before Node shuts down.
    process.exitCode = 1;
  });
