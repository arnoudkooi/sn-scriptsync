// "Deploy NOW SDK app" and "Pull instance changes into NOW SDK app".
// Deploy builds and packs a ServiceNow SDK project with the project's own
// `now-sdk`, then the SN Utils helper tab installs the package with the browser
// session (no separate SDK login) after the user confirms there; see
// deployAppPackage in scriptsync.js. Pull has the helper tab download the app
// package, converts it in a temporary copy of the project and lets the user
// pick which differences to copy in (NowSdkPull.ts).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	NOW_CONFIG_FILE, NowSdkProject, NowSdkProjectError, assertSupportedProject, assertSupportedSdk, findNowSdkProjectRoot, readDeployLink,
	readNowSdkProject, writeDeployLink,
} from './NowSdkProject';
import { DEPLOY_TIMEOUT_MS, DeployOutcome, buildDeployMessage, buildNowSdkPackage, summarizeDeployResult } from './NowSdkBuild';
import {
	InstanceChange, PullChange, applyPullChanges, applyPullWithUndo, cleanupPull, gitUncommittedPaths, hasBaseline, hasPulledBefore,
	deployConflicts, instanceChangesFromPackage, markDeployed, markPulled, readPackageRecords, saveBaselineFromPackage, stagePull, undoPull,
} from './NowSdkPull';
import { describeChange } from './NowSdkFlows';

const TRIAL_URL = 'https://snutils.com/trial?utm_source=scriptsync&utm_medium=referral&utm_campaign=sdk_deploy';

/** Fires with the project root after a deploy, a pull or an instance change, so views can refresh. */
const changed = new vscode.EventEmitter<string>();
export const onNowSdkProjectChanged = changed.event;
const DOCS_URL = 'https://snutils.com/docs/guide/scriptsync/now-sdk-deploy';
const FEEDBACK_URL = 'https://snutils.com/contact?utm_source=scriptsync&utm_medium=referral&utm_campaign=beta-feedback&utm_content=sdk-deploy';

export interface NowSdkDeployDeps {
	isRunning(): boolean;
	/** Helper connection, license or instance session changed. */
	onConnectionChanged?: vscode.Event<void>;
	/** Instance folders ScriptSync knows (folders with a valid _settings.json). */
	listInstances(): Array<{ name: string; url: string }>;
	getInstanceSettings(name: string): any;
	helperCapabilities(): Record<string, any> | null;
	/** true/false once the helper reported its license, undefined before that. */
	helperProFeatures(): boolean | undefined;
	sendToHelper(payload: any): void;
	waitForHelper(id: string, timeoutMs: number, instanceName: string): Promise<any>;
}

let output: vscode.OutputChannel | undefined;
function appendOutput(text: string) {
	output ??= vscode.window.createOutputChannel('sn-scriptsync: NOW SDK');
	output.append(text);
}
function log(line: string) {
	appendOutput(line + '\n');
}

async function pickProject(resource?: vscode.Uri): Promise<NowSdkProject | undefined> {
	const start = resource?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
	let root = start ? findNowSdkProjectRoot(start) : null;
	if (!root) {
		const configs = await vscode.workspace.findFiles(`**/${NOW_CONFIG_FILE}`, '**/node_modules/**', 50);
		const roots = configs.map((u) => path.dirname(u.fsPath));
		if (roots.length === 0) {
			vscode.window.showWarningMessage(`No NOW SDK project found (a folder with ${NOW_CONFIG_FILE}).`);
			return undefined;
		}
		if (roots.length === 1) {
			root = roots[0];
		} else {
			const pick = await vscode.window.showQuickPick(
				roots.map((r) => ({ label: path.basename(r), description: vscode.workspace.asRelativePath(r), root: r })),
				{ placeHolder: 'Which NOW SDK project?' },
			);
			if (!pick) return undefined;
			root = pick.root;
		}
	}
	try {
		// Refuse unsupported apps and SDK versions before anything is built or downloaded.
		const project = readNowSdkProject(root);
		assertSupportedProject(project);
		assertSupportedSdk(project.root);
		return project;
	} catch (e: any) {
		vscode.window.showErrorMessage(e instanceof NowSdkProjectError ? e.message : `Could not read the NOW SDK project: ${e?.message || e}`);
		return undefined;
	}
}

async function chooseInstance(project: NowSdkProject, deps: NowSdkDeployDeps, verb: 'deploy' | 'pull' | 'change' = 'deploy'): Promise<{ name: string; url: string } | undefined> {
	const instances = deps.listInstances();
	if (instances.length === 0) {
		vscode.window.showWarningMessage('No ScriptSync instance folder found. Open a record from the instance in VS Code once (or run /token) so ScriptSync knows the instance.');
		return undefined;
	}
	// The linked instance is listed first and preselected, so Enter deploys to
	// it and a different one is always one step away.
	const linkedName = readDeployLink(project.root)?.instance;
	const ordered = [...instances].sort((a, b) => Number(b.name === linkedName) - Number(a.name === linkedName));
	const pick = await vscode.window.showQuickPick(
		ordered.map((i) => ({ label: i.name, description: i.url, detail: i.name === linkedName ? 'Last used for this app' : undefined, instance: i })),
		{ placeHolder: verb === 'deploy' ? `Deploy ${project.name} (${project.scope} ${project.version}) to which instance?`
			: verb === 'pull' ? `Pull changes to ${project.name} (${project.scope}) from which instance?`
			: `Which instance should ${project.name} deploy to and pull from?` },
	);
	if (!pick) return undefined;
	writeDeployLink(project.root, { instance: pick.instance.name, url: pick.instance.url });
	updateStatusBar();
	changed.fire(project.root);
	return pick.instance;
}

/** The address of an instance, for a link to it. */
function instanceUrl(name: string, url?: string): string {
	return (url || `https://${name}.service-now.com`).replace(/\/$/, '');
}

/** A message that is about the browser session (none sent yet, or expired). */
export function isSessionProblem(message: string): boolean {
	return /session (token|expired)|run \/token|log in again/i.test(message);
}

/**
 * Tell the user the session for an instance is missing or expired, with a
 * button that opens the instance: log in there and run /token.
 */
export function showSessionProblem(message: string, instanceName: string, url?: string, error = false): void {
	const show = error ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
	show(`${message} Open ${instanceName}, log in if asked, and run /token.`, 'Open instance').then((choice) => {
		if (choice) vscode.env.openExternal(vscode.Uri.parse(instanceUrl(instanceName, url)));
	});
}

/**
 * The instance an app deploys to and pulls from: the one it was last used
 * with, or a pick the first time. "Change NOW SDK app instance" switches it,
 * and the helper tab and notifications always name it.
 */
async function linkedInstance(project: NowSdkProject, deps: NowSdkDeployDeps, verb: 'deploy' | 'pull'): Promise<{ name: string; url: string } | undefined> {
	const link = readDeployLink(project.root);
	const known = link ? deps.listInstances().find((i) => i.name === link.instance) : undefined;
	return known || chooseInstance(project, deps, verb);
}

export async function changeNowSdkInstance(deps: NowSdkDeployDeps, resource?: vscode.Uri): Promise<void> {
	const project = await pickProject(resource);
	if (!project) return;
	const instance = await chooseInstance(project, deps, 'change');
	if (instance) vscode.window.showInformationMessage(`${project.name} now deploys to and pulls from ${instance.name}.`);
}

export async function deployNowSdkApp(deps: NowSdkDeployDeps, resource?: vscode.Uri): Promise<void> {
	if (!deps.isRunning()) {
		const choice = await vscode.window.showWarningMessage('sn-scriptsync is not running.', 'Enable sn-scriptsync');
		if (choice) vscode.commands.executeCommand('extension.snScriptSyncEnable');
		return;
	}
	const capabilities = deps.helperCapabilities();
	if (!capabilities) {
		vscode.window.showWarningMessage('No SN Utils helper tab is connected. Open the ScriptSync helper tab in the browser and retry.');
		return;
	}
	if (capabilities.sdkDeploy !== 1) {
		vscode.window.showWarningMessage('The connected SN Utils version cannot deploy NOW SDK apps yet. Update SN Utils and reopen the ScriptSync helper tab.');
		return;
	}

	// The helper tab enforces the license; checking here too avoids a build
	// that could never be installed.
	if (deps.helperProFeatures() === false) {
		showProRequired();
		return;
	}

	const project = await pickProject(resource);
	if (!project) return;

	const instance = await linkedInstance(project, deps, 'deploy');
	if (!instance) return;
	const settings = deps.getInstanceSettings(instance.name);
	if (!settings?.url || !settings?.g_ck) {
		showSessionProblem(`No session for ${instance.name} yet.`, instance.name, instance.url);
		return;
	}

	log(`\n=== Deploy ${project.name} (${project.scope} ${project.version}) to ${instance.name} ===`);
	const target = { name: instance.name, url: settings.url, g_ck: settings.g_ck };
	// Changes made on the instance since the last deploy or pull, checked while
	// the app builds. Needs a baseline from an earlier sync with this instance.
	const canCheck = capabilities.sdkPull === 1 && /^[0-9a-f]{32}$/.test(project.scopeId) && hasBaseline(project.root, instance.name);
	let pullFirst = false;
	await whileBusy(project.root, `deploying to ${instance.name}…`, () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploy ${project.name} to ${instance.name}`, cancellable: false }, async (progress) => {
		let sent = false;
		try {
			progress.report({ message: canCheck ? `building, and checking ${instance.name} for changes...` : 'building and packing...' });
			let checkError: any = null;
			const download = canCheck
				? downloadInstancePackage(deps, project, target).catch((e: any) => {
					checkError = e;
					return null;
				})
				: Promise.resolve(null);
			const pkg = await buildNowSdkPackage(project.root, (text) => appendOutput(text));
			const instanceZip = await download;
			if (checkError) {
				const why = checkError?.message || String(checkError);
				log(`Could not check ${instance.name} for changes: ${why}`);
				if (checkError instanceof ProRequiredError) {
					showProRequired();
					return;
				}
				// Without the check a deploy could overwrite work on the instance unseen.
				const session = isSessionProblem(why);
				const choice = await vscode.window.showWarningMessage(
					`Could not check ${instance.name} for changes made since your last deploy or pull (${why}). Deploying without the check can overwrite them.`,
					{ modal: true }, 'Deploy without check', ...(session ? ['Open instance'] : []),
				);
				if (choice === 'Open instance') vscode.env.openExternal(vscode.Uri.parse(instanceUrl(instance.name, settings.url)));
				if (choice !== 'Deploy without check') {
					log('Deploy cancelled.');
					return;
				}
			}
			const conflicts = instanceZip ? deployConflicts(project.root, instance.name, instanceZip, project.appOutputDir) : null;
			if (conflicts?.instanceOnly.length) {
				log(`On ${instance.name} but not in your source (a deploy leaves them): ${conflicts.instanceOnly.map(describeChange).join(', ')}`);
			}
			const changes = conflicts?.overwritten || [];
			if (changes.length > 0) {
				const shown = changes.slice(0, 5).map(describeChange).join(', ');
				const more = changes.length > 5 ? ` and ${changes.length - 5} more` : '';
				log(`A deploy would overwrite these changes on ${instance.name}: ${changes.map(describeChange).join(', ')}`);
				const unpullable = changes.filter((c) => c.generated);
				const note = unpullable.length === changes.length
					? ' A pull cannot bring these in: copy the changes into your source by hand.'
					: unpullable.length ? ` A pull cannot bring in ${unpullable.map((c) => c.label).join(', ')}; copy those by hand.` : '';
				const choice = await vscode.window.showWarningMessage(
					`Deploying overwrites ${changes.length} change${changes.length === 1 ? '' : 's'} made on ${instance.name} since your last deploy or pull: ${shown}${more}.${note}`,
					{ modal: true }, ...(unpullable.length === changes.length ? ['Deploy anyway'] : ['Pull first', 'Deploy anyway']),
				);
				if (choice === 'Pull first') {
					pullFirst = true;
					return;
				}
				if (choice !== 'Deploy anyway') {
					log('Deploy cancelled.');
					return;
				}
			}

			progress.report({ message: `confirm in the ScriptSync helper tab to install on ${instance.name}...` });
			const requestId = `sdkdeploy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const pending = deps.waitForHelper(requestId, DEPLOY_TIMEOUT_MS, instance.name);
			// From here the instance changes: an earlier download no longer describes it.
			forgetDownload(project.root, instance.name);
			deps.sendToHelper(buildDeployMessage(requestId, pkg, target, 'editor'));
			sent = true;
			const outcome = summarizeDeployResult(await pending);
			reportResult(project, instance.name, outcome);
			if (outcome.installed) {
				markDeployed(project.root, instance.name);
				// The view refreshes once the new baseline is in, from that same download.
				refreshBaseline(deps, project, target);
			}
		} catch (e: any) {
			const message = e?.message || String(e);
			log(`Deploy failed: ${message}`);
			if (sent) {
				// The package reached the helper tab, so the install may have run.
				vscode.window.showWarningMessage(`No result for the deploy of ${project.name} (${message}). The install may still have finished: check System Applications on ${instance.name} before deploying again.`);
			} else if (isSessionProblem(message)) {
				showSessionProblem(`Deploy of ${project.name} failed: ${message}`, instance.name, settings.url, true);
			} else {
				vscode.window.showErrorMessage(`Deploy of ${project.name} failed: ${message}`);
			}
		}
	}));
	if (pullFirst) await pullNowSdkApp(deps, vscode.Uri.file(path.join(project.root, NOW_CONFIG_FILE)));
}

class ProRequiredError extends Error {}

// The last download per project and instance. The view reuses a recent one
// instead of asking the instance again right after a deploy or pull did.
const recentDownloads = new Map<string, { zip: Buffer; at: number }>();
const downloadKey = (root: string, instance: string) => `${root}|${instance}`;

function forgetDownload(root: string, instance: string): void {
	recentDownloads.delete(downloadKey(root, instance));
}

/** Download the app package from the instance through the helper tab. */
async function downloadInstancePackage(deps: NowSdkDeployDeps, project: NowSdkProject, target: { name: string; url: string; g_ck: string }): Promise<Buffer> {
	const requestId = `sdkpull_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const pending = deps.waitForHelper(requestId, PULL_TIMEOUT_MS, target.name);
	deps.sendToHelper({
		action: 'downloadAppPackage',
		agentRequestId: requestId,
		appName: 'VS Code',
		initiatedBy: 'editor',
		instance: target,
		app: { name: project.name, scope: project.scope, scopeId: project.scopeId },
	});
	const result = await pending;
	if (!result?.success) {
		if (result?.code === 'E_PRO_REQUIRED') throw new ProRequiredError(result.error);
		throw new Error(result?.error || 'Download failed');
	}
	const zip = Buffer.from(String(result.packageBase64 || ''), 'base64');
	recentDownloads.set(downloadKey(project.root, target.name), { zip, at: Date.now() });
	return zip;
}

/**
 * The app's records on the instance (for the view's change check): from a
 * download made in the last `maxAgeMs`, else downloaded now.
 */
export async function downloadInstanceRecords(deps: NowSdkDeployDeps, project: NowSdkProject, target: { name: string; url: string; g_ck: string }, maxAgeMs = 0): Promise<Map<string, string>> {
	const recent = recentDownloads.get(downloadKey(project.root, target.name));
	if (recent && Date.now() - recent.at <= maxAgeMs) return readPackageRecords(recent.zip);
	return readPackageRecords(await downloadInstancePackage(deps, project, target));
}

async function saveBaselineFrom(project: NowSdkProject, instanceName: string, zip: Buffer): Promise<void> {
	await saveBaselineFromPackage(project.root, instanceName, zip);
}

/** After a deploy, in the background: download and keep the instance baseline. */
function refreshBaseline(deps: NowSdkDeployDeps, project: NowSdkProject, target: { name: string; url: string; g_ck: string }): void {
	if (deps.helperCapabilities()?.sdkPull !== 1 || !/^[0-9a-f]{32}$/.test(project.scopeId)) {
		changed.fire(project.root);
		return;
	}
	downloadInstancePackage(deps, project, target)
		.then((zip) => saveBaselineFrom(project, target.name, zip))
		.then(() => log(`Recorded ${target.name} as the baseline for the next deploy.`))
		.catch((e: any) => log(`Could not record the ${target.name} baseline: ${e?.message || e}`))
		.finally(() => changed.fire(project.root));
}

function reportResult(project: NowSdkProject, instanceName: string, result: DeployOutcome) {
	const seconds = typeof result.durationMs === 'number' ? ` in ${(result.durationMs / 1000).toFixed(1)}s` : '';
	if (result.installed) {
		log(`Installed${seconds}. ${result.statusMessage || ''}`);
		if (result.rollbackUrl) log(`Rollback: ${result.rollbackUrl}`);
		if (result.partial) {
			const flow = result.flowActivation;
			const detail = flow?.error || `${flow?.failed} of ${flow?.total} failed`;
			log(`Flow activation: ${detail}`);
			vscode.window.showWarningMessage(`${project.name} ${project.version} deployed to ${instanceName}${seconds}, but flow activation had problems: ${detail}`);
			return;
		}
		const buttons = result.rollbackUrl ? ['Show rollback', 'Feedback'] : ['Feedback'];
		vscode.window.showInformationMessage(`${project.name} ${project.version} deployed to ${instanceName}${seconds}.`, ...buttons).then((choice) => {
			if (choice === 'Show rollback' && result.rollbackUrl) vscode.env.openExternal(vscode.Uri.parse(result.rollbackUrl));
			if (choice === 'Feedback') vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL));
		});
		return;
	}
	if (result.code === 'E_PRO_REQUIRED') {
		log('Deploying NOW SDK apps is a SN Utils Pro feature.');
		showProRequired();
		return;
	}
	if (result.code === 'E_USER_REJECTED') {
		log('Cancelled in the helper tab.');
		vscode.window.showInformationMessage(`Deploy of ${project.name} cancelled.`);
		return;
	}
	const reason = result.reason ? ` (${result.reason})` : '';
	const message = `${result.error || 'Install failed'}${reason}`;
	log(`Deploy failed: ${message}`);
	if (!result.trackerUrl && isSessionProblem(message)) {
		showSessionProblem(`Deploy of ${project.name} failed: ${message}`, instanceName, undefined, true);
		return;
	}
	const buttons = result.trackerUrl ? ['Open execution tracker'] : [];
	vscode.window.showErrorMessage(`Deploy of ${project.name} failed: ${message}`, ...buttons).then((choice) => {
		if (choice && result.trackerUrl) vscode.env.openExternal(vscode.Uri.parse(result.trackerUrl));
	});
}

function showProRequired(feature = 'Deploying NOW SDK apps with your browser session') {
	vscode.window.showInformationMessage(`${feature} is a SN Utils Pro feature.`, 'Start free trial').then((choice) => {
		if (choice) vscode.env.openExternal(vscode.Uri.parse(TRIAL_URL));
	});
}

// ---- Pull instance changes into the project ---------------------------------

const PULL_TIMEOUT_MS = 3 * 60 * 1000;
// The previous pull's temporary folder stays until the next pull, so diff
// editors opened from the review keep working after the changes are applied.
let lastPullTempDir: string | undefined;

export async function pullNowSdkApp(deps: NowSdkDeployDeps, resource?: vscode.Uri): Promise<void> {
	if (!deps.isRunning()) {
		const choice = await vscode.window.showWarningMessage('sn-scriptsync is not running.', 'Enable sn-scriptsync');
		if (choice) vscode.commands.executeCommand('extension.snScriptSyncEnable');
		return;
	}
	const capabilities = deps.helperCapabilities();
	if (!capabilities) {
		vscode.window.showWarningMessage('No SN Utils helper tab is connected. Open the ScriptSync helper tab in the browser and retry.');
		return;
	}
	if (capabilities.sdkPull !== 1) {
		vscode.window.showWarningMessage('The connected SN Utils version cannot pull NOW SDK apps yet. Update SN Utils and reopen the ScriptSync helper tab.');
		return;
	}
	if (deps.helperProFeatures() === false) {
		showProRequired('Pulling instance changes into NOW SDK apps');
		return;
	}

	const project = await pickProject(resource);
	if (!project) return;
	if (!/^[0-9a-f]{32}$/.test(project.scopeId)) {
		vscode.window.showWarningMessage(`Pull needs the application sys_id as scopeId in now.config.json; ${project.name} has "${project.scopeId}".`);
		return;
	}
	const instance = await linkedInstance(project, deps, 'pull');
	if (!instance) return;
	const settings = deps.getInstanceSettings(instance.name);
	if (!settings?.url || !settings?.g_ck) {
		showSessionProblem(`No session for ${instance.name} yet.`, instance.name, instance.url);
		return;
	}

	if (lastPullTempDir) {
		cleanupPull(lastPullTempDir);
		lastPullTempDir = undefined;
	}

	log(`\n=== Pull ${project.name} (${project.scope}) from ${instance.name} ===`);
	const target = { name: instance.name, url: settings.url, g_ck: settings.g_ck };
	let zip: Buffer | undefined;
	const staged = await whileBusy(project.root, `pulling from ${instance.name}…`, () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pull ${project.name} from ${instance.name}`, cancellable: false }, async (progress) => {
		try {
			progress.report({ message: `downloading from ${instance.name}...` });
			zip = await downloadInstancePackage(deps, project, target);
			progress.report({ message: 'converting with the ServiceNow SDK...' });
			return await stagePull(project.root, zip, (text) => appendOutput(text));
		} catch (e: any) {
			if (e instanceof ProRequiredError) {
				showProRequired('Pulling instance changes into NOW SDK apps');
				return undefined;
			}
			const message = e?.message || String(e);
			log(`Pull failed: ${message}`);
			if (isSessionProblem(message)) showSessionProblem(`Pull of ${project.name} failed: ${message}`, instance.name, settings.url, true);
			else vscode.window.showErrorMessage(`Pull of ${project.name} failed: ${message}`);
			return undefined;
		}
	}));
	// The project now reflects what is on the instance (or the user chose not
	// to take some of it), so this download is the baseline for the next deploy.
	// Changes the SDK's pull cannot bring in stay at their old version in the
	// baseline, so the next deploy keeps warning about them.
	const notPulled = zip ? (await instanceChangesFromPackage(project.root, instance.name, zip).catch(() => [] as InstanceChange[])).filter((c) => c.generated) : [];
	const notPulledNote = notPulled.length
		? ` A pull cannot bring in ${notPulled.map(describeChange).join(', ')}: copy ${notPulled.length === 1 ? 'that change' : 'those changes'} into your source by hand, or the next deploy overwrites ${notPulled.length === 1 ? 'it' : 'them'}.`
		: '';
	const recordBaseline = (): Promise<void> => {
		if (!zip) {
			changed.fire(project.root);
			return Promise.resolve();
		}
		return saveBaselineFromPackage(project.root, instance.name, zip, undefined, notPulled.map((c) => c.file!).filter(Boolean))
			.catch((e: any) => log(`Could not record the ${instance.name} baseline: ${e?.message || e}`))
			.finally(() => changed.fire(project.root));
	};
	if (!staged) return;
	lastPullTempDir = staged.tempDir;

	if (staged.changes.length === 0) {
		log('No differences.');
		recordBaseline();
		if (notPulled.length) vscode.window.showWarningMessage(`${project.name} source matches ${instance.name}, except:${notPulledNote}`);
		else vscode.window.showInformationMessage(`${project.name} is up to date with ${instance.name}.`);
		return;
	}
	log(`${staged.changes.length} file(s) differ: ${staged.changes.map((c) => `${c.status} ${c.path}`).join(', ')}`);

	const removed = staged.changes.filter((c) => c.status === 'removed');
	const toApply = staged.changes.filter((c) => c.status !== 'removed');
	const removedNote = removed.length ? ` ${removed.length} file${removed.length === 1 ? ' is' : 's are'} not on the instance; delete ${removed.length === 1 ? 'it' : 'them'} yourself if that is intended.` : '';

	// Applied straight away when git can show and undo it: the project is in a
	// repository and none of the affected files has uncommitted work.
	const dirty = toApply.length ? await gitUncommittedPaths(project.root, toApply.map((c) => c.path)) : [];
	if (dirty === null || dirty.length > 0) {
		const why = dirty === null ? 'the project is not in a git repository' : `${dirty.length} of these files ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes`;
		log(`Reviewing file by file because ${why}.`);
		const chosen = await reviewPullChanges(project, instance.name, staged.stagingRoot, staged.tempDir, staged.changes, why);
		if (!chosen || chosen.length === 0) {
			log('Nothing applied.');
			return;
		}
		applyPullChanges(project.root, staged.stagingRoot, chosen);
		markPulled(project.root, instance.name);
		log(`Applied: ${chosen.map((c) => c.path).join(', ')}`);
		// Only a complete pull moves the baseline: with files left out, the
		// instance changes in them must keep being reported.
		const skipped = toApply.filter((c) => !chosen.includes(c));
		if (skipped.length === 0) {
			recordBaseline();
			vscode.window.showInformationMessage(`Applied ${chosen.length} change${chosen.length === 1 ? '' : 's'} from ${instance.name} to ${project.name}.${notPulledNote}`);
		} else {
			changed.fire(project.root);
			log(`Left out: ${skipped.map((c) => c.path).join(', ')}. The instance changes stay listed until a complete pull, a deploy or Keep local version.`);
			vscode.window.showInformationMessage(`Applied ${chosen.length} of ${toApply.length} files from ${instance.name} to ${project.name}. The instance changes stay listed in the NOW SDK App view until you pull the rest, deploy or choose Keep local version.`);
		}
		return;
	}

	if (toApply.length === 0) {
		recordBaseline();
		vscode.window.showInformationMessage(`${project.name} has nothing new from ${instance.name}.${removedNote}${notPulledNote}`);
		return;
	}
	const firstPull = !hasPulledBefore(project.root);
	const undo = applyPullWithUndo(project.root, staged.stagingRoot, toApply, instance.name);
	markPulled(project.root, instance.name);
	const baselineSaved = recordBaseline();
	log(`Applied: ${toApply.map((c) => c.path).join(', ')}`);
	const firstNote = firstPull ? ' The first pull also writes out defaults and IDs the ServiceNow SDK keeps in the source.' : '';
	const choice = await vscode.window.showInformationMessage(
		`Pulled ${toApply.length} file${toApply.length === 1 ? '' : 's'} from ${instance.name} into ${project.name}.${firstNote}${removedNote}${notPulledNote}`,
		'Show changes', 'Undo',
	);
	if (choice === 'Show changes') {
		vscode.commands.executeCommand('workbench.view.scm');
	} else if (choice === 'Undo') {
		// The baseline save must finish first, or it would land after the undo.
		await baselineSaved;
		undoPull(project.root, undo);
		changed.fire(project.root);
		log('Pull undone.');
		vscode.window.showInformationMessage(`Pull undone: ${project.name} is back as it was.`);
	}
}

const STATUS_LABEL: Record<PullChange['status'], string> = { modified: 'changed on the instance', added: 'new on the instance', removed: 'not in the instance package' };

function reviewPullChanges(project: NowSdkProject, instanceName: string, stagingRoot: string, tempDir: string, changes: PullChange[], why: string): Promise<PullChange[] | undefined> {
	const empty = path.join(tempDir, 'empty');
	fs.writeFileSync(empty, '');
	const diffButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Show changes' };
	type Item = vscode.QuickPickItem & { change: PullChange };
	const items: Item[] = changes.map((change) => ({
		label: change.path,
		description: STATUS_LABEL[change.status],
		detail: change.path.endsWith('generated/keys.ts') ? 'Record IDs the SDK keeps track of' : undefined,
		picked: change.status !== 'removed',
		buttons: [diffButton],
		change,
	}));

	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<Item>();
		pick.canSelectMany = true;
		pick.items = items;
		pick.selectedItems = items.filter((i) => i.picked);
		pick.title = `Pull from ${instanceName}: ${changes.length} file${changes.length === 1 ? '' : 's'} differ`;
		pick.placeholder = `Review needed because ${why}. Select the changes to copy into your project; Enter applies, Esc cancels.`;
		pick.ignoreFocusOut = true;
		let done = false;
		pick.onDidTriggerItemButton((e) => {
			const change = e.item.change;
			const local = change.status === 'added' ? empty : path.join(project.root, change.path);
			const remote = change.status === 'removed' ? empty : path.join(stagingRoot, change.path);
			vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(local), vscode.Uri.file(remote), `${path.basename(change.path)} (project ↔ ${instanceName})`, { preview: true, preserveFocus: true });
		});
		pick.onDidAccept(() => {
			done = true;
			resolve(pick.selectedItems.map((i) => i.change));
			pick.hide();
		});
		pick.onDidHide(() => {
			if (!done) resolve(undefined);
			pick.dispose();
		});
		pick.show();
	});
}

// ---- Status bar and menu -----------------------------------------------------

let statusItem: vscode.StatusBarItem | undefined;
/** Project root -> what is running for it ("Deploying to dev1"), shown in the status bar. */
const busy = new Map<string, string>();

async function whileBusy<T>(root: string, text: string, work: () => Thenable<T>): Promise<T> {
	busy.set(root, text);
	updateStatusBar();
	try {
		return await work();
	} finally {
		busy.delete(root);
		updateStatusBar();
	}
}

/** The NOW SDK project of the active editor, ignoring the baseline copies in .snu. */
function activeProjectRoot(): string | null {
	const file = vscode.window.activeTextEditor?.document.uri;
	if (!file || file.scheme !== 'file') return null;
	const parts = file.fsPath.split(path.sep);
	if (parts.includes('.snu') || parts.includes('node_modules')) return null;
	return findNowSdkProjectRoot(file.fsPath);
}

function updateStatusBar(): void {
	if (!statusItem) return;
	const root = activeProjectRoot();
	let project: NowSdkProject | null = null;
	try {
		project = root ? readNowSdkProject(root) : null;
	} catch {
		project = null;
	}
	vscode.commands.executeCommand('setContext', 'sn-scriptsync.inNowSdkProject', !!project);
	if (!project) {
		statusItem.hide();
		return;
	}
	const instance = readDeployLink(project.root)?.instance;
	const running = busy.get(project.root);
	statusItem.text = running ? `$(sync~spin) ${project.name} · ${running}` : `$(cloud) ${project.name}${instance ? ` · ${instance}` : ''}`;
	statusItem.tooltip = instance
		? `NOW SDK app ${project.name} (${project.scope} ${project.version}) deploys to and pulls from ${instance}. Click for Deploy, Pull and more.`
		: `NOW SDK app ${project.name} (${project.scope} ${project.version}). Click to deploy or pull; you pick the instance the first time.`;
	statusItem.show();
}

/** Status bar item for NOW SDK projects: app, instance, and a menu of actions. */
export function registerNowSdkStatusBar(): vscode.Disposable[] {
	statusItem = vscode.window.createStatusBarItem('sn-scriptsync.nowSdk', vscode.StatusBarAlignment.Left, 50);
	statusItem.name = 'sn-scriptsync NOW SDK';
	statusItem.command = 'extension.nowSdkMenu';
	updateStatusBar();
	return [
		statusItem,
		vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (path.basename(doc.fileName) === NOW_CONFIG_FILE || path.basename(doc.fileName) === 'package.json') updateStatusBar();
		}),
	];
}

export async function nowSdkMenu(deps: NowSdkDeployDeps): Promise<void> {
	const root = activeProjectRoot();
	const resource = root ? vscode.Uri.file(path.join(root, NOW_CONFIG_FILE)) : undefined;
	const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [
		{ label: '$(cloud-upload) Deploy to instance', description: process.platform === 'darwin' ? '⌃⌘U' : 'Ctrl+Alt+U', run: () => deployNowSdkApp(deps, resource) },
		{ label: '$(cloud-download) Pull instance changes', run: () => pullNowSdkApp(deps, resource) },
		{ label: '$(server-environment) Change instance', run: () => changeNowSdkInstance(deps, resource) },
		{ label: '$(book) Documentation', run: () => vscode.env.openExternal(vscode.Uri.parse(DOCS_URL)) },
		{ label: '$(feedback) Send feedback (beta)', run: () => vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL)) },
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'NOW SDK app' });
	if (pick) await pick.run();
}
