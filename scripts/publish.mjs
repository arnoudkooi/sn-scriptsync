#!/usr/bin/env node
/**
 * Release orchestrator for sn-scriptsync.
 *
 * Targets:
 *   vsix         Build + test everything, then package the extension into a .vsix
 *   marketplace  vsix + publish to the VS Code Marketplace (vsce)
 *   openvsx      vsix + publish to Open VSX (npx ovsx; token via OVSX_PAT)
 *   npm          Build + test, then publish packages/snu (@snutils/snu) to npm
 *                (runs 'npm login' first when 'npm whoami' fails)
 *   all          marketplace + openvsx + npm
 *
 * Usage:
 *   node scripts/publish.mjs                  # show versions + what would publish
 *   node scripts/publish.mjs vsix
 *   node scripts/publish.mjs marketplace
 *   node scripts/publish.mjs npm --dry-run
 *   node scripts/publish.mjs all [--yes] [--skip-tests] [--dry-run]
 *
 * Version bumps are manual and stay yours: bump package.json (extension) and/or
 * packages/snu/package.json first. The script refuses to publish a version that
 * is already live.
 *
 * npm login and a 2FA-protected npm publish open a browser. The script points
 * npm at the 'SN Utils' Chrome profile (SNU_CHROME_PROFILE=<name or directory>
 * picks another one; npm_config_browser=<command> bypasses the lookup).
 */
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNU_DIR = path.join(ROOT, 'packages', 'snu');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const log = (msg) => console.log(msg);
const head = (msg) => log(`\n${C.cyan}${C.bold}== ${msg} ==${C.reset}`);
const ok = (msg) => log(`${C.green}✔${C.reset} ${msg}`);
const warn = (msg) => log(`${C.yellow}⚠${C.reset} ${msg}`);
const fail = (msg) => { log(`${C.red}✕ ${msg}${C.reset}`); process.exit(1); };

// ---------- args ----------
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const targetsArg = rawArgs.filter((a) => !a.startsWith('--'));
const DRY_RUN = flags.has('--dry-run');
const SKIP_TESTS = flags.has('--skip-tests');
const YES = flags.has('--yes');

const known = new Set(['vsix', 'marketplace', 'openvsx', 'npm', 'all']);
for (const t of targetsArg) if (!known.has(t)) fail(`Unknown target '${t}'. Use: vsix | marketplace | openvsx | npm | all`);
const wants = new Set(targetsArg.includes('all') ? ['marketplace', 'openvsx', 'npm'] : targetsArg);
if (wants.has('marketplace') || wants.has('openvsx')) wants.add('vsix');

// ---------- helpers ----------
function run(cmd, opts = {}) {
  log(`${C.gray}$ ${cmd}${opts.cwd ? `   (in ${path.relative(ROOT, opts.cwd) || '.'})` : ''}${C.reset}`);
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: opts.cwd || ROOT, env: opts.env || process.env });
  if (res.status !== 0) fail(`Command failed: ${cmd}`);
}

function capture(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: opts.cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function confirm(question) {
  if (YES) return true;
  if (!process.stdin.isTTY) fail(`Refusing '${question}' without a TTY. Pass --yes to proceed non-interactively.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${C.bold}${question}${C.reset} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// ---------- gather state ----------
const extPkg = readJson(path.join(ROOT, 'package.json'));
const snuPkg = readJson(path.join(SNU_DIR, 'package.json'));
const extId = `${extPkg.publisher}.${extPkg.name}`;

head('Versions');
log(`Extension  ${C.bold}${extId}${C.reset}      local ${C.bold}${extPkg.version}${C.reset}`);
log(`npm        ${C.bold}${snuPkg.name}${C.reset}          local ${C.bold}${snuPkg.version}${C.reset}`);

const publishedNpm = capture(`npm view ${snuPkg.name} version`);
const publishedOpenVsx = await openVsxVersion();
log(`Published: marketplace ${C.bold}${marketplaceVersion() ?? 'unknown (offline?)'}${C.reset} | openvsx ${C.bold}${publishedOpenVsx ?? 'unknown (offline?)'}${C.reset} | npm ${C.bold}${publishedNpm ?? 'unknown (offline?)'}${C.reset}`);

function marketplaceVersion() {
  const out = capture(`vsce show ${extId} --json`);
  if (!out) return null;
  try { return JSON.parse(out).versions?.[0]?.version ?? null; } catch { return null; }
}

async function openVsxVersion() {
  try {
    const res = await fetch(`https://open-vsx.org/api/${extPkg.publisher}/${extPkg.name}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json())?.version ?? null;
  } catch {
    return null;
  }
}

if (wants.size === 0) {
  log(`\nNothing selected. Targets: ${C.bold}vsix | marketplace | openvsx | npm | all${C.reset}  Options: --dry-run --skip-tests --yes`);
  process.exit(0);
}

// ---------- preflight ----------
head('Preflight');

const gitStatus = capture('git status --porcelain');
if (gitStatus === null) {
  warn('Could not read git status.');
} else if (gitStatus.length > 0) {
  warn('Working tree is not clean:');
  log(C.gray + gitStatus.split('\n').slice(0, 15).join('\n') + C.reset);
  if (!(await confirm('Publish with uncommitted changes anyway?'))) fail('Aborted. Commit first, then publish.');
} else {
  ok('Working tree clean');
}

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (wants.has('vsix') || wants.has('marketplace')) {
  const topSection = (changelog.split(/\r?\n/).find((l) => l.startsWith('## ')) || '').trim();
  if (!changelog.includes(`## ${extPkg.version}`)) {
    warn(`CHANGELOG.md has no '## ${extPkg.version}' section. Stamp the Unreleased entries before releasing.`);
    if (!(await confirm('Continue without a changelog entry for this version?'))) fail('Aborted.');
  } else if (!topSection.startsWith(`## ${extPkg.version}`)) {
    // The welcome panel and the marketplace changelog tab lead with the first
    // section; an @snutils/snu entry on top hides this release's notes.
    warn(`CHANGELOG.md starts with '${topSection}', not '## ${extPkg.version}'. Move the ${extPkg.version} section to the top.`);
    if (!(await confirm('Continue with another section on top?'))) fail('Aborted.');
  } else {
    ok(`CHANGELOG.md leads with the ${extPkg.version} section`);
  }
}

if (SKIP_TESTS) {
  warn('Skipping builds and tests (--skip-tests)');
} else {
  head('Build + test');
  run('npm run compile');
  run('node scripts/test-path-safety.mjs');
  run('node scripts/test-settings-coverage.mjs');
  run('npm run build', { cwd: SNU_DIR });
  run('npm test', { cwd: SNU_DIR });
  ok('All builds and tests passed');
}

// ---------- version guards ----------
// A target named explicitly on the command line hard-fails when its version is
// already live. A target implied by 'all' is skipped with a warning instead,
// so bumping only one of extension/npm still releases the other.
const explicitTargets = new Set(targetsArg);
function versionGuard(target, alreadyLive, msg) {
  if (DRY_RUN || !wants.has(target) || !alreadyLive) return;
  if (explicitTargets.has(target)) fail(`${msg} Bump the version first.`);
  warn(`${msg} Skipping '${target}'.`);
  wants.delete(target);
}
versionGuard('marketplace', marketplaceVersion() === extPkg.version, `Marketplace already has ${extId} ${extPkg.version}.`);
versionGuard('openvsx', publishedOpenVsx === extPkg.version, `Open VSX already has ${extId} ${extPkg.version}.`);
versionGuard('npm', publishedNpm === snuPkg.version, `npm already has ${snuPkg.name} ${snuPkg.version}.`);
if (wants.size === 1 && wants.has('vsix') && targetsArg.includes('all')) {
  fail('Nothing to publish: every target is already at its published version.');
}

// ---------- vsix ----------
// NOTE: never pass --no-dependencies here. The extension is NOT bundled (main
// is plain tsc output that requires 'ws' and 'sass' at module load), so the
// runtime node_modules must be inside the VSIX. 4.8.3 shipped without them and
// failed to activate (no status-bar item) — the check below makes that
// impossible to repeat silently.
if (wants.has('vsix')) {
  head('Package VSIX');
  run('vsce package');
  const vsix = path.join(ROOT, `${extPkg.name}-${extPkg.version}.vsix`);
  if (!fs.existsSync(vsix)) fail(`Expected ${path.basename(vsix)} was not produced.`);
  const runtimeDeps = Object.keys(extPkg.dependencies || {});
  if (runtimeDeps.length) {
    const listing = capture(`unzip -l "${vsix}"`) || '';
    const missing = runtimeDeps.filter((dep) => !listing.includes(`extension/node_modules/${dep}/package.json`));
    if (missing.length) {
      fail(`Packaged VSIX is missing runtime dependencies: ${missing.join(', ')}. The extension would fail to activate — do not publish this artifact.`);
    }
    ok(`Runtime dependencies bundled: ${runtimeDeps.join(', ')}`);
  }
  const mb = (fs.statSync(vsix).size / 1024 / 1024).toFixed(1);
  ok(`${path.basename(vsix)} (${mb} MB)`);
}

// ---------- marketplace ----------
if (wants.has('marketplace')) {
  head('VS Code Marketplace');
  if (DRY_RUN) {
    ok('Dry run: skipping vsce publish (the packaged VSIX above is the dry-run artifact).');
  } else {
    if (!process.env.VSCE_PAT) {
      log(`${C.gray}No VSCE_PAT set; vsce will use stored credentials ('vsce login ${extPkg.publisher}') or prompt.${C.reset}`);
    }
    if (!(await confirm(`Publish ${extId} ${extPkg.version} to the VS Code Marketplace?`))) {
      warn('Marketplace publish skipped.');
    } else {
      run('vsce publish');
      ok(`Published ${extId} ${extPkg.version}`);
    }
  }
}

// ---------- open vsx ----------
// The token comes from OVSX_PAT, or on macOS from the Keychain entry
// 'ovsx-pat'. Store it once with:
//   security add-generic-password -s ovsx-pat -a arnoudkooicom -w '<token>'
function resolveOvsxPat() {
  if (process.env.OVSX_PAT) return { token: process.env.OVSX_PAT, source: 'OVSX_PAT env' };
  if (process.platform === 'darwin') {
    const fromKeychain = capture('security find-generic-password -s ovsx-pat -w');
    if (fromKeychain) return { token: fromKeychain, source: "Keychain entry 'ovsx-pat'" };
  }
  return null;
}

if (wants.has('openvsx')) {
  head('Open VSX');
  const pat = DRY_RUN ? null : resolveOvsxPat();
  if (DRY_RUN) {
    ok('Dry run: skipping ovsx publish (the packaged VSIX above is the dry-run artifact).');
  } else if (!pat) {
    warn('No Open VSX token found. Create one at open-vsx.org (profile -> Access Tokens), then either:');
    log(`  ${C.gray}security add-generic-password -s ovsx-pat -a ${extPkg.publisher} -w '<token>'   # once, recommended${C.reset}`);
    log(`  ${C.gray}OVSX_PAT=<token> node scripts/publish.mjs openvsx --skip-tests              # or per run${C.reset}`);
    warn('Open VSX publish skipped.');
  } else if (!(await confirm(`Publish ${extId} ${extPkg.version} to Open VSX? (token: ${pat.source})`))) {
    warn('Open VSX publish skipped.');
  } else {
    // Hand the token to ovsx via the environment, never on the command line.
    log(`${C.gray}$ npx ovsx publish ${extPkg.name}-${extPkg.version}.vsix   (token from ${pat.source})${C.reset}`);
    const res = spawnSync('npx', ['ovsx', 'publish', `${extPkg.name}-${extPkg.version}.vsix`], {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, OVSX_PAT: pat.token },
    });
    if (res.status !== 0) fail('ovsx publish failed.');
    ok(`Published ${extId} ${extPkg.version} to Open VSX`);
  }
}

// ---------- npm ----------
// npm login (web auth) and a 2FA-protected npm publish open a browser. Prefer
// the 'SN Utils' Chrome profile, the one signed in to npm, over whatever macOS
// treats as the default browser and profile. npm's 'browser' config is a shell
// command it appends the URL to; running the Chrome binary with
// --profile-directory also works while Chrome is already open.
const CHROME_PROFILE_PATTERN = /^sn[\s_-]?utils\b/i;

function chromeLocations() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return {
      userData: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    };
  }
  if (process.platform === 'win32') {
    return {
      userData: path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'),
      binary: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    };
  }
  return {
    userData: path.join(home, '.config', 'google-chrome'),
    binary: ['google-chrome', 'google-chrome-stable'].map((b) => capture(`command -v ${b}`)).find(Boolean) || null,
  };
}

function resolveChromeProfile() {
  const { userData, binary } = chromeLocations();
  if (!binary || !fs.existsSync(binary)) return { error: 'Google Chrome not found' };
  let cache;
  try {
    cache = readJson(path.join(userData, 'Local State')).profile?.info_cache || {};
  } catch (err) {
    return { error: `could not read the Chrome profile list (${err.code || err.message})` };
  }
  const wanted = process.env.SNU_CHROME_PROFILE;
  const entries = Object.entries(cache);
  const hit = entries.find(([dir, info]) => (wanted
    ? dir === wanted || (info?.name || '').toLowerCase() === wanted.toLowerCase()
    : CHROME_PROFILE_PATTERN.test(info?.name || '')));
  if (!hit) {
    const names = entries.map(([, info]) => info?.name).filter(Boolean);
    return { error: `no Chrome profile named ${wanted ? `'${wanted}'` : "'SN Utils'"} (profiles: ${names.join(', ') || 'none'})` };
  }
  return { dir: hit[0], name: hit[1].name, binary };
}

function npmBrowserEnv() {
  if (process.env.npm_config_browser) {
    log(`${C.gray}Browser for npm: npm_config_browser is set, using it as-is.${C.reset}`);
    return process.env;
  }
  const profile = resolveChromeProfile();
  if (profile.error) {
    warn(`Browser for npm: ${profile.error}. npm will open the system default browser.`);
    return process.env;
  }
  log(`${C.gray}Browser for npm: Chrome profile '${profile.name}' (${profile.dir})${C.reset}`);
  const quote = (s) => `"${s.replace(/"/g, '\\"')}"`;
  return { ...process.env, npm_config_browser: `${quote(profile.binary)} --profile-directory=${quote(profile.dir)}` };
}

if (wants.has('npm')) {
  head('npm (@snutils/snu)');
  const npmEnv = DRY_RUN ? process.env : npmBrowserEnv();
  let who = capture('npm whoami');
  if (!who && !DRY_RUN) {
    warn("Not logged in to npm ('npm whoami' failed). Starting 'npm login'.");
    // Web login: npm prints the URL, opens it in the browser chosen above and
    // waits for the approval. Needs a TTY, like the confirmations here.
    log(`${C.gray}$ npm login${C.reset}`);
    const res = spawnSync('npm', ['login'], { stdio: 'inherit', cwd: ROOT, env: npmEnv });
    who = res.status === 0 ? capture('npm whoami') : null;
    if (!who) {
      warn("Still not logged in after 'npm login'. Run it by hand, or set an automation token via NPM_TOKEN/.npmrc.");
      if (!(await confirm('Try npm publish anyway?'))) fail('Aborted npm publish.');
    }
  }
  if (who) ok(`npm user: ${who}`);
  if (DRY_RUN) {
    // npm publish --dry-run still rejects an already-published version, so use
    // pack --dry-run: same tarball, no registry check.
    run('npm pack --dry-run', { cwd: SNU_DIR });
    ok('Dry run complete: nothing was published to npm.');
  } else if (!(await confirm(`Publish ${snuPkg.name} ${snuPkg.version} to npm?`))) {
    warn('npm publish skipped.');
  } else {
    // prepublishOnly re-runs build + tests as a final gate.
    run('npm publish', { cwd: SNU_DIR, env: npmEnv });
    ok(`Published ${snuPkg.name} ${snuPkg.version}`);
  }
}

head('Done');
log(`Extension ${extPkg.version} | ${snuPkg.name} ${snuPkg.version}${DRY_RUN ? `  ${C.yellow}(dry run)${C.reset}` : ''}`);
