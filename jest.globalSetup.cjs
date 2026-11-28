// Tests that create a workspace copy the bundled MCP packages, so a fresh
// checkout builds them once here instead of failing far from the cause.
const { ensureBundledMcpBuilt } = require('./scripts/bundled-mcp-build.cjs');
const { createPrivateTestTemp, removePrivateTestTempNow } = require('./scripts/private-test-temp.cjs');

const STATE = Symbol.for('flujo.jest.privateTestTemp');

function removeOnExit() {
  removePrivateTestTempNow(globalThis[STATE]);
}

module.exports = async function globalSetup(globalConfig) {
  await ensureBundledMcpBuilt(globalConfig.rootDir);
  // Every run gets its own temp root that FLUJO's privacy check accepts. Jest
  // workers start after this hook and inherit the redirected variables.
  const state = await createPrivateTestTemp({
    rootDir: globalConfig.rootDir,
    // Jest transpiles TypeScript that is required while this hook runs.
    inspectWindows: (file) => require('./src/backend/services/security/windowsPrivateAuthority.ts')
      .windowsPrivateAuthorityStampAsync(file),
  });
  globalThis[STATE] = state;
  process.removeListener('exit', removeOnExit);
  process.once('exit', removeOnExit);
  if (!state.private) {
    console.warn(`[jest] No temp folder private to this account was found, so tests that write approval files will fail. ${state.problems.join('; ')}`);
  }
};
