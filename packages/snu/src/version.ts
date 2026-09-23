import * as fs from 'fs';
import * as path from 'path';

// One source for the package version, usable by the server modules as well
// as the CLI (the CLI entry used to own it, and the bridge could not report
// its own version without importing the whole CLI).
const packageMetadata = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
) as { version: string };

export const VERSION: string = packageMetadata.version;
