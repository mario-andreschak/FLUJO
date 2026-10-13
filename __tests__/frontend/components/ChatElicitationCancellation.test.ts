import { cancelPendingElicitation, clearPendingQuestion, shouldHydratePendingInputs } from '@/frontend/components/Chat/elicitationState';
it('clears exactly the cancelled prompt and retains a newer form', () => {
  const pending = {elicitationId:'current',message:'new prompt'};
  expect(cancelPendingElicitation(pending,'current')).toBeNull();
  expect(cancelPendingElicitation(pending,'older')).toBe(pending);
  expect(cancelPendingElicitation(null,'older')).toBeNull();
});

it('clears only the resolved question while retaining a newer question', () => {
  const pending = { questionId: 'current', questions: [] };
  expect(clearPendingQuestion(pending, 'old')).toBe(pending);
  expect(clearPendingQuestion(pending, 'current')).toBeNull();
});

it('hydrates only a snapshot newer than the viewed conversation input events', () => {
  expect(shouldHydratePendingInputs('one', 'one', 11, 10)).toBe(true);
  expect(shouldHydratePendingInputs('one', 'one', 10, 10)).toBe(false);
  expect(shouldHydratePendingInputs('one', 'one', 9, 10)).toBe(false);
  expect(shouldHydratePendingInputs('one', 'other', 11, 10)).toBe(false);
  expect(shouldHydratePendingInputs(null, 'one', 11, 10)).toBe(false);
  expect(shouldHydratePendingInputs('one', 'one', NaN, 10)).toBe(false);
});
