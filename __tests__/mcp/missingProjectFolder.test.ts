/**
 * A chat whose project folder was deleted, renamed or sits on a drive that is
 * not connected: the shipped bash and filesystem tools name the folder and say
 * how to pick another one, instead of `spawn powershell ENOENT`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { itWithRealShell, requireRealShellResult } from '../helpers/childProcessCapability';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerRoots: jest.fn() }));

import { loadServerRoots } from '@/backend/services/mcp/config';
import { runWithProjectDir } from '@flujo-ai/mcp-shared';
import {
  bashCallTool as uncheckedBashCallTool,
  _resetBashSessionsForTests,
} from '@/backend/services/mcp/internal/bashTools';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';

const mockedRoots = loadServerRoots as jest.Mock;
const bashCallTool = (...args: Parameters<typeof uncheckedBashCallTool>) =>
  requireRealShellResult(uncheckedBashCallTool(...args));
const text = (result: CallToolResult) => (result.content[0] as { text: string }).text;
const bashError = (result: CallToolResult) => (JSON.parse(text(result)) as { error: string }).error;

describe('a chat project folder that is gone', () => {
  let dir: string;
  let gone: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-missing-project-')));
    gone = path.join(dir, 'deleted-project');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'still here', 'utf8');
    mockedRoots.mockResolvedValue([dir]);
  });

  afterEach(async () => {
    await _resetBashSessionsForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes bash name the folder instead of failing to start the shell', async () => {
    const result = await runWithProjectDir(gone, () => bashCallTool('run', { command: 'echo hi' }));
    expect(result.isError).toBe(true);
    expect(bashError(result)).toContain(`project folder "${gone}" cannot be found`);
    expect(bashError(result)).toMatch(/pick another folder/i);
    expect(bashError(result)).not.toMatch(/ENOENT/);
  });

  it('also names a folder whose drive is gone, even outside the roots', async () => {
    const unplugged = path.join(os.tmpdir(), `flujo-unplugged-${process.pid}`, 'project');
    const result = await runWithProjectDir(unplugged, () => bashCallTool('run', { command: 'echo hi' }));
    expect(bashError(result)).toContain(`project folder "${unplugged}" cannot be found`);
  });

  it('says a missing working folder the agent asked for does not exist', async () => {
    const missing = path.join(dir, 'nope');
    const result = await bashCallTool('run', { command: 'echo hi', cwd: missing });
    expect(result.isError).toBe(true);
    expect(bashError(result)).toContain(`working folder "${missing}" does not exist`);
  });

  itWithRealShell('still runs commands in a folder the agent names in full', async () => {
    const result = await runWithProjectDir(gone, () => bashCallTool('run', { command: 'echo hi', cwd: dir }));
    expect(result.isError).toBeFalsy();
  });

  it('makes the filesystem tools name the folder for relative paths', async () => {
    const result = await runWithProjectDir(gone, () => filesystemCallTool('read_file', { path: 'notes.txt' }));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('cannot be found');
    expect(text(result)).toContain(path.basename(gone));
  });

  it('keeps full paths working in the filesystem tools', async () => {
    const result = await runWithProjectDir(gone, () => filesystemCallTool('read_file', { path: path.join(dir, 'notes.txt') }));
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('still here');
  });
});
