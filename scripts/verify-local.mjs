import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CRITICAL_TEST_FILES } from './required-check-workflow.mjs';
export function localVerificationCommands({ full = false, install = false, testsOnly = false, isolated = false } = {}) {
  if (isolated && !full) throw new Error('--isolated requires --full and a prepared Docker/process environment.');
  const commands = [];
  const npm = (...args) => commands.push({ tool: 'npm', args });
  const node = (...args) => commands.push({ tool: 'node', args });
  if (install) npm('ci', '--include=dev');
  node('--test', 'scripts/verification-contract.test.mjs', 'scripts/workflow-contract.test.mjs', 'scripts/required-check-workflow.test.mjs', 'scripts/verify-repository-rules.test.mjs', 'scripts/require-release-verification.test.mjs', 'scripts/release-verification.test.mjs', 'scripts/verify-codex-built-import.test.mjs');
  if (!testsOnly) { npm('run', 'build'); node('scripts/verify-codex-built-import.mjs'); npm('run', 'typecheck:mcp'); npm('run', 'validate:mcp-release'); }
  node('scripts/run-local-jest.cjs', '--ci', '--selectProjects', 'node', '--runInBand', '--runTestsByPath', ...CRITICAL_TEST_FILES);
  if (full) {
    npm('run', 'typecheck'); npm('run', 'lint:all'); npm('audit', '--include=dev', '--audit-level=high');
    npm('run', 'smoke:mcp-artifacts'); npm('run', 'test:ci');
    npm('run', 'verify:test-baseline', '--', '--stage=ci', '--results=jest-results.json');
    if (isolated) { npm('run', 'test:isolated'); npm('run', 'verify:test-baseline', '--', '--stage=isolated', '--results=jest-results-isolated.json'); }
  }
  return commands;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/verify-local.mjs [--install] [--full] [--isolated] [--tests-only]');
    console.log('Default: one build, release inventory, contracts and critical regressions. --full adds type/lint/security/full Jest/packed smoke; --isolated adds separately prepared process suites. --tests-only reuses existing local build artifacts.');
  } else {
    if (args.some(arg => !['--install', '--full', '--isolated', '--tests-only'].includes(arg))) throw new Error('Unknown local verification option.');
    for (const command of localVerificationCommands({ full: args.includes('--full'), install: args.includes('--install'), testsOnly: args.includes('--tests-only'), isolated: args.includes('--isolated') })) {
      console.log('Running:', command.tool, ...command.args);
      let executable = process.execPath;
      let commandArgs = command.args;
      if (command.tool === 'npm') {
        const cli = process.env.npm_execpath || (process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        commandArgs = [cli, ...commandArgs];
      }
      const result = spawnSync(executable, commandArgs, { stdio: 'inherit', windowsHide: true, env: process.env });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
