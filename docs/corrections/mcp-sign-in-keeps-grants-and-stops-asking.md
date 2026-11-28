# MCP sign-in keeps a good grant, finishes a step-up in one consent, stops asking when consent cannot help, and revokes the grant on reset

Found by running FLUJO against a real authorization server instead of scripted
replies (#1093): one "service unavailable" from the token endpoint made FLUJO
ask for a new sign-in although the grant was fine; Authenticate refreshed the
old grant and dropped the one-more-scope sign-in a tool had prepared; a server
that refused a scope FLUJO already held got endless consent pages; reset left
the refresh token alive at the provider.

Enforced by:
- `__tests__/mcp/oauthReferenceServer.test.ts`
- `__tests__/mcp/mcpClientConformance.test.ts`
- `createMcpChecks` in `scripts/packaged-acceptance/mcp-checks.mjs`
