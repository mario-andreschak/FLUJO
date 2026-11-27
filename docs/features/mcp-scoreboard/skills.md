# Scoreboard row: Skills over MCP

Part of [#1448](https://github.com/mario-andreschak/FLUJO/issues/1448).
Checked on 2026-11-27 against [Is MCP good yet?](https://ismcpgoodyet.com/), the
[Skills extension overview](https://modelcontextprotocol.io/extensions/skills/overview)
and [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension).

**Assessment: Yes.** FLUJO lists a connected server's skills live with
`skills/list`, shows them to people and agents as metadata, and reads them with
`resources/read` only when someone loads one, through the verified,
approval-bound loading path. It is on by default.

## What the scoreboard asks

The row reads "An MCP server serves Agent Skills (SKILL.md directories) as
`skill://` resources. The client lists them with `skills/list` and reads them."
No client is rated Yes yet. Claude Code, Codex and OpenCode are Partial because
the support is beta, behind a flag, or an import without a live `skills/list`.
FLUJO was Partial because Skills were an experimental per-server opt-in and only
a person could load a skill, from the server's details dialog.

## The expected client flow, step by step

| Step (SEP-2640) | FLUJO | Proof |
| --- | --- | --- |
| Discovery: see `io.modelcontextprotocol/skills` on the server; declare the client extension | Declared to every server unless Skills are turned off; checked before any Skills request | `mcpSkillsEnabled`, `getMcpSkillsCapability`; `__tests__/mcp/mcpSkillsNegotiation.test.ts` |
| Not opt-in, not experimental | On by default ("MCP Skills" on the server card turns it off) | `src/shared/utils/mcpClientFeatures.ts`; lint rule `flujo/mcp-feature-defaults` |
| Listing: `skills/list` with cursors, metadata only | Live on every step whose servers offer skills, and in the server's "Skills" tab | `listMcpSkillCatalog` in `mcpSkillTools.ts`; `__tests__/mcp/mcpSkillTools.test.ts`, `skillsProtocol.test.ts` |
| Progressive disclosure: name and description up front | The agent's `load_mcp_skill` tool lists `server:name`, URI and description; no file is read | `buildLoadMcpSkillTool`; `mcpSkillTools.test.ts` |
| Selection by the model or by the person | The agent calls `load_mcp_skill`; a person loads one in the Skills tab and picks it per turn | `executeMcpSkillTool`; `MCPSkillsManager`, `ApprovedMcpSkillsContext.tsx` |
| Lookup with `skills/get` | Before loading, FLUJO gets the current entry and manifest digest | `MCPService.getServerSkill`; `skillsRoutes.test.ts` |
| Approval bound to the content | Asked once per conversation and manifest digest; a changed skill asks again | `skillApprovalRegistry.ts`; `skillApprovalRegistry.test.ts`, `mcpSkillTools.test.ts` |
| Load: `resources/read`, size, SHA-256 and frontmatter checked, only listed files | Yes; dynamic skills cannot be loaded | `loadVerifiedMcpSkill` in `skills.ts`; `skillsFunctions.test.ts` |
| Use: content treated as untrusted data; `allowed-tools` never honored | Marked untrusted-data block, no new tools, roots or network | `formatMcpSkillModelContext`; `skillModelContext.test.ts` |
| Identity is (server, URI), never the name alone | `server:name` labels, approvals keyed by server and URI | `skillApprovalRegistry.ts` |
| Optional `resources/directory/read` | Used only when `directoryRead: true` | `skills.ts` |

## Remaining scope

- A run nobody watches (a schedule, a trigger) cannot approve a skill it has not
  used before in that conversation; the tool says so and the agent goes on.
- The approval question is written in English; the Allow and Do not allow
  choices are plain options of the existing question card.
- The catalog in the tool description is capped at 64 skills and 240
  characters per description, to keep each step's tool list small.
- Skill lists are read on every step; a server that changes its list is picked
  up on the next step. There is no skills list-changed notice in the spec.
- Browser proof for the end-of-day run: connect a server that implements
  SEP-2640 skills, bind it to an agent, ask for a task one skill covers, choose
  "Allow" on the question card, and check the reply follows the skill. FastMCP's
  `SkillsProvider` uses its own URI layout and is not a valid test server.
