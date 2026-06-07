import { CommandHandler } from '../types';
import { connectionCommands } from './connection';
import { recordsCommands } from './records';
import { queryCommands } from './query';
import { searchCommands } from './search';
import { filesCommands } from './files';
import { browserCommands } from './browser';
import { scopedAppCommands } from './scopedapp';
import { restCommands } from './rest';
import { backgroundCommands } from './background';

const allHandlers: CommandHandler[] = [
	...connectionCommands,
	...recordsCommands,
	...queryCommands,
	...searchCommands,
	...filesCommands,
	...browserCommands,
	...scopedAppCommands,
	...restCommands,
	...backgroundCommands,
];

const registry = new Map<string, CommandHandler>();
for (const h of allHandlers) {
	if (registry.has(h.name)) {
		throw new Error(`[agent] Duplicate command name: ${h.name}`);
	}
	registry.set(h.name, h);
}

export function getCommand(name: string): CommandHandler | undefined {
	return registry.get(name);
}

export function listCommands(): CommandHandler[] {
	return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function commandNames(): string[] {
	return Array.from(registry.keys()).sort();
}
