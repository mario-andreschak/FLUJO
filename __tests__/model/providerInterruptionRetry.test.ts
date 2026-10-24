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
