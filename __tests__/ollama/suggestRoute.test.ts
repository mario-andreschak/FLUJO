/**
 * @jest-environment node
 *
 * The suggest route is a stateless wrapper over suggestModel that takes the
 * hardware as query params (bytes or GB), so another app can get a suggestion for
 * its own machine. Covers param parsing, the GB convenience form, VRAM binding,
 * and validation.
 */
import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/local-models/suggest/route';

function getRequest(query: string): NextRequest {
  return new Request(
    `http://localhost:4200/api/local-models/suggest${query}`
  ) as unknown as NextRequest;
}

async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('GET /api/local-models/suggest', () => {
  it('suggests from ramGB', async () => {
    const res = await GET(getRequest('?ramGB=12'));
    expect(res.status).toBe(200);
    expect((await body(res)).suggestedModel).toBe('llama3.2:3b');
  });

  it('accepts ramBytes and echoes the inputs', async () => {
    const res = await GET(getRequest(`?ramBytes=${24 * 1024 * 1024 * 1024}`));
    const b = await body(res);
    expect(b.suggestedModel).toBe('qwen2.5:7b');
    expect(b.totalRamBytes).toBe(24 * 1024 * 1024 * 1024);
    expect(b.vramBytes).toBeNull();
  });

  it('lets VRAM bind the suggestion below what RAM alone would give', async () => {
    const res = await GET(getRequest('?ramGB=64&vramGB=6'));
    expect((await body(res)).suggestedModel).toBe('llama3.2:1b');
  });

  it('400s when no RAM param is given', async () => {
    const res = await GET(getRequest(''));
    expect(res.status).toBe(400);
  });

  it('400s on a non-numeric RAM param', async () => {
    const res = await GET(getRequest('?ramGB=lots'));
    expect(res.status).toBe(400);
  });
});
