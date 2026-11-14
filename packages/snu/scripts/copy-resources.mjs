// Ship the bundled field definitions with the package. pull_scope falls back
// to them for a table whose live dictionary cannot be read; without this copy
// an installed CLI has no fallback at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(pkg, '../../resources/metaDataRelations.json');
const target = path.join(pkg, 'dist', 'resources', 'metaDataRelations.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
if (!parsed || typeof parsed.tableFields !== 'object') throw new Error(`${target} has no tableFields`);
