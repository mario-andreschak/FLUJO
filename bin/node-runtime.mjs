/** The public app and MCP packages require the corrected Windows libuv metadata. */
export const SUPPORTED_NODE_RANGE = '^22.17.0 || ^24.2.0';

export function nodeRuntimeDiagnostic(version = process.versions.node, executable = process.execPath) {
  const displayVersion = typeof version === 'string' && /^v?\d+\.\d+\.\d+$/.test(version)
    ? `v${version.replace(/^v/, '').slice(0, 64)}` : 'an unrecognized version';
  const displayPath = String(executable).replace(/[\x00-\x1f\x7f-\x9f]/g, '?').slice(0, 512);
  return `FLUJO cannot start with Node.js ${displayVersion}.\nActive executable: ${displayPath}\n`
    + 'Use a current patched release of Node.js 22.x (22.17+) or 24.x (24.2+) for native filesystem compatibility.';
}

export function nodeRuntimeManualSteps(platform = process.platform) {
  return [
    'Manual update:',
    '  1. Install a current patched Node.js 22.x or 24.x from https://nodejs.org/en/download.',
    ...(platform === 'win32'
      ? ['     With Windows Package Manager: winget install --id OpenJS.NodeJS.22 --exact --source winget']
      : ['     If you use nvm: nvm install 22 && nvm use 22']),
    '  2. Close and reopen your terminal, then check: node --version',
    platform === 'win32' ? '     Check the active executable: Get-Command node -All' : '     Check the active executable: command -v node',
    '  3. If the old version is still active, put the new installation first on PATH or activate it with your Node version manager.',
    '     Retry the same FLUJO or MCP command after a supported version is active.',
  ].join('\n');
}

export function isSupportedNodeRuntime(version) {
  if (typeof version !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part <= 2_147_483_647)) return false;
  return (major === 22 && minor >= 17) || (major === 24 && minor >= 2);
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (isSupportedNodeRuntime(version)) return;
  const error = new Error(`${nodeRuntimeDiagnostic(version)}\n\n${nodeRuntimeManualSteps()}`);
  error.code = 'UNSUPPORTED_NODE_RUNTIME';
  throw error;
}
