import * as fs from 'fs';
import * as path from 'path';

const SCOPE_ID = 'f64ef56e39704a9e80aee2ece02d22e1';
const FLOW_ID = 'c'.repeat(32);

/** A NOW SDK project whose now-sdk is a small script producing build output and a zip. */
export function makeProject(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'node_modules', '@servicenow', 'sdk', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '@servicenow', 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@servicenow', 'sdk', 'package.json'), JSON.stringify({ version: '4.13.0' }));
  fs.writeFileSync(path.join(dir, 'now.config.json'), JSON.stringify({ scope: 'x_1849902_flspk', scopeId: SCOPE_ID, name: 'Spike' }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1' }));
  fs.writeFileSync(path.join(dir, 'node_modules', '@servicenow', 'sdk', 'bin', 'index.js'), [
    'const fs = require("fs"), path = require("path");',
    'if (process.argv[2] === "build") {',
    '  fs.mkdirSync("dist/app/update", { recursive: true });',
    `  fs.writeFileSync("dist/app/update/sys_hub_flow_${FLOW_ID}.xml", "");`,
    `  fs.writeFileSync("dist/app/update/sys_script_include_${'a'.repeat(32)}.xml", '<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><name>Util</name><script>v1</script></sys_script_include></record_update>');`,
    '} else if (process.argv[2] === "pack") {',
    '  fs.mkdirSync("target", { recursive: true });',
    `  fs.writeFileSync("target/spike.zip", "PK\\x03\\x04 /scope/sys_app_${SCOPE_ID}.xml");`,
    '  console.log(`Single artifact emitted as "${path.resolve("target/spike.zip")}".`);',
    '} else if (process.argv[2] === "transform") {',
    '  fs.cpSync(path.join(process.argv[4], "update"), "src/fluent/generated", { recursive: true });',
    '}',
  ].join('\n'));
  return dir;
}

