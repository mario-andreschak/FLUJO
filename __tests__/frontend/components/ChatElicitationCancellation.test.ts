import { cancelPendingElicitation } from '@/frontend/components/Chat/elicitationState';
it('clears exactly the cancelled prompt and retains a newer form', () => {
  const pending = {elicitationId:'current',message:'new prompt'};
  expect(cancelPendingElicitation(pending,'current')).toBeNull();
  expect(cancelPendingElicitation(pending,'older')).toBe(pending);
  expect(cancelPendingElicitation(null,'older')).toBeNull();
});
