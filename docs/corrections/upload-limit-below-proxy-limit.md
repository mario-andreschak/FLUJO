# A file upload limit stays below what FLUJO's request proxy keeps of a body (`proxyClientMaxBodySize` in `next.config.mjs`); a bigger body reaches the route cut off

Enforced by:
- `MCPB_UPLOAD_CEILING_BYTES` check in `__tests__/mcp/mcpbBundle.test.ts`
