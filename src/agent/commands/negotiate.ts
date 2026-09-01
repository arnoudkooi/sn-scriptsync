import { CommandHandler } from '../types';
import { getRuntime } from '../runtime';
import { AGENT_API_VERSION } from '../portFile';
import { commandNames } from './index';

/**
 * One answer to "what am I talking to, and can it do what I need?"
 *
 * Version information was scattered: the transport version in health, the
 * extension version in the port descriptor, the helper build behind
 * get_capabilities, and the CLI version nowhere the bridge could see. Anyone
 * diagnosing a mismatch had to assemble it, and an agent hitting an unsupported
 * command got E_UNKNOWN_COMMAND with no idea which component to upgrade.
 *
 * `transportApiVersion` is the name that means something: it versions this
 * HTTP/WebSocket contract. The old `apiVersion` is still reported so existing
 * callers keep working, and the instructions marker now uses
 * `instructionsSchemaVersion`, which is what it always actually was.
 */
const negotiate: CommandHandler = {
	name: 'negotiate',
	noInstance: true,
	docs: {
		summary: 'Report every component version and the supported command set in one response.',
		request: { command: 'negotiate', id: 'neg_1' },
		response: {
			status: 'success',
			result: {
				transportApiVersion: 9,
				hostKind: 'vscode',
				extensionVersion: '4.9.1',
				helper: { extensionVersion: '25.8.1', tier: 'pro' },
				commands: ['check_connection', '...'],
			},
		},
		notes: 'Use `commands` to check support before calling rather than discovering it through E_UNKNOWN_COMMAND. `apiVersion` is a deprecated alias for `transportApiVersion`.',
	},
	async handle(ctx) {
		const runtime = getRuntime();
		const helper = ctx.getHelperBuildInfo();

		return {
			transportApiVersion: AGENT_API_VERSION,
			/** @deprecated Use transportApiVersion. Kept so older CLIs keep working. */
			apiVersion: AGENT_API_VERSION,
			hostKind: 'vscode' as const,
			bridgeState: runtime.bridgeState ? runtime.bridgeState() : undefined,
			helper: helper
				? {
					extensionName: helper.extensionName,
					extensionVersion: helper.extensionVersion,
					tier: helper.tier ?? null,
					proFeatures: !!helper.proFeatures,
					debuggerAvailable: !!helper.debuggerAvailable,
					capabilities: helper.capabilities ?? null,
				}
				: null,
			// The authoritative support list. Checking this beats discovering a
			// missing command through an error at the point of use.
			commands: commandNames(),
			serverRunning: ctx.isServerRunning(),
			browserConnected: ctx.hasBrowserClient(),
		};
	},
};

export const negotiateCommands: CommandHandler[] = [negotiate];
