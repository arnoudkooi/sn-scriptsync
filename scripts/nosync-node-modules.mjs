#!/usr/bin/env node
/**
 * Keep node_modules out of iCloud Drive sync.
 *
 * iCloud evicts large binaries (esbuild, typescript) from synced folders, and
 * the next build then stalls for minutes while they re-download — that is the
 * "stuck at build:agent-docs" failure mode. iCloud skips any folder whose name
 * ends in `.nosync`, so the real tree lives in node_modules.nosync with a
 * `node_modules` symlink pointing at it.
 *
 * npm install replaces a symlinked node_modules with a real directory, undoing
 * that setup — so this script runs as `postinstall` and converts it back:
 * fresh install becomes the new node_modules.nosync, symlink restored.
 *
 * No-op outside iCloud-synced paths, so clones on other machines/CI are untouched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const cwd = process.cwd();
if (!cwd.includes('Mobile Documents')) process.exit(0); // not iCloud-synced

const nm = path.join(cwd, 'node_modules');
const nosync = path.join(cwd, 'node_modules.nosync');

let stat;
try { stat = fs.lstatSync(nm); } catch { process.exit(0); } // nothing installed

if (stat.isSymbolicLink()) process.exit(0); // already migrated

// A real node_modules fresh from npm install is the canonical tree: it becomes
// the new .nosync target, replacing any stale one.
fs.rmSync(nosync, { recursive: true, force: true });
fs.renameSync(nm, nosync);
fs.symlinkSync('node_modules.nosync', nm);
console.log('[nosync] node_modules moved to node_modules.nosync (excluded from iCloud sync) and symlinked back.');
