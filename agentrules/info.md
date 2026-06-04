# AI Assistant Rules for sn-scriptsync

This folder contains AI assistant rules that help tools like Cursor, Claude, GitHub Copilot, Windsurf, and other AI coding assistants understand the sn-scriptsync file structure and best practices.

## Automatic Setup ✨

When you start the sn-scriptsync server, `agentinstructions.md` is placed in your workspace root and **kept up to date automatically**. The generated content lives inside `SN-SCRIPTSYNC:BEGIN` / `SN-SCRIPTSYNC:END` markers; anything you add outside those markers is preserved across updates.

**Your own `CLAUDE.md` / `AGENTS.md` / `.cursorrules` are never overwritten.** If one of those files already exists, sn-scriptsync only **appends** a tiny managed block — a single `@agentinstructions.md` import wrapped in `SN-SCRIPTSYNC` markers — after your content. The full instruction set lives only in `agentinstructions.md`, so those files stay small (well under Claude's recommended size). Only `agentinstructions.md` itself holds the full content.

**Recommended: import it instead of renaming it.** Keeping `agentinstructions.md` as the single source of truth means your AI tool always sees the latest version — no stale renamed copies to maintain.

- **Cursor**: reference it from a rule (or use `AGENTS.md`) — see below
- **Claude Code**: import it from `CLAUDE.md` with `@agentinstructions.md`
- **GitHub Copilot / Windsurf**: no import mechanism — copy it once and sn-scriptsync keeps the managed block refreshed
- **Cline/Aider**: keep `agentinstructions.md`

## Quick Setup

After starting sn-scriptsync, you'll find `agentinstructions.md` in your workspace root.

### Cursor (import — recommended)
Create `.cursor/rules/sn-scriptsync.mdc`:
```md
---
description: ServiceNow sn-scriptsync conventions + Agent API
alwaysApply: true
---
@agentinstructions.md
```
Or, if you prefer a single plain-markdown file, rename it to `AGENTS.md` (Cursor reads it directly):
```bash
mv agentinstructions.md AGENTS.md
```

### Claude Code (import — recommended)
Add a project-relative import to `CLAUDE.md`:
```md
@agentinstructions.md
```

### GitHub Copilot (copy — no import support)
```bash
mkdir -p .github
cp agentinstructions.md .github/copilot-instructions.md
```
sn-scriptsync refreshes the managed block in `.github/copilot-instructions.md` on each start.

### Windsurf / Codeium (copy — no import support)
```bash
cp agentinstructions.md .windsurfrules
```
sn-scriptsync refreshes the managed block in `.windsurfrules` on each start.

## Slim core + on-demand skills

To keep AI context (and token cost) small, the instructions are split in two:

- **`agentinstructions.md` — the always-loaded core (~390 lines).** Overview, file
  structure, workflow, the critical AI guidelines, an Agent API quickstart, an
  everyday-command cheat-sheet, a full command index, and a routing table.
- **`agentrules/skills/<name>/SKILL.md` — on-demand skills.** The agent opens these
  only when a task needs the depth, so the full command catalog, form-automation
  guide, etc. aren't force-loaded into every prompt:
  - `snu-agent-api` — full Agent API: transports, discovery, error codes, every command.
  - `snu-form-automation` — live form control via the `g_form` bridge.
  - `snu-artifacts` — file structure, naming, creating artifacts, `_map.json`.
  - `snu-coding-standards` — ServiceNow coding standards + security.
  - `snu-reference` — extended reference appendix.

The skills are mirrored into your workspace at `agentrules/skills/` on start and kept
in sync. When a skill is renamed or removed in an update, the extension cleans up the
old managed file automatically (it only ever deletes files it generated; your own
files are left alone). The core's routing table tells the agent which skill to read
for which task.

## What's Included

The instruction set covers:

- **File structure patterns** - How sn-scriptsync organizes ServiceNow artifacts
- **Naming conventions** - Correct file naming for different artifact types
- **Best practices** - ServiceNow coding standards and scoped app restrictions
- **Agent API documentation** - Commands for AI agents to interact with the extension
- **Common pitfalls** - What NOT to do (e.g., creating config files instead of using payloads)

## Keeping Up to Date

When sn-scriptsync is updated, check this folder for updated rules files. The rules are maintained alongside the extension to ensure they stay in sync with new features and changes.

## Manual Setup (Alternative)

If you need to manually set up without starting the server, you can copy the file from the extension folder:

```bash
# From your sn-scriptsync workspace root
# First, find the extension installation folder, typically:
# macOS: ~/.vscode/extensions/arnoudkooicom.sn-scriptsync-*/agentrules/
# Windows: %USERPROFILE%\.vscode\extensions\arnoudkooicom.sn-scriptsync-*\agentrules\
# Linux: ~/.vscode/extensions/arnoudkooicom.sn-scriptsync-*/agentrules/

cp /path/to/extension/agentrules/agentinstructions.md ./
# Then import or copy it for your tool as shown in Quick Setup above
```
