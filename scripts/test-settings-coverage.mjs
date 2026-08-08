// Guards that the Settings page lists every sn-scriptsync setting.
// Run: node scripts/test-settings-coverage.mjs
//
// The page (WELCOME_SETTINGS in src/extension.ts) is meant to be the single place
// to review configuration, so a setting added to package.json without being added
// there silently becomes invisible. That is how it drifted to 8 of 13 before.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cfg = pkg.contributes.configuration;
const props = Array.isArray(cfg)
  ? Object.assign({}, ...cfg.map((c) => c.properties || {}))
  : cfg.properties || {};

const declared = new Map(
  Object.entries(props).map(([k, v]) => [k.replace(/^sn-scriptsync\./, ''), v])
);

const src = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const start = src.indexOf('const WELCOME_SETTINGS');
const end = src.indexOf('function maybeShowWelcomePanel');
if (start === -1 || end === -1) {
  console.error('FAIL: could not locate WELCOME_SETTINGS in src/extension.ts');
  process.exit(1);
}
const block = src.slice(start, end);

// Parse each object literal in the array independently, so the check does not
// depend on the order the fields happen to be written in.
const objects = block.split(/\n\t\{\n/).slice(1);
const entries = objects
  .map((o) => {
    const key = o.match(/key: '([^']+)'/)?.[1];
    const type = o.match(/type: '(boolean|string|number)'/)?.[1];
    return key ? { key, type } : null;
  })
  .filter(Boolean);
const onPage = new Map(entries.map((e) => [e.key, e.type]));

const untyped = entries.filter((e) => !e.type).map((e) => e.key);
if (untyped.length) {
  console.log('  FAIL  no UI type declared for: ' + untyped.join(', '));
  process.exitCode = 1;
}

let fail = 0;
const missing = [...declared.keys()].filter((k) => !onPage.has(k));
const extra = [...onPage.keys()].filter((k) => !declared.has(k));

console.log(`package.json settings: ${declared.size}`);
console.log(`settings page entries: ${onPage.size}`);

if (missing.length) { console.log('  FAIL  missing from the Settings page: ' + missing.join(', ')); fail++; }
else console.log('  pass  every setting is on the Settings page');

if (extra.length) { console.log('  FAIL  on the page but not declared in package.json: ' + extra.join(', ')); fail++; }
else console.log('  pass  no stale entries on the Settings page');

// The page's input type must match the declared schema type, or the value is
// written back in the wrong shape (e.g. a number field storing "0" as a string).
for (const [key, type] of onPage) {
  const schema = declared.get(key);
  if (!schema) continue;
  const want = schema.type === 'integer' ? 'number' : schema.type;
  if (want !== type) {
    console.log(`  FAIL  ${key}: page renders "${type}" but package.json declares "${schema.type}"`);
    fail++;
  }
}
if (!fail) console.log('  pass  input types match the declared schema');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}`);
process.exit(fail === 0 ? 0 : 1);
