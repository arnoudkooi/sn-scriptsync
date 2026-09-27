// Deploy and pull for NOW SDK apps as used by agents and the `snu` CLI, in
// both the VS Code bridge and the standalone `snu serve` bridge. Each host
// passes its own transport to the SN Utils helper tab; the steps and the
// outcomes are the same everywhere. The editor commands (NowSdkDeploy.ts) use
// the same building blocks with interactive prompts instead of flags.
//
// Kept free of `vscode` imports. packages/snu/src/nowsdk/ holds a
// byte-identical copy; src/test/nowSdkShared.test.ts fails when they drift.

import {
	NowSdkProject, NowSdkProjectError, assertSupportedProject, assertSupportedSdk, readNowSdkProject, writeDeployLink,
} from './NowSdkProject';
import { NowSdkPackage, buildNowSdkPackage, summarizeDeployResult, DEPLOY_TIMEOUT_MS } from './NowSdkBuild';
import {
	InstanceChange, applyPullWithUndo, cleanupPull, deployConflicts, gitUncommittedPaths, hasBaseline, hasPulledBefore,
	instanceChangesFromPackage, markDeployed, markPulled, saveBaselineFromPackage, stagePull,
} from './NowSdkPull';

export class NowSdkFlowError extends Error {
	constructor(public code: string, message: string, public details?: any) {
		super(message);
	}
}

export interface NowSdkTransport {
	instanceName: string;
	instanceUrl: string;
	/** The helper tab can download app packages (needed for pull and the change check). */
	canDownload: boolean;
	/** Download the app package; rejects with an error carrying `code` on failure. */
	download(project: NowSdkProject): Promise<Buffer>;
	/** Send the package to the helper tab and resolve with its raw deployAppPackageResponse. */
	deploy(pkg: NowSdkPackage): Promise<any>;
	log?(text: string): void;
}

function loadProject(root: string): NowSdkProject {
	try {
		const project = readNowSdkProject(root);
		assertSupportedProject(project);
		assertSupportedSdk(project.root);
		return project;
	} catch (e: any) {
		throw new NowSdkFlowError('E_INVALID_PARAMS', e?.message || String(e));
	}
}

const hasAppId = (project: NowSdkProject) => /^[0-9a-f]{32}$/.test(project.scopeId);
/** "UI Page Todo Board (html; built from your UI source)" */
export function describeChange(c: InstanceChange): string {
	const parts = [
		c.status === 'removed' ? 'deleted on the instance' : c.status === 'new' ? 'new on the instance' : '',
		c.fields && c.fields.length ? c.fields.join(', ') : '',
		c.reason || '',
	].filter(Boolean);
	return parts.length ? `${c.label} (${parts.join('; ')})` : c.label;
}

const describe = (changes: InstanceChange[]) => {
	const shown = changes.slice(0, 5).map(describeChange).join(', ');
	return changes.length > 5 ? `${shown} and ${changes.length - 5} more` : shown;
};

/**
 * Build, check the instance for changes made since the last deploy or pull,
 * and install. Changes on the instance stop the deploy unless `force` is set.
 */
export async function deployFlow(root: string, transport: NowSdkTransport, opts: { force?: boolean } = {}) {
	const project = loadProject(root);
	const log = (text: string) => transport.log?.(text);
	const app = { name: project.name, scope: project.scope, version: project.version };

	const canCheck = transport.canDownload && hasAppId(project) && hasBaseline(project.root, transport.instanceName);
	// The instance download runs while the app builds; the comparison needs both.
	let checkError: any = null;
	const download = canCheck
		? transport.download(project).catch((e: any) => {
			checkError = e;
			return null;
		})
		: Promise.resolve(null);

	let pkg: NowSdkPackage;
	try {
		pkg = await buildNowSdkPackage(project.root, log);
	} catch (e: any) {
		throw new NowSdkFlowError(e instanceof NowSdkProjectError ? 'E_INVALID_PARAMS' : 'E_COMMAND_FAILED', e?.message || String(e));
	}

	const instanceZip = await download;
	if (checkError) {
		const why = checkError?.message || String(checkError);
		log(`Could not check ${transport.instanceName} for changes: ${why}`);
		// The deploy would be refused for the same reason.
		if (['E_PRO_REQUIRED', 'E_PAUSED'].includes(checkError?.code)) throw new NowSdkFlowError(checkError.code, why, { app });
		// Without the check a deploy could overwrite work on the instance unseen.
		if (!opts.force) {
			throw new NowSdkFlowError(
				'E_CONFIRM_REQUIRED',
				`Could not check ${transport.instanceName} for changes made since the last deploy or pull (${why}). Retry, or deploy with force to install without the check.`,
				{ checkFailed: true, app },
			);
		}
	}
	const conflicts = instanceZip ? deployConflicts(project.root, transport.instanceName, instanceZip, project.appOutputDir) : null;
	const changes = conflicts?.overwritten || [];
	if (changes.length > 0 && !opts.force) {
		const unpullable = changes.filter((c) => c.generated);
		throw new NowSdkFlowError(
			'E_INSTANCE_CHANGED',
			`The deploy would overwrite ${changes.length} change${changes.length === 1 ? '' : 's'} made on ${transport.instanceName} since the last deploy or pull: ${describe(changes)}. ` +
			(unpullable.length === changes.length
				? 'A pull cannot bring these in: copy the changes into the source by hand, or deploy with force to overwrite them.'
				: 'Pull them into the project first (snu sdk pull), or deploy with force to overwrite them.' +
					(unpullable.length ? ` A pull cannot bring in ${unpullable.map((c) => c.label).join(', ')}; copy those by hand.` : '')),
			{ changes, instanceOnly: conflicts?.instanceOnly || [], app },
		);
	}

	let raw: any;
	try {
		raw = await transport.deploy(pkg);
	} catch (e: any) {
		if (e?.code === 'E_TIMEOUT') {
			throw new NowSdkFlowError('E_TIMEOUT', `No deploy result within ${DEPLOY_TIMEOUT_MS / 60000} minutes. The install may still have finished: check the app on the instance before deploying again.`);
		}
		throw e;
	}
	const outcome = summarizeDeployResult(raw);
	if (!outcome.installed) {
		const code = ['E_PRO_REQUIRED', 'E_USER_REJECTED', 'E_PAUSED'].includes(outcome.code || '') ? outcome.code! : 'E_COMMAND_FAILED';
		const reason = outcome.reason ? ` (${outcome.reason})` : '';
		throw new NowSdkFlowError(code, `${outcome.error}${reason}`, { ...outcome, app });
	}

	writeDeployLink(project.root, { instance: transport.instanceName, url: transport.instanceUrl });
	markDeployed(project.root, transport.instanceName);
	let baselineRecorded = false;
	if (transport.canDownload && hasAppId(project)) {
		try {
			await saveBaselineFromPackage(project.root, transport.instanceName, await transport.download(project));
			baselineRecorded = true;
		} catch (e: any) {
			log(`Could not record the ${transport.instanceName} baseline: ${e?.message || e}`);
		}
	}
	return {
		...outcome,
		app,
		instance: transport.instanceName,
		...(changes.length > 0 ? { overwritten: changes } : {}),
		...(conflicts?.instanceOnly.length ? { instanceOnly: conflicts.instanceOnly } : {}),
		baselineRecorded,
		// Whether the deploy was checked against changes on the instance.
		instanceChecked: instanceZip !== null,
	};
}

/**
 * Pull the instance's version of the app into the project. Applied when git
 * can show and undo it (the affected files have no uncommitted edits);
 * otherwise it stops unless `force` is set. `dryRun` only lists the changes.
 */
export async function pullFlow(root: string, transport: NowSdkTransport, opts: { force?: boolean; dryRun?: boolean } = {}) {
	const project = loadProject(root);
	const log = (text: string) => transport.log?.(text);
	const app = { name: project.name, scope: project.scope, version: project.version };
	if (!hasAppId(project)) {
		throw new NowSdkFlowError('E_INVALID_PARAMS', `Pull needs the application sys_id as scopeId in now.config.json; ${project.name} has "${project.scopeId}".`);
	}
	if (!transport.canDownload) {
		throw new NowSdkFlowError('E_UNSUPPORTED_HOST', 'The connected SN Utils helper tab cannot pull NOW SDK apps. Update SN Utils and reopen the ScriptSync helper tab.');
	}

	const zip = await transport.download(project);
	let staged;
	try {
		staged = await stagePull(project.root, zip, log);
	} catch (e: any) {
		throw new NowSdkFlowError(e instanceof NowSdkProjectError ? 'E_INVALID_PARAMS' : 'E_COMMAND_FAILED', e?.message || String(e));
	}
	try {
		const changes = staged.changes.map((c) => ({ path: c.path, status: c.status }));
		const toApply = staged.changes.filter((c) => c.status !== 'removed');
		const notOnInstance = staged.changes.filter((c) => c.status === 'removed').map((c) => c.path);
		const base = { app, instance: transport.instanceName, changes };

		if (opts.dryRun) return { ...base, applied: [], dryRun: true };

		if (toApply.length > 0) {
			const dirty = await gitUncommittedPaths(project.root, toApply.map((c) => c.path));
			if ((dirty === null || dirty.length > 0) && !opts.force) {
				const why = dirty === null
					? 'The project is not in a git repository, so a pull cannot be reviewed or undone there.'
					: `${dirty.length} file${dirty.length === 1 ? '' : 's'} the pull would change ${dirty.length === 1 ? 'has' : 'have'} uncommitted edits: ${dirty.join(', ')}. Commit or stash them first.`;
				throw new NowSdkFlowError('E_CONFIRM_REQUIRED', `${why} Pull with force to apply anyway, or with dryRun to only list the changes.`, { ...base, uncommitted: dirty });
			}
			applyPullWithUndo(project.root, staged.stagingRoot, toApply);
		}

		const firstPull = !hasPulledBefore(project.root);
		markPulled(project.root, transport.instanceName);
		writeDeployLink(project.root, { instance: transport.instanceName, url: transport.instanceUrl });
		// Changes the SDK's pull cannot bring in stay at their old version in
		// the baseline, so the next deploy keeps warning about them.
		const notPulled = (await instanceChangesFromPackage(project.root, transport.instanceName, zip)).filter((c) => c.generated);
		try {
			await saveBaselineFromPackage(project.root, transport.instanceName, zip, log, notPulled.map((c) => c.file!).filter(Boolean));
		} catch (e: any) {
			log(`Could not record the ${transport.instanceName} baseline: ${e?.message || e}`);
		}
		return {
			...base,
			applied: toApply.map((c) => c.path),
			upToDate: staged.changes.length === 0,
			...(notOnInstance.length ? { notOnInstance } : {}),
			...(firstPull && toApply.length ? { firstPull: true } : {}),
			...(notPulled.length ? { notPulled: notPulled.map(({ label, status, reason }) => ({ label, status, reason })) } : {}),
		};
	} finally {
		cleanupPull(staged.tempDir);
	}
}
