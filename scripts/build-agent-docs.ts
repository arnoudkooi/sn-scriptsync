/*
 * Assembles the AI agent instruction set from the section and command fragments
 * in agentrules/{sections,commands}/.
 *
 * Output (issue #148 — token-efficient, discovery-based layout):
 *   - agentrules/agentinstructions.md      slim always-loaded CORE: overview,
 *       workflow, critical AI guidelines, Agent API quickstart, an everyday
 *       command cheat-sheet, a grouped command index, and a routing table that
 *       points the agent at the on-demand skills below.
 *   - agentrules/agentreference.md         tiny managed REFERENCE block that
 *       imports agentinstructions.md. This (not the full core) is what the
 *       extension drops into tool-standard files (CLAUDE.md, AGENTS.md,
 *       .cursorrules, ...) so they stay small and are never overwritten.
 *   - agentrules/skills/<name>/SKILL.md    on-demand skills the agent only opens
 *       when a task needs the depth (full command catalog, form automation, etc.).
 *   - agentrules/skills/_skills.json        manifest of generated skill files so
 *       the extension can deterministically reconcile/delete orphans on update.
 *
 * The CORE carries a SN-SCRIPTSYNC managed-block marker; each SKILL.md carries a
 * SN-SCRIPTSYNC:SKILL marker. Both are stamped with INSTRUCTIONS_VERSION so the
 * extension can refresh user copies (and clean up removed skills) when it bumps.
 *
 * Run via `npm run build:agent-docs` (called automatically by `npm run compile`).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'agentrules');
const SECTIONS_DIR = path.join(AGENT_DIR, 'sections');
const COMMANDS_DIR = path.join(AGENT_DIR, 'commands');
const SKILLS_DIR = path.join(AGENT_DIR, 'skills');
const CORE_OUTPUT = path.join(AGENT_DIR, 'agentinstructions.md');
const REFERENCE_OUTPUT = path.join(AGENT_DIR, 'agentreference.md');
const MANIFEST_OUTPUT = path.join(SKILLS_DIR, '_skills.json');

// Revision of the generated instruction docs. This is INTENTIONALLY decoupled
// from the HTTP protocol version (src/agent/portFile.ts -> AGENT_API_VERSION):
// the managed block in users' instruction files (and the mirrored skills) is
// refreshed whenever this number increases, so bump it on ANY content change
// (wording, fixes, new sections, new skills). The marker is emitted as
// `apiVersion=N` for backward compatibility with the extension's refresh regex.
//   v2 -> v3: #141 typo fixes, import-vs-rename guidance, endpoint-discovery
//             algorithm, dual-transport migration notes.
//   v3 -> v4: new commands (get_record, delete_record, create_application,
//             add_column, get_served_url, navigate_and_screenshot,
//             rest_request); await:true write confirmation on update/create.
//   v4 -> v5: run_background_script + delete_application (background-script
//             cascade), screenshot exactUrl strict targeting + structured
//             E_SCREENSHOT_PERMISSION with one auto-retry.
//   v5 -> v6: live form / page control via the g_form bridge (navigate,
//             set_field, get_form_state, run_ui_action, click_element).
//   v6 -> v7: #148 — split the monolithic instructions into a slim core + an
//             on-demand agentrules/skills/ set (token efficiency).
//   v7 -> v8: stop clobbering tool-standard files (CLAUDE.md, AGENTS.md,
//             .cursorrules, ...). Those now receive only a tiny managed
//             REFERENCE block that imports agentinstructions.md, appended to
//             the user's own content — never a whole-file replace. agentre-
//             ference.md is the source for that block; agentinstructions.md
//             stays the single full source of truth.
//   v8 -> v9: added code_search (SN Utils GraphQL field-index code search, Pro).
//   v9 -> v10: code_search — documented full response shape (words, richer
//              stats, per-match matchingWords + lineMatches) and surfaced it in
//              the everyday cheat-sheet for inline discoverability.
const INSTRUCTIONS_VERSION = 10;

// Marker that identifies a file as an extension-managed skill. The extension
// only ever deletes files that carry this marker, so user-authored files in the
// skills tree are never touched by the reconcile/cleanup step.
const SKILL_MARKER = `<!-- SN-SCRIPTSYNC:SKILL apiVersion=${INSTRUCTIONS_VERSION} -->`;

// --- Command catalog ---------------------------------------------------------
// Grouped for the auto-generated command index in the core. The flattened list
// is also the canonical command order inside the skills that own them.
const COMMAND_GROUPS: Array<{ label: string; cmds: string[] }> = [
	{ label: 'Connection & state', cmds: ['check_connection', 'get_instance_info', 'get_sync_status', 'sync_now', 'get_last_error', 'clear_last_error'] },
	{ label: 'Records — write', cmds: ['update_record', 'update_record_batch', 'create_artifact', 'delete_record'] },
	{ label: 'Scoped-app ergonomics', cmds: ['create_application', 'add_column', 'delete_application'] },
	{ label: 'Records — read', cmds: ['get_record', 'get_table_metadata', 'check_name_exists_remote'] },
	{ label: 'Queries', cmds: ['query_records', 'get_parent_options', 'code_search'] },
	{ label: 'Escape hatches', cmds: ['rest_request', 'run_background_script'] },
	{ label: 'File-system helpers', cmds: ['list_tables', 'list_artifacts', 'check_name_exists', 'get_file_structure', 'validate_path'] },
	{ label: 'Browser helpers', cmds: ['open_in_browser', 'get_served_url', 'refresh_preview', 'take_screenshot', 'navigate_and_screenshot', 'run_slash_command', 'activate_tab', 'switch_context', 'upload_attachment'] },
	{ label: 'Live form / page (g_form bridge)', cmds: ['navigate', 'set_field', 'get_form_state', 'run_ui_action', 'click_element'] },
];

const COMMAND_ORDER = COMMAND_GROUPS.flatMap((g) => g.cmds);

// Commands handled by the g_form bridge live in the form-automation skill; all
// others live in the agent-api skill.
const FORM_COMMANDS = new Set(['navigate', 'set_field', 'get_form_state', 'run_ui_action', 'click_element']);

// The everyday cheat-sheet that stays inline in the core so common tasks are
// zero-hop. Keep this short — it is a teaser, not the catalog.
const EVERYDAY: Array<{ cmd: string; blurb: string }> = [
	{ cmd: 'query_records', blurb: 'Encoded-query any table (fetch/check/explore records).' },
	{ cmd: 'get_record', blurb: 'Fetch one record by table + sys_id (e.g. confirm a write).' },
	{ cmd: 'update_record', blurb: 'Update fields on an existing record (pass `await:true` to read back).' },
	{ cmd: 'create_artifact', blurb: 'Create a record incl. config fields via payload (not loose files).' },
	{ cmd: 'navigate_and_screenshot', blurb: 'Open a page and capture it in one call to verify state.' },
	{ cmd: 'code_search', blurb: 'Find existing code across script tables — `term` required (Pro). See the snu-agent-api skill for params/response.' },
];

// --- Skill definitions -------------------------------------------------------
// Each skill is the source of truth for a domain. `sections`/`commands` are the
// fragment basenames (without .md) it owns, in emit order.
interface SkillDef {
	name: string;
	title: string;
	description: string;
	intro: string;
	sections: string[];
	commands: string[];
}

const SKILLS: SkillDef[] = [
	{
		name: 'snu-agent-api',
		title: 'SN ScriptSync — Agent API',
		description:
			'SN ScriptSync HTTP/file Agent API: endpoint discovery, auth, the full error-code table, and the complete command catalog (query_records, get_record, update_record, create_artifact, create_application, rest_request, screenshots, etc.). Read this before calling any Agent API command.',
		intro: 'Full reference for the SN ScriptSync Agent API and every command except the live-form g_form bridge (see the snu-form-automation skill).',
		sections: ['70-agent-api', '71-legacy-file-api'],
		commands: COMMAND_ORDER.filter((c) => !FORM_COMMANDS.has(c)),
	},
	{
		name: 'snu-form-automation',
		title: 'SN ScriptSync — Live Form Automation',
		description:
			'Drive live ServiceNow forms via the g_form bridge (navigate, set_field, get_form_state, run_ui_action, click_element): insert vs update verbs, optimistic-write verification, auto-handled native dialogs, and auto-filling mandatory reference fields. Read this when automating or visually verifying a form/UI page/widget.',
		intro: 'How to control and verify live ServiceNow forms through the authenticated browser session.',
		sections: ['65-form-automation'],
		commands: ['navigate', 'set_field', 'get_form_state', 'run_ui_action', 'click_element'],
	},
	{
		name: 'snu-artifacts',
		title: 'SN ScriptSync — Artifacts & File Structure',
		description:
			'How sn-scriptsync maps ServiceNow artifacts to files: the instance/scope/table layout, naming conventions per artifact type, creating new artifacts, and the _map.json / structure.json files. Read this when creating, naming, or organizing ServiceNow files.',
		intro: 'Conventions for naming, creating, and organizing ServiceNow artifacts as local files.',
		sections: ['20-naming', '30-creating'],
		commands: [],
	},
	{
		name: 'snu-coding-standards',
		title: 'SN ScriptSync — Coding Standards & Security',
		description:
			'ServiceNow coding standards (scoped-app restrictions, server vs client APIs, best practices) and security guidance for the sn-scriptsync workflow. Read this when writing or reviewing ServiceNow script content.',
		intro: 'Coding standards and security practices for ServiceNow script content.',
		sections: ['40-coding-standards', '75-security'],
		commands: [],
	},
	{
		name: 'snu-reference',
		title: 'SN ScriptSync — Deep Reference',
		description:
			'Extended reference appendix: detailed file-structure notes, table metadata caching, agent best-practices, and edge cases not covered by the core. Read this when you need depth the other skills do not cover.',
		intro: 'Appendix and deep-dive reference material.',
		sections: ['90-appendix'],
		commands: [],
	},
];

// --- Helpers -----------------------------------------------------------------
function readSection(name: string): string {
	const p = path.join(SECTIONS_DIR, `${name}.md`);
	if (!fs.existsSync(p)) {
		throw new Error(`[build-agent-docs] missing section fragment: ${name}.md`);
	}
	return fs.readFileSync(p, 'utf8').trimEnd();
}

function readCommand(name: string): string | null {
	const p = path.join(COMMANDS_DIR, `${name}.md`);
	if (!fs.existsSync(p)) {
		console.warn(`[build-agent-docs] missing command doc: ${name}.md`);
		return null;
	}
	return fs.readFileSync(p, 'utf8').trimEnd();
}

function listFragmentBasenames(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
}

// Sections that stay in the always-loaded core, in reading order.
const CORE_SECTIONS = ['00-header', '10-overview', '50-workflow', '60-ai-guidelines', '15-agent-api-quickstart'];

function renderSkillsRoutingTable(): string {
	const rows = SKILLS.map(
		(s) => `| \`agentrules/skills/${s.name}/SKILL.md\` | ${s.description} |`,
	).join('\n');
	return [
		'## Agent Skills — load on demand',
		'',
		'To keep this file small, deep detail lives in skills you open **only when a task needs it**.',
		'Read the relevant `SKILL.md` (a normal workspace file) before doing the work it covers.',
		'',
		'| Skill | When to read it |',
		'|-------|-----------------|',
		rows,
	].join('\n');
}

function renderEverydayCheatSheet(): string {
	const rows = EVERYDAY.map((e) => `| \`${e.cmd}\` | ${e.blurb} |`).join('\n');
	return [
		'## Everyday commands (cheat-sheet)',
		'',
		'The commands you reach for most. Full parameters, responses, and the rest of the catalog are in the `snu-agent-api` skill.',
		'',
		'| Command | What it does |',
		'|---------|--------------|',
		rows,
	].join('\n');
}

function renderCommandIndex(): string {
	const groups = COMMAND_GROUPS.map((g) => {
		const names = g.cmds.map((c) => `\`${c}\``).join(', ');
		const home = g.cmds.every((c) => FORM_COMMANDS.has(c)) ? 'snu-form-automation' : 'snu-agent-api';
		return `- **${g.label}** — ${names}  \n  _docs: \`agentrules/skills/${home}/SKILL.md\`_`;
	}).join('\n');
	return [
		'## Full command index',
		'',
		'Every available command grouped by purpose. Open the listed skill for full docs (request/response/params).',
		'',
		groups,
	].join('\n');
}

function buildCore(): string {
	const header = [
		`<!-- SN-SCRIPTSYNC:BEGIN apiVersion=${INSTRUCTIONS_VERSION} -->`,
		`<!-- apiVersion: ${INSTRUCTIONS_VERSION} -->`,
		`<!-- generated by scripts/build-agent-docs.ts — edit fragments in agentrules/{sections,commands}/ -->`,
	].join('\n');

	const parts = [
		header,
		readSection('00-header'),
		readSection('10-overview'),
		renderSkillsRoutingTable(),
		readSection('50-workflow'),
		readSection('60-ai-guidelines'),
		readSection('15-agent-api-quickstart'),
		renderEverydayCheatSheet(),
		renderCommandIndex(),
	];

	return parts.filter(Boolean).join('\n\n') + '\n\n<!-- SN-SCRIPTSYNC:END -->\n';
}

// The slim REFERENCE block dropped into tool-standard instruction files
// (CLAUDE.md, AGENTS.md, .cursorrules, ...). It deliberately carries NO content
// of its own beyond a pointer to agentinstructions.md, so these user-authored
// files stay tiny (well under Claude's recommended size) and never go stale.
// The `@agentinstructions.md` line is a project-relative import for tools that
// support it (Claude Code, Cursor); for the rest it reads as a plain reference.
function buildReference(): string {
	const body = [
		'## ServiceNow Script Sync (sn-scriptsync)',
		'',
		'This workspace uses the **sn-scriptsync** VS Code extension to sync ServiceNow',
		'artifacts with local files and exposes a local HTTP Agent API for AI tools.',
		'',
		'The full ServiceNow conventions, the Agent API reference, and the on-demand',
		'skills live in [`agentinstructions.md`](agentinstructions.md). Read it before',
		'working with ServiceNow artifacts or calling the Agent API.',
		'',
		'@agentinstructions.md',
	].join('\n');

	return [
		`<!-- SN-SCRIPTSYNC:BEGIN apiVersion=${INSTRUCTIONS_VERSION} -->`,
		`<!-- apiVersion: ${INSTRUCTIONS_VERSION} -->`,
		'<!-- Managed by the sn-scriptsync VS Code extension and refreshed automatically.',
		'     This is only a small pointer to agentinstructions.md so this file stays tiny.',
		'     Add your own notes OUTSIDE these markers — they are preserved across updates. -->',
		'',
		body,
		'',
		'<!-- SN-SCRIPTSYNC:END -->',
		'',
	].join('\n');
}

function buildSkill(skill: SkillDef): string {
	const frontmatter = ['---', `name: ${skill.name}`, `description: ${skill.description}`, '---'].join('\n');

	const blocks: string[] = [frontmatter, SKILL_MARKER, `# ${skill.title}`, skill.intro];

	for (const sec of skill.sections) {
		blocks.push(readSection(sec));
	}

	if (skill.commands.length) {
		blocks.push('## Commands');
		for (const cmd of skill.commands) {
			const body = readCommand(cmd);
			if (body) blocks.push(body);
		}
	}

	return blocks.filter(Boolean).join('\n\n') + '\n';
}

// Fail the build if any fragment is unowned or owned twice — this is what keeps
// the core + skills a complete, non-overlapping partition of the fragments.
function validateCoverage() {
	const allSections = new Set(listFragmentBasenames(SECTIONS_DIR));
	const allCommands = new Set(listFragmentBasenames(COMMANDS_DIR));

	const sectionOwner = new Map<string, string>();
	const commandOwner = new Map<string, string>();
	const errors: string[] = [];

	const claimSection = (name: string, owner: string) => {
		if (!allSections.has(name)) errors.push(`section "${name}" referenced by ${owner} does not exist`);
		if (sectionOwner.has(name)) errors.push(`section "${name}" owned by both ${sectionOwner.get(name)} and ${owner}`);
		sectionOwner.set(name, owner);
	};
	const claimCommand = (name: string, owner: string) => {
		if (!allCommands.has(name)) errors.push(`command "${name}" referenced by ${owner} does not exist`);
		if (commandOwner.has(name)) errors.push(`command "${name}" owned by both ${commandOwner.get(name)} and ${owner}`);
		commandOwner.set(name, owner);
	};

	CORE_SECTIONS.forEach((s) => claimSection(s, 'core'));
	for (const skill of SKILLS) {
		skill.sections.forEach((s) => claimSection(s, skill.name));
		skill.commands.forEach((c) => claimCommand(c, skill.name));
	}

	for (const s of allSections) {
		if (!sectionOwner.has(s)) errors.push(`section "${s}" is not referenced by the core or any skill (orphan)`);
	}
	for (const c of allCommands) {
		if (!commandOwner.has(c)) errors.push(`command "${c}" is not referenced by any skill (orphan)`);
	}

	if (errors.length) {
		console.error('[build-agent-docs] coverage validation failed:');
		errors.forEach((e) => console.error(`  - ${e}`));
		process.exit(1);
	}
}

function main() {
	validateCoverage();

	// Core
	const core = buildCore();
	fs.writeFileSync(CORE_OUTPUT, core);
	const coreLines = core.split('\n').length;

	// Slim reference block for tool-standard files (CLAUDE.md, AGENTS.md, ...).
	const reference = buildReference();
	fs.writeFileSync(REFERENCE_OUTPUT, reference);

	// Skills (fresh dir contents for the generated files; user files, if any, are
	// left in place — we only rewrite the files we own).
	fs.mkdirSync(SKILLS_DIR, { recursive: true });
	const manifestFiles: string[] = [];
	for (const skill of SKILLS) {
		const rel = path.join(skill.name, 'SKILL.md');
		const dest = path.join(SKILLS_DIR, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, buildSkill(skill));
		manifestFiles.push(rel.split(path.sep).join('/'));
	}

	// Manifest — paths are relative to the skills dir so the extension can mirror
	// + reconcile against whatever workspace it runs in.
	const manifest = {
		version: INSTRUCTIONS_VERSION,
		generatedAt: new Date().toISOString(),
		marker: SKILL_MARKER,
		files: manifestFiles.sort(),
	};
	fs.writeFileSync(MANIFEST_OUTPUT, JSON.stringify(manifest, null, 2) + '\n');

	console.log(
		`[build-agent-docs] wrote core (${coreLines} lines), reference (${reference.split('\n').length} lines), ` +
			`${SKILLS.length} skills, ${COMMAND_ORDER.length} commands, manifest v${INSTRUCTIONS_VERSION}`,
	);
}

main();
