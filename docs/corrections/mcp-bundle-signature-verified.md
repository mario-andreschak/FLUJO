# An MCP bundle counts as signed only after its PKCS#7 signature is checked against the file, its certificate and a trusted authority; a signature that does not hold up refuses the install

Finding a signature block proves nothing: anyone can append one. The official
`mcpb` tool's own check cannot succeed (node-forge's PKCS#7 `verify()` throws
"not yet implemented"), so FLUJO checks the signature itself with Node's
crypto, and keeps a bundle signed by the official tool among its tests.

Enforced by:
- `__tests__/mcp/mcpbSignature.test.ts`
- `checkMcpbSignature` in `src/backend/services/mcp/mcpb/signature.ts`
- `__tests__/mcp/mcpbBundle.test.ts`
