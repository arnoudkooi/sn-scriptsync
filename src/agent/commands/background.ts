import { CommandHandler } from '../types';
import { AgentError } from '../errors';
import { mustGetInstanceSettings, getSetting, runBackgroundScript } from './_shared';

function isBackgroundScriptsEnabled(): boolean {
	return getSetting('backgroundScripts.enabled', false);
}

function isDeleteRecordsEnabled(): boolean {
	return getSetting('deleteRecords.enabled', false);
}

const run_background_script: CommandHandler = {
	name: 'run_background_script',
	requiresBrowser: true,
	docs: {
		summary: 'Run a server-side background script on the instance and return its captured output. Disabled by default (sn-scriptsync.backgroundScripts.enabled).',
		request: { command: 'run_background_script', id: 'bg_1', params: { script: "gs.print('hello from ' + gs.getUserName());" } },
	},
	async handle(ctx, params) {
		if (!isBackgroundScriptsEnabled()) {
			throw new AgentError('E_DISABLED', 'Background scripts are disabled. Enable sn-scriptsync.backgroundScripts.enabled to allow run_background_script.');
		}
		const script = params?.script;
		if (!script || typeof script !== 'string') {
			throw new AgentError('E_INVALID_PARAMS', 'Missing required param: script (string)');
		}
		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const output = await runBackgroundScript(ctx, instanceSettings, script);
		ctx.log(`Agent API: Ran background script (${output.length} chars output)`);
		return { executed: true, output };
	},
};

const delete_application: CommandHandler = {
	name: 'delete_application',
	requiresBrowser: true,
	docs: {
		summary: 'Cascade-delete a scoped application (its scoped metadata + the sys_app record) via a guarded background script. Requires confirm:true and both delete + background-script settings enabled.',
		request: { command: 'delete_application', id: 'delapp_1', params: { scope: 'x_acme_myapp', confirm: true } },
	},
	async handle(ctx, params) {
		if (!isDeleteRecordsEnabled()) {
			throw new AgentError('E_DISABLED', 'Record deletion is disabled. Enable sn-scriptsync.deleteRecords.enabled to allow delete_application.');
		}
		if (!isBackgroundScriptsEnabled()) {
			throw new AgentError('E_DISABLED', 'delete_application runs a background script. Enable sn-scriptsync.backgroundScripts.enabled to allow it.');
		}
		if (params?.confirm !== true) {
			throw new AgentError('E_CONFIRM_REQUIRED', 'delete_application is destructive and irreversible. Pass confirm:true to proceed.');
		}

		const sysId: string = params?.sys_id || '';
		const scope: string = params?.scope || '';
		if (!sysId && !scope) throw new AgentError('E_INVALID_PARAMS', 'Provide sys_id (sys_app) or scope (e.g. x_acme_myapp)');
		if (sysId && !/^[0-9a-f]{32}$/i.test(sysId)) throw new AgentError('E_INVALID_PARAMS', 'sys_id must be a 32-char hex sys_id');
		if (scope && !/^[a-z0-9_]+$/i.test(scope)) throw new AgentError('E_INVALID_PARAMS', 'scope must contain only letters, digits and underscores');

		const instanceSettings = mustGetInstanceSettings(ctx.instanceFolder);
		const script = buildDeleteAppScript(sysId, scope);
		const output = await runBackgroundScript(ctx, instanceSettings, script);

		if (output.includes('SNU_DELAPP:NOT_FOUND')) {
			throw new AgentError('E_NOT_FOUND', `No application found for ${sysId || scope}`);
		}
		const m = /SNU_DELAPP:OK:([^:]*):([^:]*):(\d+)/.exec(output);
		if (!m) {
			throw new AgentError('E_INTERNAL', 'delete_application did not complete cleanly', { output: output.slice(0, 2000) });
		}
		ctx.log(`Agent API: Deleted application ${m[1]} (scope ${m[2]}, ${m[3]} child records)`);
		return { deleted: true, name: m[1], scope: m[2], childRecordsDeleted: Number(m[3]) };
	},
};

/** Build the (input-validated) cascade-delete fix script. */
function buildDeleteAppScript(sysId: string, scope: string): string {
	const appIdLiteral = JSON.stringify(sysId);
	const scopeLiteral = JSON.stringify(scope);
	return `(function(){
  var appId = ${appIdLiteral};
  var scopeName = ${scopeLiteral};
  var gr = new GlideRecord('sys_app');
  var found = false;
  if (appId) { found = gr.get(appId); }
  else if (scopeName) { gr.addQuery('scope', scopeName); gr.query(); found = gr.next(); }
  if (!found) { gs.print('SNU_DELAPP:NOT_FOUND'); return; }
  var realId = gr.getUniqueValue();
  var realScope = gr.getValue('scope');
  var appName = gr.getValue('name');
  var count = 0;
  var md = new GlideRecord('sys_metadata');
  md.addQuery('sys_scope', realId);
  md.query();
  while (md.next()) { try { md.deleteRecord(); count++; } catch(e) {} }
  gr.deleteRecord();
  gs.print('SNU_DELAPP:OK:' + appName + ':' + realScope + ':' + count);
})();`;
}

export const backgroundCommands: CommandHandler[] = [run_background_script, delete_application];
