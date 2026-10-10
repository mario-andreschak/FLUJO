import assert from 'node:assert/strict';
import test from 'node:test';
import { localVerificationCommands } from './verify-local.mjs';
test('local qualification installs and builds once, then tests real files', () => {
 const commands = localVerificationCommands({ install: true });
 assert.equal(commands.filter(command => command.args.join(' ') === 'ci --include=dev').length, 1);
 assert.equal(commands.filter(command => command.args.join(' ') === 'run build').length, 1);
 assert.ok(commands.find(command => command.args.includes('--runTestsByPath')));
 const critical = commands.filter(command => command.args.includes('--runTestsByPath'));
 assert.ok(critical.some(command => command.args.includes('node')));
 assert.ok(critical.some(command => command.args.includes('jsdom') && command.args.includes('__tests__/frontend/components/PersonaCreationWizard.test.tsx')));
});
test('full local work remains explicit and isolation requires prepared full qualification', () => {
 const commands = localVerificationCommands({ full: true, isolated: true });
 for (const script of ['typecheck', 'lint:all', 'test:ci', 'test:isolated', 'smoke:mcp-artifacts']) assert.ok(commands.some(command => command.args.includes(script)));
 assert.throws(() => localVerificationCommands({ isolated: true }));
 assert.equal(localVerificationCommands({ testsOnly: true }).some(command => command.args.includes('build')), false);
});
