import {
  buildStatisticsUrl,
  createDefaultStatisticsFilters,
} from '@/frontend/services/statistics';

describe('statistics frontend service', () => {
  it('creates an inclusive seven-day UTC default range', () => {
    expect(
      createDefaultStatisticsFilters(new Date('2026-07-30T23:59:59Z')),
    ).toEqual({
      range: {
        from: '2026-07-24',
        to: '2026-07-30',
      },
    });
  });

  it('serializes every aggregate filter with the API contract keys', () => {
    const url = buildStatisticsUrl({
      range: { from: '2026-07-24', to: '2026-07-30' },
      flowIds: ['flow-a', 'flow-b'],
      plannedExecutionIds: ['plan-a'],
      sources: ['chat', 'schedule'],
      statuses: ['completed', 'skipped'],
      modelIds: ['model-a'],
      providerIds: ['provider-a'],
      credentialIds: ['cred_opaque'],
    });
    const parsed = new URL(url, 'http://localhost');

    expect(parsed.pathname).toBe('/api/statistics');
    expect(parsed.searchParams.get('from')).toBe('2026-07-24');
    expect(parsed.searchParams.get('to')).toBe('2026-07-30');
    expect(parsed.searchParams.getAll('flowId')).toEqual(['flow-a', 'flow-b']);
    expect(parsed.searchParams.getAll('plannedExecutionId')).toEqual(['plan-a']);
    expect(parsed.searchParams.getAll('source')).toEqual(['chat', 'schedule']);
    expect(parsed.searchParams.getAll('status')).toEqual(['completed', 'skipped']);
    expect(parsed.searchParams.getAll('modelId')).toEqual(['model-a']);
    expect(parsed.searchParams.getAll('providerId')).toEqual(['provider-a']);
    expect(parsed.searchParams.getAll('credentialId')).toEqual(['cred_opaque']);
  });
});
