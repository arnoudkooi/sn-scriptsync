import * as path from 'path';
import { AgentContext, CommandHandler } from '../types';
import { AgentError } from '../errors';
import { mustGetInstanceSettings } from './_shared';
import { resolveNowSdkProjectRoot } from '../../NowSdkProject';
import { DEPLOY_TIMEOUT_MS, buildDeployMessage } from '../../NowSdkBuild';
import { NowSdkFlowError, NowSdkTransport, deployFlow, pullFlow } from '../../NowSdkFlows';

// NOW SDK (Fluent) deploy and pull for agents and the `snu` CLI through the
// VS Code bridge. The steps live in NowSdkFlows.ts and are shared with the
// standalone bridge; this file only supplies the transport to the helper tab.
// A deploy is always confirmed by the user in the helper tab's modal.

const PULL_TIMEOUT_MS = 3 * 60 * 1000;

function projectRoot(ctx: AgentContext, params: any): string {
	try {
		return resolveNowSdkProjectRoot(ctx.workspaceRoot, typeof params?.projectPath === 'string' ? params.projectPath : undefined);
	} catch (e: any) {
		throw new AgentError('E_INVALID_PARAMS', e?.message || String(e));
	}
}

function transport(ctx: AgentContext, command: string): NowSdkTransport {
	const helper = ctx.getHelperBuildInfo();
	if (helper?.capabilities?.sdkDeploy !== 1) {
		throw new AgentError('E_UNSUPPORTED_HOST', 'The connected SN Utils helper tab cannot deploy or pull NOW SDK apps. Update SN Utils and reopen the ScriptSync helper tab.');
	}
	if (helper.licenseResolved && helper.proFeatures === false) {
		throw new AgentError('E_PRO_REQUIRED', 'Deploying and pulling NOW SDK apps is a SN Utils Pro feature. Start a free trial at https://snutils.com/trial');
	}
	const settings = mustGetInstanceSettings(ctx.instanceFolder);
	const name = path.basename(ctx.instanceFolder);
	if (!settings.g_ck) {
		throw new AgentError('E_TOKEN_EXPIRED', `No session token for ${name}. Run /token on the instance and retry.`);
	}
	const instance = { name, url: settings.url, g_ck: settings.g_ck };
	let seq = 0;
	const correlation = (kind: string) => `agent_${ctx.request.id}_${kind}_${Date.now()}_${++seq}`;
	return {
		instanceName: name,
		instanceUrl: settings.url,
		canDownload: helper.capabilities?.sdkPull === 1,
		async download(project) {
			const id = correlation('sdkpull');
			const pending = ctx.waitForBrowserResponse<any>(id, PULL_TIMEOUT_MS);
			ctx.sendToBrowser({
				action: 'downloadAppPackage',
				agentRequestId: id,
				appName: 'Agent',
				initiatedBy: 'agent',
				instance,
				app: { name: project.name, scope: project.scope, scopeId: project.scopeId },
			});
			const result = await pending;
			if (!result?.success) throw new AgentError(result?.code || 'E_COMMAND_FAILED', result?.error || 'Download failed');
			return Buffer.from(String(result.packageBase64 || ''), 'base64');
		},
		async deploy(pkg) {
			const id = correlation('sdkdeploy');
			const pending = ctx.waitForBrowserResponse<any>(id, DEPLOY_TIMEOUT_MS);
			ctx.sendToBrowser(buildDeployMessage(id, pkg, instance, 'agent'));
			return pending;
		},
		log: (text) => ctx.log(`[${command}] ${text.trimEnd()}`),
	};
}

function asAgentError(e: any): never {
	if (e instanceof NowSdkFlowError) throw new AgentError(e.code as any, e.message, e.details);
	throw e;
}

const sdk_deploy: CommandHandler = {
	name: 'sdk_deploy',
	requiresBrowser: true,
	docs: {
		summary: 'Build, pack and install a NOW SDK (Fluent) app on the instance with the browser session. Stops when the app changed on the instance since the last deploy or pull, unless force is set. The user confirms in the helper tab. Pro/Trial.',
		request: {
			command: 'sdk_deploy',
			id: 'deploy_1',
			instance: 'dev12345',
			params: { projectPath: 'my-fluent-app' },
		},
		response: {
			success: true,
			installed: true,
			partial: false,
			app: { name: 'My App', scope: 'x_1234_my_app', version: '1.0.0' },
			instance: 'dev12345',
			rollbackUrl: 'https://dev12345.service-now.com/sys_rollback_context.do?sys_id=...',
			flowActivation: { ok: true, total: 1, succeeded: 1, failed: 0 },
			baselineRecorded: true,
			durationMs: 8200,
		},
		notes: 'projectPath is relative to the workspace root and may be omitted when the workspace holds one NOW SDK project. E_INSTANCE_CHANGED lists records changed on the instance since the last deploy or pull: ask the user whether to pull them first (sdk_pull) or overwrite them (force: true). `partial: true` means the app installed but some flows or actions did not activate. A timeout after the package was sent means the outcome is unknown: check the app on the instance before deploying again.',
	},
	async handle(ctx, params) {
		const root = projectRoot(ctx, params);
		try {
			return await deployFlow(root, transport(ctx, 'sdk_deploy'), { force: params?.force === true });
		} catch (e) {
			asAgentError(e);
		}
	},
};

const sdk_pull: CommandHandler = {
	name: 'sdk_pull',
	requiresBrowser: true,
	docs: {
		summary: 'Pull changes made on the instance into a NOW SDK (Fluent) project with the browser session and the project\'s own SDK. Applies when the affected files have no uncommitted git changes; dryRun only lists them. Pro/Trial.',
		request: {
			command: 'sdk_pull',
			id: 'pull_1',
			instance: 'dev12345',
			params: { projectPath: 'my-fluent-app' },
		},
		response: {
			app: { name: 'My App', scope: 'x_1234_my_app', version: '1.0.0' },
			instance: 'dev12345',
			changes: [{ path: 'src/server/script-includes/util.js', status: 'modified' }],
			applied: ['src/server/script-includes/util.js'],
			upToDate: false,
		},
		notes: 'Review the applied files with git diff and undo with git checkout. E_CONFIRM_REQUIRED means the project is not in git or an affected file has uncommitted edits: ask the user before passing force: true. The first pull also writes out defaults and IDs the ServiceNow SDK keeps in the source (firstPull: true). Files not on the instance are listed in notOnInstance and never deleted.',
	},
	async handle(ctx, params) {
		const root = projectRoot(ctx, params);
		try {
			return await pullFlow(root, transport(ctx, 'sdk_pull'), { force: params?.force === true, dryRun: params?.dryRun === true });
		} catch (e) {
			asAgentError(e);
		}
	},
};

export const sdkCommands: CommandHandler[] = [sdk_deploy, sdk_pull];
