/**
 * What a person chose for each place that still uses something they delete:
 * a flow, a Connected App (MCP server), or a package's flows and apps
 * (#1389). Every place is answered by its stable key, and the thing itself is
 * deleted only after every place switched or let it go.
 */

export type UseChoice =
  | { replaceWith: string }
  | { remove: true };

export interface DeletePlan {
  /** One answer for each place key. */
  choices: Record<string, UseChoice>;
}

const MAX_CHOICES = 1000;
const MAX_KEY_LENGTH = 600;

export function isUseChoice(value: unknown): value is UseChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>;
  if (Object.keys(choice).length !== 1) return false;
  if (choice.remove === true) return true;
  return typeof choice.replaceWith === 'string' && choice.replaceWith.trim().length > 0;
}

/** Read `{ choices }` from untrusted input; `'invalid'` when it does not fit. */
export function readDeletePlan(plan: unknown): DeletePlan | 'invalid' {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return 'invalid';
  const choices = (plan as { choices?: unknown }).choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return 'invalid';
  const entries = Object.entries(choices as Record<string, unknown>);
  if (entries.length > MAX_CHOICES || !entries.every(([key, choice]) => key.length <= MAX_KEY_LENGTH && isUseChoice(choice))) {
    return 'invalid';
  }
  return { choices: Object.fromEntries(entries) as Record<string, UseChoice> };
}

/** Read `{ plan: { choices } }` from an untrusted request body; `null` when no plan was sent. */
export function parseDeletePlan(value: unknown): DeletePlan | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const plan = (value as { plan?: unknown }).plan;
  if (plan === undefined) return null;
  return readDeletePlan(plan);
}

/** Whether `plan` answers every place, and only with what each place allows. */
export function planAnswersEvery(
  uses: ReadonlyArray<{ key: string; canRemove: boolean }>,
  plan: DeletePlan,
): boolean {
  return uses.every((use) => {
    const choice = plan.choices[use.key];
    return Boolean(choice) && ('replaceWith' in choice || use.canRemove);
  });
}
