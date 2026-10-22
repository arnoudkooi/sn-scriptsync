import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { getWorkspaceRoot } from '../../workspaceRoot';
import { mustGetInstanceSettings, restRequest } from './_shared';
import { checkDownloadTarget, resolveDownloadTarget, saveDownloadedAttachment, validateDownloadParams } from '../attachmentOutput';

// Attachment download and delete. The upload counterpart lives in browser.ts.
// A download's bytes go from the helper tab straight to a workspace file; the
// agent only ever sees the path and metadata (see attachmentOutput.ts).

const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

function asAgentError(error: any): never {
	if (error instanceof AgentError) throw error;
	if (error?.code) throw new AgentError(error.code, error.message, error.details);
	throw error;
}

const download_attachment: CommandHandler = {
	name: 'download_attachment',
	requiresBrowser: true,
	docs: {
		summary: 'Download one attachment (sys_attachment sys_id) to a workspace file and return its path, size, content type and sha256, never the bytes. Default path: <instance>/attachments/<sys_id>/<file name>; pass filePath for another path and overwrite:true to replace a file. Up to 50 MB.',
		request: { command: 'download_attachment', id: 'da_1', params: { sys_id: '...', filePath: 'attachments/logo.png' } },
	},
	async handle(ctx, params) {
		const root = ctx.workspaceRoot || getWorkspaceRoot() || '';
		let request: ReturnType<typeof validateDownloadParams>;
		try {
			request = validateDownloadParams(params || {});
			// Refuse an unusable target before any bytes move.
			if (request.filePath !== undefined) checkDownloadTarget(resolveDownloadTarget(request, root, ctx.instanceFolder), request.overwrite);
		} catch (error) {
			asAgentError(error);
		}
		// An older helper tab would treat this action as a record save, so the
		// capability check is not optional.
		if (ctx.getHelperBuildInfo()?.capabilities?.attachmentDownload !== 1) {
			throw new AgentError('E_UNSUPPORTED_HELPER', 'The connected SN Utils helper tab cannot download attachments. Update SN Utils and reopen the ScriptSync helper tab.');
		}
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const correlationId = `agent_${ctx.request.id}_download_${Date.now()}`;
		const pending = ctx.waitForBrowserResponse<any>(correlationId, DOWNLOAD_TIMEOUT_MS);
		ctx.sendToBrowser({
			action: 'agentDownloadAttachment',
			agentRequestId: correlationId,
			sysId: request.sysId,
			maxBytes: request.maxBytes,
			instance: instanceSettings,
			appName: 'VS Code',
		});
		const reply = await pending;
		if (!reply || reply.success === false) {
			throw new AgentError(reply?.code || 'E_COMMAND_FAILED', reply?.error || 'Attachment download failed', reply?.details);
		}
		try {
			const result = saveDownloadedAttachment(reply, request, root, ctx.instanceFolder);
			ctx.log(`Agent API: Downloaded attachment ${request.sysId} to ${result.filePath} (${result.sizeBytes} bytes)`);
			return result;
		} catch (error) {
			asAgentError(error);
		}
	},
};

const delete_attachment: CommandHandler = {
	name: 'delete_attachment',
	requiresBrowser: true,
	docs: {
		summary: 'Delete one attachment through the Attachment API, which removes the sys_attachment row and its stored content. dryRun:true only previews it. Controlled per-instance in the SN Utils helper tab (delete permission).',
		request: { command: 'delete_attachment', id: 'dat_1', params: { sys_id: '...' } },
	},
	async handle(ctx, params) {
		const sysId = params?.sys_id;
		if (typeof sysId !== 'string' || !/^[a-f0-9]{32}$/i.test(sysId)) {
			throw new AgentError('E_INVALID_PARAMS', 'delete_attachment requires the 32-character sys_id of a sys_attachment record');
		}
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		let meta: any;
		try {
			const { data } = await restRequest(ctx, instanceSettings, { endpoint: `/api/now/attachment/${sysId}`, method: 'GET' });
			meta = data?.result;
		} catch (error: any) {
			if (error?.code === 'E_NOT_FOUND') throw new AgentError('E_NOT_FOUND', `No attachment with sys_id ${sysId}`);
			throw error;
		}
		if (!meta?.sys_id) throw new AgentError('E_NOT_FOUND', `No attachment with sys_id ${sysId}`);
		const summary = {
			sys_id: sysId.toLowerCase(),
			fileName: meta.file_name ?? null,
			table: meta.table_name ?? null,
			tableSysId: meta.table_sys_id ?? null,
			sizeBytes: meta.size_bytes !== undefined ? Number(meta.size_bytes) : null,
		};
		if (params?.dryRun === true) return { dryRun: true, deleted: false, ...summary };
		await restRequest(ctx, instanceSettings, { endpoint: `/api/now/attachment/${sysId}`, method: 'DELETE' });
		ctx.log(`Agent API: Deleted attachment ${sysId} (${summary.fileName})`);
		return { deleted: true, ...summary };
	},
};

export const attachmentCommands: CommandHandler[] = [download_attachment, delete_attachment];
