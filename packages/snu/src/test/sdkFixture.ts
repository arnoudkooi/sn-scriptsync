import * as fs from 'fs';
import * as path from 'path';

const SCOPE_ID = 'f64ef56e39704a9e80aee2ece02d22e1';
const FLOW_ID = 'c'.repeat(32);

/** A NOW SDK project whose now-sdk is a small script producing build output and a zip. */
export function makeProject(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '@servicenow', 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@servicenow', 'sdk', 'package.json'), JSON.stringify({ version: '4.13.0' }));
  fs.writeFileSync(path.join(dir, 'now.config.json'), JSON.stringify({ scope: 'x_1849902_flspk', scopeId: SCOPE_ID, name: 'Spike' }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1' }));
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'now-sdk'), [
    '#!/bin/sh',
    'if [ "$1" = "build" ]; then',
    `  mkdir -p dist/app/update && touch dist/app/update/sys_hub_flow_${FLOW_ID}.xml`,
    `  printf '%s' '<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>Util</name><script>v1</script></sys_script_include></record_update>' > dist/app/update/sys_script_include_${'a'.repeat(32)}.xml`,
    'elif [ "$1" = "pack" ]; then',
    `  mkdir -p target && printf 'PK\\003\\004 /scope/sys_app_${SCOPE_ID}.xml' > target/spike.zip`,
    '  echo "Single artifact emitted as \\"$(pwd)/target/spike.zip\\"."',
    'elif [ "$1" = "transform" ]; then',
    '  mkdir -p src/fluent/generated && cp "$3"/update/* src/fluent/generated/',
    'fi',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

