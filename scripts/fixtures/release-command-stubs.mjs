// Every child-process call is intercepted. Even a guard regression cannot run
// real git/npm/gh commands, change versions, or publish anything from this test.
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const record = (command) => appendFileSync(process.env.RELEASE_TEST_COMMAND_LOG, `${JSON.stringify(command)}\n`);
for (const method of ['exec', 'execFile', 'execFileSync', 'fork', 'spawn']) {
  childProcess[method] = () => {
    record(`blocked child_process.${method}`);
    throw new Error(`Unexpected child_process.${method} blocked by release test`);
  };
}
childProcess.execSync = (command) => {
  record(command);
  if (command === 'git rev-parse --abbrev-ref HEAD') return 'main\n';
  if (command === 'git status --porcelain') return '';
  if (command === 'git fetch origin main "+refs/tags/v*:refs/tags/v*"') return '';
  if (command === 'git rev-parse main' || command === 'git rev-parse origin/main') return 'synthetic-release-head\n';
  if (command === 'gh auth status') return '';
  if (command === 'npm whoami') return 'synthetic-release-user\n';
  if (command === 'npm view flujo-ai maintainers --json') return '["synthetic-release-user <synthetic@example.invalid>"]';
  if (command === 'npm run build:mcp' || command === 'npm run validate:mcp-release') return '';
  throw new Error(`Unexpected release command blocked by test: ${command}`);
};
childProcess.spawnSync = (command, args) => {
  record([command, ...args].join(' '));
  if (command === 'gh' && args.length === 1 && args[0] === '--version') return { status: 0 };
  throw new Error(`Unexpected release subprocess blocked by test: ${command}`);
};
syncBuiltinESMExports();
