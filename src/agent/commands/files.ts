import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler } from '../types';
import { AgentError } from '../errors';

const list_tables: CommandHandler = {
	name: 'list_tables',
	docs: {
		summary: 'List top-level folders under the instance that look like table folders.',
	},
	async handle(ctx) {
		const entries = fs.readdirSync(ctx.instanceFolder, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
			.map((d) => d.name);
		return { tables: entries };
	},
};

const list_artifacts: CommandHandler = {
	name: 'list_artifacts',
	docs: {
		summary: 'List artifact files in a given table folder, walking scope sub-folders when needed.',
		request: { command: 'list_artifacts', id: 'la_1', params: { table: 'sys_script_include' } },
	},
	async handle(ctx, params) {
		const table = params?.table;
		if (!table) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: table');

		const tablePath = path.join(ctx.instanceFolder, table);
		if (fs.existsSync(tablePath)) {
			const files = fs.readdirSync(tablePath).filter((f) => !f.startsWith('_') && !f.startsWith('.'));
			return { artifacts: files };
		}

		// Walk scope-level folders
		const scopes = fs.readdirSync(ctx.instanceFolder, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith('_'));

		let artifacts: string[] = [];
		for (const scope of scopes) {
			const scopeTablePath = path.join(ctx.instanceFolder, scope.name, table);
			if (fs.existsSync(scopeTablePath)) {
				const files = fs.readdirSync(scopeTablePath).filter((f) => !f.startsWith('_') && !f.startsWith('.'));
				artifacts = artifacts.concat(files.map((f) => `${scope.name}/${f}`));
			}
		}
		return { artifacts };
	},
};

const check_name_exists: CommandHandler = {
	name: 'check_name_exists',
	docs: {
		summary: 'Look up an artifact name in the local _map.json files.',
		request: { command: 'check_name_exists', id: 'cn_1', params: { table: 'sys_script_include', name: 'MyUtils' } },
	},
	async handle(ctx, params) {
		const { table, name } = params || {};
		if (!table || !name) throw new AgentError('E_INVALID_PARAMS', 'Missing required params: table, name');

		const scopeDirs = fs.readdirSync(ctx.instanceFolder, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith('_'));

		for (const scopeDir of scopeDirs) {
			const mapPath = path.join(ctx.instanceFolder, scopeDir.name, table, '_map.json');
			if (fs.existsSync(mapPath)) {
				try {
					const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
					for (const [sysId, info] of Object.entries(mapContent)) {
						const recordName = typeof info === 'string' ? info : (info as any)?.name;
						if (recordName === name) {
							return { exists: true, sysId };
						}
					}
				} catch { /* ignore */ }
			}
		}
		return { exists: false, sysId: null };
	},
};

const get_file_structure: CommandHandler = {
	name: 'get_file_structure',
	noInstance: true,
	docs: {
		summary: 'Return the expected file naming convention and the list of code fields per table.',
	},
	async handle() {
		return {
			pattern: '{instance}/{scope}/{table}/{name}.{field}.{ext}',
			example: 'myinstance/global/sys_script_include/MyUtils.script.js',
			fields: {
				sys_script_include: ['script'],
				sys_script: ['script'],
				sys_ui_script: ['script'],
				sp_widget: ['script', 'css', 'client_script', 'link', 'template'],
				sys_ui_page: ['html', 'client_script', 'processing_script'],
			},
		};
	},
};

const validate_path: CommandHandler = {
	name: 'validate_path',
	noInstance: true,
	docs: {
		summary: 'Validate a proposed file path against the expected naming convention.',
	},
	async handle(_ctx, params) {
		const filePath = params?.path;
		if (!filePath) throw new AgentError('E_INVALID_PARAMS', 'Missing required param: path');

		const parts = filePath.split(path.sep).filter((p: string) => p);
		const isValid = parts.length >= 3;
		return {
			valid: isValid,
			parsed: isValid ? {
				instance: parts[0],
				scope: parts.length > 3 ? parts[1] : 'global',
				table: parts.length > 3 ? parts[2] : parts[1],
				file: parts[parts.length - 1],
			} : null,
			reason: !isValid ? 'Path must be at least instance/table/file' : null,
		};
	},
};

export const filesCommands: CommandHandler[] = [
	list_tables,
	list_artifacts,
	check_name_exists,
	get_file_structure,
	validate_path,
];
