#!/usr/bin/env node

import('../packages/snu/dist/cli/index.js')
  .then((m) => m.runCli())
  .catch((err) => {
    console.error('[snu] Fatal error:', err?.message || err);
    process.exit(1);
  });
