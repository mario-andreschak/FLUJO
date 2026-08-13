/* eslint-disable @typescript-eslint/no-require-imports -- Node bootstrap script must run before ESM/Jest resolution. */
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TEST_ARTIFACTS = Object.freeze([
  {
    name: 'Jest',
    lockKey: 'node_modules/jest',
    relativePath: 'node_modules/jest/bin/jest.js',
  },
  {
    name: 'Next.js Jest bridge',
    lockKey: 'node_modules/next',
    relativePath: 'node_modules/next/jest.js',
  },
  {
    name: 'Jest jsdom environment',
    lockKey: 'node_modules/jest-environment-jsdom',
    relativePath: 'node_modules/jest-environment-jsdom/package.json',
  },
  {
    name: 'MCP stdio OAuth Jest adapter target',
    lockKey: 'node_modules/mcp-stdio-oauth',
    relativePath: 'node_modules/mcp-stdio-oauth/dist/client/index.js',
  },
]);

function readJson(filePath, label, issues) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push(`${label} is unavailable or invalid: ${detail}`);
    return null;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Verify that a checkout has its own complete npm install.
 *
 * Node and npm normally walk parent directories looking for node_modules. That
 * is convenient for ordinary development, but it makes a nested test checkout
 * silently borrow the host repository's Jest/Next installation. Comparing the
 * checkout's lockfile with node_modules/.package-lock.json gives us a cheap,
 * deterministic boundary before Jest loads any configuration or source files.
 */
function inspectLocalTestDependencies(rootDir) {
  const root = path.resolve(rootDir);
  const nodeModules = path.join(root, 'node_modules');
  const issues = [];
  const lockfile = readJson(path.join(root, 'package-lock.json'), 'package-lock.json', issues);
  const installedLockfile = readJson(
    path.join(nodeModules, '.package-lock.json'),
    'node_modules/.package-lock.json',
    issues,
  );

  if (lockfile?.packages && installedLockfile?.packages) {
    const missing = [];
    const mismatched = [];
    for (const [key, expected] of Object.entries(lockfile.packages)) {
      if (!key.startsWith('node_modules/') || expected?.optional === true) continue;
      const installed = installedLockfile.packages[key];
      if (!installed) {
        missing.push(key.slice('node_modules/'.length));
        continue;
      }
      if (expected.version && installed.version !== expected.version) {
        mismatched.push(`${key.slice('node_modules/'.length)} (${installed.version ?? 'unknown'} != ${expected.version})`);
      }
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 8).join(', ');
      issues.push(
        `local install is missing ${missing.length} lockfile package${missing.length === 1 ? '' : 's'}: ${preview}${missing.length > 8 ? ', …' : ''}`,
      );
    }
    if (mismatched.length > 0) {
      const preview = mismatched.slice(0, 8).join(', ');
      issues.push(
        `local install has ${mismatched.length} version mismatch${mismatched.length === 1 ? '' : 'es'}: ${preview}${mismatched.length > 8 ? ', …' : ''}`,
      );
    }
  }

  for (const artifact of REQUIRED_TEST_ARTIFACTS) {
    const artifactPath = path.join(root, artifact.relativePath);
    if (!fs.existsSync(artifactPath)) {
      issues.push(`${artifact.name} is missing at ${artifact.relativePath}`);
      continue;
    }
    let realArtifact;
    try {
      realArtifact = fs.realpathSync(artifactPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(`${artifact.name} cannot be resolved locally: ${detail}`);
      continue;
    }
    if (!isInside(nodeModules, realArtifact)) {
      issues.push(`${artifact.name} escapes this checkout's node_modules: ${realArtifact}`);
    }
  }

  return {
    root,
    nodeModules,
    jestBin: path.join(root, REQUIRED_TEST_ARTIFACTS[0].relativePath),
    issues,
  };
}

function formatDependencyError(result) {
  return [
    `FLUJO test dependencies are not installed locally in ${result.root}.`,
    ...result.issues.map((issue) => `- ${issue}`),
    '',
    'Refusing to use an ancestor node_modules because that makes isolated-worktree test results non-deterministic.',
    'Run `npm ci --include=dev` in this checkout, then retry the test command.',
  ].join('\n');
}

function assertLocalTestDependencies(rootDir) {
  const result = inspectLocalTestDependencies(rootDir);
  if (result.issues.length > 0) {
    const error = new Error(formatDependencyError(result));
    error.code = 'FLUJO_LOCAL_TEST_DEPENDENCIES';
    throw error;
  }
  return result;
}

module.exports = {
  REQUIRED_TEST_ARTIFACTS,
  assertLocalTestDependencies,
  formatDependencyError,
  inspectLocalTestDependencies,
};

if (require.main === module) {
  try {
    const result = assertLocalTestDependencies(path.resolve(__dirname, '..'));
    process.stdout.write(`Local test dependencies are complete in ${result.root}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
