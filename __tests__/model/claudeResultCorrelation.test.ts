import { ClaudeResultCorrelation } from '@/backend/services/model/adapters/claudeResultCorrelation';

it('settles merged sends from attribution rather than a one-result-per-send counter', () => {
  const turns = new ClaudeResultCorrelation();
  turns.submitted('first'); turns.submitted('second'); turns.submitted('third');
  expect(turns.result({ uuid: 'r1', result_index: 1, user_message_uuids: ['first', 'second'], queued_turn_count: 1 }).settled).toBe(false);
  expect(turns.pendingCount).toBe(1);
  expect(turns.result({ uuid: 'r1', result_index: 1, user_message_uuids: ['third'] }).duplicate).toBe(true);
  expect(turns.pendingCount).toBe(1);
  expect(turns.result({ uuid: 'background', result_index: 2, user_message_uuid: 'unknown' }).settled).toBe(false);
  expect(turns.result({ uuid: 'r3', result_index: 3, user_message_uuid: 'third', queued_turn_count: 0 }).settled).toBe(true);
});

it('uses a conservative oldest-send fallback for producers without attribution', () => {
  const turns = new ClaudeResultCorrelation();
  turns.submitted('first'); turns.submitted('second');
  expect(turns.result({ uuid: 'r1', queued_turn_count: 1 }).settled).toBe(false);
  expect(turns.result({ uuid: 'r2' }).settled).toBe(true);
});
