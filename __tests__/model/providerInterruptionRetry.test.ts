import { planAutomaticRetry } from '@/backend/execution/flow/retryAfter';

it.each(['server_error', 'provider_response_not_completed', 'provider_stream_incomplete', 'internal_server_error'])(
  'plans bounded recovery for %s with exponential delay', code => {
    expect(planAutomaticRetry({ message: 'interrupted', details: { code } }, { now: 100, retriesUsed: 0 }))
      .toMatchObject({ delayMs: 1000, retryAt: 1100, reason: 'provider_interruption' });
    expect(planAutomaticRetry({ message: 'interrupted', details: { code } }, { retriesUsed: 2 })?.delayMs).toBe(4000);
  });

it.each(['invalid_prompt', 'insufficient_quota', 'context_length_exceeded', 'invalid_api_key', 'content_filter'])(
  'does not blindly replay %s', code => {
    expect(planAutomaticRetry({ message: 'failed', details: { code } })).toBeUndefined();
  });

it.each([400, 401, 402, 403, 429])('does not turn HTTP %s into an interruption retry', status => {
  expect(planAutomaticRetry({ message: 'failed', details: { code: 'server_error', status } })).toBeUndefined();
});

// #757: vLLM answered "503 status code (no body)" while it loaded its model, and the run ended.
it.each([502, 503, 504])('waits for a model server that answers HTTP %s while it starts, about a minute in all', status => {
  const failure = { message: `${status} status code (no body)`, details: { status } };
  const delays = [0, 1, 2].map(retriesUsed => planAutomaticRetry(failure, { now: 100, retriesUsed }));
  expect(delays.map(plan => plan?.reason)).toEqual(['provider_interruption', 'provider_interruption', 'provider_interruption']);
  expect(delays.map(plan => plan?.delayMs)).toEqual([5_000, 15_000, 40_000]);
  expect(delays[0]?.retryAt).toBe(5_100);
});

it('follows the Retry-After a starting model server announces, up to the longest wait', () => {
  expect(planAutomaticRetry({ message: 'unavailable', details: { status: 503, retryAfter: '2' } }, { now: 0 })?.delayMs).toBe(2_000);
  expect(planAutomaticRetry({ message: 'unavailable', details: { status: 503, retryAfter: '3600' } }, { now: 0 })?.delayMs).toBe(40_000);
});
