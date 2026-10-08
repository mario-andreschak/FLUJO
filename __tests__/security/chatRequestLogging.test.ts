import { NextRequest } from 'next/server';

const mockLog = {
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: (...args: unknown[]) => mockLog.debug(...args),
  info: (...args: unknown[]) => mockLog.info(...args),
  warn: (...args: unknown[]) => mockLog.warn(...args),
  error: (...args: unknown[]) => mockLog.error(...args),
}) }));

import { parseRequestParameters } from '@/app/v1/chat/completions/requestParser';

describe('chat request logging', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['malformed JSON', '{'],
    ['unsupported tool', JSON.stringify({
      model: 'flow-test', messages: [],
      tools: [{ type: 'custom', custom: { name: 'raw_input' } }],
    })],
  ])('keeps credential header values out of logs on %s', async (_label, body) => {
    const secrets = ['synthetic-worker-control-token', 'synthetic-cookie', 'synthetic-extra-api-key'];
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secrets[0]}`,
        cookie: `session=${secrets[1]}`,
        'x-api-key': secrets[2],
      },
      body,
    });

    await expect(parseRequestParameters(request)).rejects.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith('Error parsing request body', expect.objectContaining({
      headerNames: expect.arrayContaining(['authorization', 'cookie', 'x-api-key']),
    }));
    const logged = JSON.stringify(Object.values(mockLog).map(logger => logger.mock.calls));
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });
});
