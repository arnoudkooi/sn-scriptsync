import * as fs from 'fs';
import * as path from 'path';

/**
 * The bridge writes pulled instance scripts into the folder it was started
 * in. Started inside a code repository that is not a ScriptSync workspace,
 * those files end up in that repository's next commit. Returns the advice to
 * print, or undefined when the folder is fine: no repository above it, or it
 * already holds instance folders (a workspace kept in git on purpose).
 */
export function repositoryWriteWarning(cwd: string): string | undefined {
  try {
    let dir = path.resolve(cwd);
    let repoRoot: string | undefined;
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) { repoRoot = dir; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!repoRoot) return undefined;
    const hasInstanceFolder = fs.readdirSync(cwd, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && !entry.name.startsWith('.') &&
      (fs.existsSync(path.join(cwd, entry.name, '_settings.json')) || fs.existsSync(path.join(cwd, entry.name, 'settings.json'))));
    if (hasInstanceFolder) return undefined;
    return `This folder is inside a git repository (${repoRoot}). Pulled instance scripts are written here, ` +
      'so they can end up in your next commit. Start the bridge from a separate folder, or add the instance folders to .gitignore.';
  } catch {
    return undefined;
  }
}
