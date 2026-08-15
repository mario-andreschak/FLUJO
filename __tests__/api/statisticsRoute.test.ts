const aggregateStatisticsMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/statistics/aggregation', () => ({
  ...jest.requireActual('@/backend/services/statistics/aggregation'),
  aggregateStatistics: (...args: unknown[]) => aggregateStatisticsMock(...args),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/statistics/route';

describe('GET /api/statistics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertLocalRequestMock.mockReturnValue(null);
    assertUnlockedMock.mockResolvedValue(null);
    aggregateStatisticsMock.mockResolvedValue({
      range: { from: '2026-07-30', to: '2026-07-30' },
      filters: {},
      summary: { runs: 0 },
      daily: [],
      rankings: {},
    });
  });

  it('uses local and encryption guards before returning aggregate-only data', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/statistics?workspace=default-workspace&from=2026-07-30&to=2026-07-30&flowId=flow-1',
    ));

    expect(assertLocalRequestMock).toHaveBeenCalledTimes(1);
    expect(assertUnlockedMock).toHaveBeenCalledTimes(1);
    expect(aggregateStatisticsMock).toHaveBeenCalledWith({
      range: { from: '2026-07-30', to: '2026-07-30' },
      filters: { flowIds: ['flow-1'] },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual(expect.objectContaining({ daily: [], rankings: {} }));
  });

  it('returns safe 400 responses for malformed or unknown query values', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/statistics?from=2026-07-31&to=2026-07-30&prompt=secret',
    ));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'unknown_parameter',
      message: 'Unknown statistics query parameter.',
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(aggregateStatisticsMock).not.toHaveBeenCalled();
  });

  it('short-circuits non-local and encryption-locked requests', async () => {
    assertLocalRequestMock.mockReturnValueOnce(new Response(
      JSON.stringify({ error: 'forbidden' }),
      { status: 403 },
    ));
    const forbidden = await GET(new NextRequest('http://localhost/api/statistics'));
    expect(forbidden.status).toBe(403);
    expect(assertUnlockedMock).not.toHaveBeenCalled();

    assertLocalRequestMock.mockReturnValueOnce(null);
    assertUnlockedMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'encryption_locked' }),
      { status: 423 },
    ));
    const locked = await GET(new NextRequest('http://localhost/api/statistics'));
    expect(locked.status).toBe(423);
    expect(aggregateStatisticsMock).not.toHaveBeenCalled();
  });

  it('does not expose operational error details', async () => {
    aggregateStatisticsMock.mockRejectedValueOnce(
      new Error('C:\\private\\statistics\\2026-07-30.jsonl'),
    );
    const response = await GET(new NextRequest(
      'http://localhost/api/statistics?from=2026-07-30&to=2026-07-30',
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'statistics_unavailable',
      message: 'Statistics are temporarily unavailable.',
    });
    expect(JSON.stringify(body)).not.toContain('private');
  });
});
