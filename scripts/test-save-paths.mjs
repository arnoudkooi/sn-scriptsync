#!/usr/bin/env node
// Reproduces how each kind of save reaches ScriptSync's save handler: Ctrl+S,
// Save Without Formatting, Save All, extension-triggered saves, disk writes and
// a cross-file rename with files.refactoring.autoSave on (the SNU0000010184
// path). Launches the locally installed VS Code with throwaway user data and
// extensions folders, runs test/exthost/save-paths/runner.js inside it, and
// prints which saves the current rule would push to an instance.
//
// --extension runs the real sn-scriptsync from this repo instead (compiled
// first) and checks which saves it pushes: only Save & Sync, with everything
// else held until Sync Now. Its bridge runs on test ports with its own HOME,
// so it never touches 1977/1978 or ~/.sn-scriptsync. Exits 1 on a mismatch.
//
//   node scripts/test-save-paths.mjs [--extension] [--json] [--keep]
//
// VS Code location: $VSCODE_PATH, else the default macOS install.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(repo, 'test', 'exthost', 'save-paths');
const args = new Set(process.argv.slice(2));
const codeBin = process.env.VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
if (!fs.existsSync(codeBin)) {
	console.error(`VS Code not found at ${codeBin}. Set VSCODE_PATH.`);
	process.exit(2);
}

const extensionMode = args.has('--extension');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-save-paths-'));
// The extension activates on a folder named like its sync path setting.
const workspace = path.join(root, extensionMode ? 'scriptsync' : 'workspace');
const userData = path.join(root, 'user-data');
const extensionsDir = path.join(root, 'extensions');
const out = path.join(root, 'report.json');

function write(file, text) {
	const full = path.join(workspace, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
}

// Two instance folders that share a global name, as Script Includes and
// Business Rules do with `current`. jsconfig puts every file in one project,
// so a rename reaches files that are not open.
write('jsconfig.json', JSON.stringify({ compilerOptions: { checkJs: false }, include: ['**/*.js'] }, null, 2));
for (const inst of ['inst_a', 'inst_b']) {
	write(`${inst}/_settings.json`, JSON.stringify({ name: inst, url: `https://${inst.replace('_', '-')}.service-now.com` }));
}
const shared = n => `var current = current || {};\nfunction helper${n}() {\n\treturn current.sys_id;\n}\n`;
const own = f => `var value_${f} = 1;\n`;
if (extensionMode) {
	// Synced layout: instance/scope/table/name.field.ext, names mapped to
	// sys_ids in the table folder's _map.json.
	let n = 0;
	const table = (inst, tableName, files, body) => {
		const map = {};
		for (const f of files) {
			map[f] = (++n).toString(16).padStart(32, '0');
			write(`${inst}/global/${tableName}/${f}.script.js`, body(f));
		}
		write(`${inst}/global/${tableName}/_map.json`, JSON.stringify(map));
	};
	table('inst_a', 'sys_script_include', ['a1', 'a2'], f => shared(f));
	table('inst_b', 'sys_script_include', ['b1', 'b2'], f => shared(f));
	table('inst_a', 'sys_script', ['s1', 's2', 's3', 's4'], own);
	table('inst_b', 'sys_script', ['t1', 't2'], own);
	write('.vscode/settings.json', JSON.stringify({ 'sn-scriptsync.agentInstructions.autoUpdate': false }, null, 2));
} else {
	['a1', 'a2', 'a3', 'a4'].forEach((f, i) => write(`inst_a/sys_script_include/${f}.js`, shared(`A${i}`)));
	['b1', 'b2', 'b3'].forEach((f, i) => write(`inst_b/sys_script_include/${f}.js`, shared(`B${i}`)));
	['s1', 's2', 's3', 's4'].forEach(f => write(`inst_a/sys_script/${f}.js`, own(f)));
	['t1', 't2'].forEach(f => write(`inst_b/sys_script/${f}.js`, own(f)));
}

fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'files.refactoring.autoSave': true,
	'files.autoSave': 'off',
	'security.workspace.trust.enabled': false,
	'workbench.startupEditor': 'none',
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off'
}, null, 2));

// Do not inherit the host editor's IPC or Node mode.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE'));
env.SNU_PROBE_WORKSPACE = workspace;
env.SNU_PROBE_OUT = out;
const devPaths = [`--extensionDevelopmentPath=${probe}`];
if (extensionMode) {
	execFileSync(process.execPath, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', repo], { stdio: 'inherit' });
	// Test ports and a private HOME: the bridge under test never binds, probes or
	// takes over 1977/1978, and writes its port file and lease under root/home.
	env.SN_SCRIPTSYNC_TEST_PORTS = '21977,21978';
	env.HOME = path.join(root, 'home');
	fs.mkdirSync(env.HOME, { recursive: true });
	env.SNU_PROBE_REPO = repo;
	devPaths.push(`--extensionDevelopmentPath=${repo}`);
}

const child = spawn(codeBin, [
	workspace,
	...devPaths,
	`--extensionTestsPath=${path.join(probe, extensionMode ? 'runner-extension.js' : 'runner.js')}`,
	`--user-data-dir=${userData}`,
	`--extensions-dir=${extensionsDir}`,
	'--disable-workspace-trust',
	'--skip-welcome',
	'--skip-release-notes',
	'--new-window'
], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });
const timer = setTimeout(() => { child.kill(); }, 180_000);

child.on('exit', code => {
	clearTimeout(timer);
	if (!fs.existsSync(out)) {
		console.error(`No report written (exit ${code}).\n${log.slice(-4000)}`);
		process.exit(1);
	}
	const report = JSON.parse(fs.readFileSync(out, 'utf8'));
	if (extensionMode) {
		if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
		else {
			if (report.error) console.log(`ERROR: ${report.error}\n`);
			for (const s of report.scenarios) {
				console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.label}`);
				if (!s.ok) console.log(`      expected ${JSON.stringify(s.expected)}\n      got      ${JSON.stringify(s.got)}${s.error ? `\n      error    ${s.error}` : ''}`);
			}
		}
		if (args.has('--keep')) console.error(`Kept ${root}`);
		else fs.rmSync(root, { recursive: true, force: true });
		process.exit(report.error || !report.scenarios.length || report.scenarios.some(s => !s.ok) ? 1 : 0);
	}
	if (args.has('--json')) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`VS Code ${report.vscodeVersion}, files.refactoring.autoSave=${report.settings.refactoringAutoSave}, files.autoSave=${report.settings.autoSave}\n`);
		for (const s of report.scenarios) {
			console.log(`## ${s.label} [${s.id}]`);
			s.notes.forEach(n => console.log(`   note: ${n}`));
			if (s.error) console.log(`   ERROR: ${s.error}`);
			const will = new Map(s.events.filter(e => e.type === 'willSave').map(e => [e.file, e]));
			const saves = s.events.filter(e => e.type === 'didSave');
			const watched = new Set(s.events.filter(e => e.type === 'watcherChange').map(e => e.file));
			for (const d of saves) {
				const w = will.get(d.file);
				const where = d.active ? 'active' : d.tab ? 'background tab' : 'not open';
				console.log(`   ${d.currentRulePushes ? 'PUSH ' : 'queue'}  ${d.file}  (${where}; reason ${w ? w.reason : 'no will-save'})`);
				watched.delete(d.file);
			}
			for (const f of watched) console.log(`   queue  ${f}  (disk change only, watcher; Sync Delay 0 = no push)`);
			if (!saves.length && !watched.size) console.log('   (no events)');
			console.log('');
		}
	}
	if (args.has('--keep')) console.error(`Kept ${root}`);
	else fs.rmSync(root, { recursive: true, force: true });
	process.exit(report.scenarios.some(s => s.error) ? 1 : 0);
});
