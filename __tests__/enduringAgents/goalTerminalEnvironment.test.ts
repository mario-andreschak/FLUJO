import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runWithWorkspace } from '@/utils/workspace';
import { resolveTrustedHostLaunch } from '@/backend/services/mcp/trustedHost';
import { installApprovedGoalMcp } from './fixtures/approvedGoalMcp';
import terminalFixture from '../../scripts/persona-goal-acceptance/terminal-fixture.cjs';

it('executes Node and npm through the approved terminal with its reduced environment and packaged observer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-goal-terminal-grant-'));
  const client = new Client({ name: 'terminal-environment-regression', version: '1.0.0' });
  let installed: ReturnType<typeof installApprovedGoalMcp> | undefined;
  const priorSecret = process.env.FLUJO_TERMINAL_TEST_SECRET;
  process.env.FLUJO_TERMINAL_TEST_SECRET = 'must-not-be-inherited';
  try {
    await runWithWorkspace(`terminal-environment-${process.pid}`, async () => {
      await terminalFixture.createFixture(directory, 0);
      await fs.writeFile(path.join(directory, 'probe.cjs'),
        'console.log(JSON.stringify({node:process.execPath,secret:!!process.env.FLUJO_TERMINAL_TEST_SECRET,observer:process.env.NODE_OPTIONS}));');
      installed = installApprovedGoalMcp(directory, true, 30_000);
      const launch = resolveTrustedHostLaunch(installed.config);
      await client.connect(new StdioClientTransport({ ...launch, stderr: 'pipe' }));
      const result = await client.callTool({ name: 'terminal', arguments: { command: 'node probe.cjs', timeoutMs: 10_000 } });
      const output = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(result.isError ? result.content : undefined).toBeUndefined();
      expect(output.exitCode).toBe(0);
      const observed = JSON.parse(output.stdout.trim());
      expect(observed.node).toBe(process.execPath);
      expect(observed.secret).toBe(false);
      expect(observed.observer).toContain('browser-observer.cjs');
      const npm = await client.callTool({ name: 'terminal', arguments: {
        command: process.platform === 'win32' ? 'npm.cmd --version' : 'npm --version', timeoutMs: 10_000,
      } });
      expect(npm.isError ? npm.content : undefined).toBeUndefined();
      const npmOutput = JSON.parse((npm.content as Array<{ text: string }>)[0].text);
      expect(npmOutput.exitCode).toBe(0);
      expect(npmOutput.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  } finally {
    await client.close();
    installed?.restore();
    if (priorSecret === undefined) delete process.env.FLUJO_TERMINAL_TEST_SECRET;
    else process.env.FLUJO_TERMINAL_TEST_SECRET = priorSecret;
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45_000);
