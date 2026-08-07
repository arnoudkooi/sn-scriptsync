// Negative tests for the sn-scriptsync path-traversal containment (Phase 2b).
// Run: node scripts/test-path-safety.mjs
// Mirrors src/pathSafety.ts exactly (kept vscode-free so it runs under plain Node).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sanitizePathComponent(component) {
  if (typeof component !== 'string') throw new Error('not a string');
  const value = component.trim();
  if (!value || value === '.' || value === '..') throw new Error('unsafe: ' + JSON.stringify(component));
  if (/[\\/\0]/.test(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~')) throw new Error('unsafe: ' + JSON.stringify(component));
  return value;
}
function assertPathWithinRoot(targetPath, root) {
  if (!root) throw new Error('no root');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('escapes root: ' + targetPath);
  let current = resolvedRoot;
  for (const component of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in path: ' + targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'snsync-path-safety-'));
const ROOT = path.join(TEST_ROOT, 'root');
const OUTSIDE = path.join(TEST_ROOT, 'outside');
fs.mkdirSync(ROOT);
fs.mkdirSync(OUTSIDE);
let pass = 0, fail = 0;
const rejects = (label, fn) => { try { fn(); console.log(`  FAIL  ${label} (was accepted)`); fail++; } catch { console.log(`  pass  ${label}`); pass++; } };
const accepts = (label, fn) => { try { fn(); console.log(`  pass  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label} -> ${e.message}`); fail++; } };

console.log('Unsafe path components (must reject):');
for (const c of ['..', '.', '', '   ', 'a/b', 'a\\b', '../etc', '..\\win', 'C:\\x', '/abs', '~/home', 'a\0b'])
  rejects(JSON.stringify(c), () => sanitizePathComponent(c));

console.log('\nSafe path components (must accept):');
for (const c of ['acme', 'sys_script_include', 'my-widget', 'field.script', 'x_scope_app'])
  accepts(JSON.stringify(c), () => sanitizePathComponent(c));

console.log('\nWrite targets (containment, must reject):');
rejects('instance ../../../etc/passwd', () => assertPathWithinRoot(path.join(ROOT, '../../../etc/passwd'), ROOT));
rejects('screenshot ../../evil.png', () => assertPathWithinRoot(path.join(ROOT, 'screenshots', '../../evil.png'), ROOT));
rejects('absolute /etc/cron.d/x', () => assertPathWithinRoot('/etc/cron.d/x', ROOT));
rejects('sibling root escape', () => assertPathWithinRoot(path.resolve('/tmp/snsync-root-evil/x'), ROOT));
fs.symlinkSync(OUTSIDE, path.join(ROOT, 'linked'));
rejects('symlink escape', () => assertPathWithinRoot(path.join(ROOT, 'linked', 'evil.png'), ROOT));

console.log('\nWrite targets (legit, must accept):');
accepts('acme/global/sys_script/foo.js', () => assertPathWithinRoot(path.join(ROOT, 'acme', 'global', 'sys_script', 'foo.js'), ROOT));
accepts('screenshots/screenshot_x.png', () => assertPathWithinRoot(path.join(ROOT, 'screenshots', 'screenshot_x.png'), ROOT));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} (${pass} passed, ${fail} failed)`);
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
