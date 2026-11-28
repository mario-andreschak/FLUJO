# A Connected App someone deletes is removed only after every flow, Persona and automation that uses it switched to another app or let it go; a package uninstall asks the same before removing its flows and apps

Deleting an MCP server used to go through at once, and package uninstall
deleted its flows and servers without looking, so agents, Personas and
automations were left pointing at something that was gone (#1389). Server code
deletes a server only through `deleteMcpServerAndMoveUses` and a flow only
through `deleteFlowAndMoveUses`; reading a Persona never fails because an app
it names is gone, it reports `appIssues` instead.

Since #571 split the MCP service, the raw removal lives in
`src/backend/services/mcp/serverConfigUpdate.ts`. Only the service imports that
module, and `mcpService.deleteServerConfig` hands the removal over in one call,
so a split cannot open a second way around the check.

Enforced by:
- `deleteMcpServerAndMoveUses` in `src/backend/services/mcp/serverDeletion.ts`
- `__tests__/architecture/flowDeleteSingleEntry.test.ts` (its allowed lists only shrink)
- `__tests__/mcp/mcpServerDeleteInUse.test.ts`, `__tests__/packages/uninstallPackage.test.ts`
