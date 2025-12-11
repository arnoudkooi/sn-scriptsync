# AI Assistant Rules for sn-scriptsync

This folder contains AI assistant rules that help tools like Cursor, Claude, GitHub Copilot, Windsurf, and other AI coding assistants understand the sn-scriptsync file structure and best practices.

## Automatic Setup ✨

When you start the sn-scriptsync server, the `agentinstructions.md` file is **automatically copied** to your workspace root. Just rename it based on your AI tool:

- **Cursor**: Rename to `.cursorrules`
- **Claude Desktop**: Rename to `CLAUDE.md` or keep as `agentinstructions.md`
- **GitHub Copilot**: Create `.github/` folder and rename to `copilot-instructions.md`
- **Windsurf**: Rename to `.windsurfrules`
- **Cline/Aider**: Keep as `agentinstructions.md`

## Quick Setup

After starting sn-scriptsync, you'll find `agentinstructions.md` in your workspace root. Rename it:

### Cursor
```bash
mv agentinstructions.md .cursorrules
```

### Claude Desktop
```bash
mv agentinstructions.md CLAUDE.md
```

### GitHub Copilot
```bash
mkdir -p .github
mv agentinstructions.md .github/copilot-instructions.md
```

### Windsurf / Codeium
```bash
mv agentinstructions.md .windsurfrules
```

## What's Included

The rules files contain:

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
# Then rename as shown in Quick Setup above
```
