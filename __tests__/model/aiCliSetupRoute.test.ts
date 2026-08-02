/** @jest-environment node */

import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/setup/ai-cli/route';
import { AI_CLI_PACKAGES, buildWingetArgs } from '@/app/api/setup/ai-cli/winget';

describe('AI CLI setup route', () => {
  it('builds a non-shell WinGet invocation from an allow-listed package', () => {
    expect(AI_CLI_PACKAGES.codex.id).toBe('OpenAI.Codex');
    expect(buildWingetArgs('claude')).toEqual([
      'install',
      '--id', 'Anthropic.ClaudeCode',
      '-e',
      '--source', 'winget',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--silent',
    ]);
  });

  it('rejects arbitrary package or command input', async () => {
    const request = new Request('http://localhost:4200/api/setup/ai-cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'powershell', command: 'anything' }),
    }) as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Unknown AI tool' });
  });
});
