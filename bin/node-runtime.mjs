/** The public app and MCP packages require the corrected Windows libuv metadata. */
export const SUPPORTED_NODE_RANGE = '^22.17.0 || ^24.2.0';

export function isSupportedNodeRuntime(version) {
  if (typeof version !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part <= 2_147_483_647)) return false;
  return (major === 22 && minor >= 17) || (major === 24 && minor >= 2);
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (isSupportedNodeRuntime(version)) return;
  const error = new Error('FLUJO requires Node.js 22.17+ within 22.x, or 24.2+ within 24.x. Upgrade to a current patched release on either supported line before starting FLUJO or its MCP servers (native filesystem compatibility).');
  error.code = 'UNSUPPORTED_NODE_RUNTIME';
  throw error;
}
