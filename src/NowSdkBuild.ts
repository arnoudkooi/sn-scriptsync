// Build, pack and deploy-message helpers for ServiceNow SDK (NOW SDK) projects,
// shared by the "Deploy NOW SDK app" editor command and the `sdk_deploy` agent
// command. The package itself is installed by the SN Utils helper tab
// (deployAppPackage in scriptsync.js), which asks the user to confirm first.
//
// Kept free of `vscode` imports. packages/snu/src/nowsdk/ holds a byte-identical
// copy for the standalone bridge; src/test/nowSdkShared.test.ts fails when the
// two drift.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
	NowSdkProject, NowSdkProjectError, assertSupportedProject, assertSupportedSdk, findNewestZip, listFlowRecordIds, parsePackOutput, readNowSdkProject,
} from './NowSdkProject';

export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;
/** Covers the confirmation in the helper tab plus the install and flow activation. */
export const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

export interface NowSdkPackage {
	project: NowSdkProject;
	zipPath: string;
	sizeBytes: number;
	packageBase64: string;
	flows: string[];
	actions: string[];
}

export interface DeployInstance {
	name: string;
	url: string;
	g_ck: string;
}

/** What a deploy did, in a shape both the editor and agents can report. */
export interface DeployOutcome {
	success: boolean;
	/** The app package installed, whatever happened after. */
	installed: boolean;
	/** Installed, but some flows or actions did not activate. */
	partial: boolean;
	code?: string;
	error?: string;
	reason?: string;
	statusMessage?: string;
	trackerUrl?: string;
	rollbackUrl?: string;
	flowActivation?: { ok: boolean; total?: number; succeeded?: number; failed?: number; error?: string } | null;
	durationMs?: number;
}

function localCli(root: string): string {
	const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'now-sdk.cmd' : 'now-sdk');
	if (!fs.existsSync(bin)) {
		throw new NowSdkProjectError(`The ServiceNow SDK is not installed in ${path.basename(root)}. Run npm install in the project first.`);
	}
	return bin;
}

/**
 * Quote a command or argument for the Windows shell (cmd.exe), which has to
 * run the .cmd shim. Inside double quotes, spaces, `&`, `|`, `<`, `>` and `^`
 * are literal, so a path like C:\Users\Jane Doe\AppData\Local\Temp stays one
 * argument. `"` cannot be escaped there and `%` still expands variables, so
 * both are refused instead.
 */
export function quoteForWindowsShell(value: string): string {
	if (/["%\r\n]/.test(value)) {
		throw new NowSdkProjectError(`Cannot run the ServiceNow SDK with "${value}": the path contains a character the Windows shell cannot pass safely (" or %). Move the project or temp folder to a path without it.`);
	}
	return `"${value}"`;
}

/** Run the project's own `now-sdk` with fixed arguments; resolves with its output. */
export function runNowSdk(root: string, args: string[], onOutput?: (text: string) => void): Promise<string> {
	const bin = localCli(root);
	return new Promise((resolve, reject) => {
		onOutput?.(`> now-sdk ${args.join(' ')}\n`);
		const isWin = process.platform === 'win32';
		// .cmd shims can only be spawned through a shell on Windows. The shell
		// joins the arguments with spaces, so each one is quoted: a temp folder
		// under a user name with a space must stay a single argument.
		let child: cp.ChildProcess;
		try {
			child = isWin
				? cp.spawn(quoteForWindowsShell(bin), args.map(quoteForWindowsShell), { cwd: root, shell: true, env: process.env })
				: cp.spawn(bin, args, { cwd: root, env: process.env });
		} catch (e) {
			reject(e);
			return;
		}
		let out = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`now-sdk ${args[0]} timed out after ${CLI_TIMEOUT_MS / 1000}s`));
		}, CLI_TIMEOUT_MS);
		const collect = (chunk: Buffer) => {
			const text = chunk.toString();
			out += text;
			onOutput?.(text);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		child.on('error', (e) => { clearTimeout(timer); reject(e); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`now-sdk ${args[0]} failed (exit ${code}).${tail(out)}`));
		});
	});
}

function tail(output: string): string {
	const lines = output.trim().split(/\r?\n/).filter(Boolean).slice(-5);
	return lines.length ? `\n${lines.join('\n')}` : '';
}

/** Build and pack the project and read the package for the helper tab. */
export async function buildNowSdkPackage(root: string, onOutput?: (text: string) => void): Promise<NowSdkPackage> {
	const project = readNowSdkProject(root);
	assertSupportedProject(project);
	assertSupportedSdk(project.root);
	await runNowSdk(project.root, ['build'], onOutput);
	const packOut = await runNowSdk(project.root, ['pack'], onOutput);

	const reported = parsePackOutput(packOut);
	const zipPath = reported && fs.existsSync(reported) ? reported : findNewestZip(project.packOutputDir);
	if (!zipPath) throw new NowSdkProjectError(`No package found in ${project.packOutputDir} after now-sdk pack.`);
	const zip = fs.readFileSync(zipPath);
	if (zip.length > MAX_PACKAGE_BYTES) {
		throw new NowSdkProjectError(`Package is ${Math.round(zip.length / 1024 / 1024)} MB; the limit is ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.`);
	}
	const { flows, actions } = listFlowRecordIds(project.appOutputDir);
	return { project, zipPath, sizeBytes: zip.length, packageBase64: zip.toString('base64'), flows, actions };
}

/**
 * The `deployAppPackage` message for the helper tab. `initiatedBy` tells the
 * tab whether a person started the deploy in the editor or an agent did; only
 * editor deploys go through while agents are paused.
 */
export function buildDeployMessage(requestId: string, pkg: NowSdkPackage, instance: DeployInstance, initiatedBy: 'editor' | 'agent'): any {
	return {
		action: 'deployAppPackage',
		agentRequestId: requestId,
		appName: initiatedBy === 'editor' ? 'VS Code' : 'Agent',
		initiatedBy,
		instance: { name: instance.name, url: instance.url, g_ck: instance.g_ck },
		app: { name: pkg.project.name, scope: pkg.project.scope, scopeId: pkg.project.scopeId, version: pkg.project.version },
		fileName: path.basename(pkg.zipPath),
		packageBase64: pkg.packageBase64,
		flows: pkg.flows,
		actions: pkg.actions,
	};
}

/** Normalize the helper tab's `deployAppPackageResponse`. */
export function summarizeDeployResult(result: any): DeployOutcome {
	const flowActivation = result?.flowActivation ?? null;
	const installed = result?.success === true;
	const partial = installed && !!flowActivation && flowActivation.ok === false;
	const outcome: DeployOutcome = { success: installed && !partial, installed, partial, flowActivation };
	for (const key of ['code', 'error', 'reason', 'statusMessage', 'trackerUrl', 'rollbackUrl'] as const) {
		if (typeof result?.[key] === 'string' && result[key]) outcome[key] = result[key];
	}
	if (typeof result?.durationMs === 'number') outcome.durationMs = result.durationMs;
	if (!installed && !outcome.error) outcome.error = 'Install failed';
	return outcome;
}
