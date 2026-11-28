// Tests that create a workspace copy the bundled MCP packages, so a fresh
// checkout builds them once here instead of failing far from the cause.
const { ensureBundledMcpBuilt } = require('./scripts/bundled-mcp-build.cjs');

module.exports = async function globalSetup(globalConfig) {
  await ensureBundledMcpBuilt(globalConfig.rootDir);
};
