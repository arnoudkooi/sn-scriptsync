<!--
===============================================================================
  SN SCRIPTSYNC - SETUP INSTRUCTIONS FOR USERS
===============================================================================

  This file (agentinstructions.md) was placed in your workspace root by the
  sn-scriptsync extension and is kept up to date automatically on every start.

  ✅ RECOMMENDED: keep this file where it is and have your AI tool IMPORT /
  REFERENCE it. That way there is a single source of truth that never goes
  stale — when the extension updates, your tool picks up the change for free.

  • Cursor:   create `.cursor/rules/sn-scriptsync.mdc` with this content:
                ---
                description: ServiceNow sn-scriptsync conventions + Agent API
                alwaysApply: true
                ---
                @agentinstructions.md
              (Cursor also reads a plain `AGENTS.md`, so renaming to AGENTS.md
              works too.)

  • Claude:   add this line to your `CLAUDE.md` (project-relative import):
                @agentinstructions.md

  🔁 Tools WITHOUT an import mechanism — create the file once by copying this
  one, and sn-scriptsync will keep the managed block inside it refreshed:

  • GitHub Copilot:  copy to `.github/copilot-instructions.md`
  • Windsurf:        copy to `.windsurfrules`
  • Cline / Aider:   keep this `agentinstructions.md`

  ✏️  Everything between the `SN-SCRIPTSYNC:BEGIN` / `SN-SCRIPTSYNC:END` markers
  is managed by the extension and refreshed in place. Add your own project notes
  OUTSIDE the markers and they will be preserved across updates.

  🔄 KEEPING THESE INSTRUCTIONS + SKILLS CURRENT
  This file and the on-demand skills under `agentrules/skills/` are regenerated
  by the extension on every start and re-synced whenever their version
  (`apiVersion` in the BEGIN marker / `agentrules/skills/_skills.json`) is newer
  than the copy in your workspace. To pull the latest: update the sn-scriptsync
  extension, then reload VS Code (or run "ServiceNow ScriptSync: Enable"). Renamed
  or removed skills are cleaned up automatically; your own files are never touched.

  🙅 PREFER YOUR OWN AGENT INSTRUCTIONS?
  Set `sn-scriptsync.agentInstructions.autoUpdate` to `false` and the extension
  will stop adding/refreshing the managed block inside your CLAUDE.md / AGENTS.md /
  .cursorrules / etc. It still keeps THIS file and `agentrules/skills/` up to date,
  so you can reference them yourself on demand — e.g. `@agentinstructions.md`, or
  point your agent at a specific `agentrules/skills/<name>/SKILL.md`.

  For more information: https://github.com/arnoudkooi/sn-scriptsync

===============================================================================
-->
