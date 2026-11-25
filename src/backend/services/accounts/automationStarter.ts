import { currentAccountPrincipal } from './context';

/**
 * Who set up an automation (#575). A schedule or trigger body never decides
 * this itself: any `startedBy` it carries is dropped, and in multi-user mode
 * the signed-in person behind the request is recorded instead. With the mode
 * off there is no signed-in person, so nothing is added and the stored data
 * stays exactly as before.
 *
 * The scheduler passes `startedBy` to `backgroundWorkPause`, so automatic runs
 * pause while that person may not run things in the workspace (removed from
 * the team, made a viewer, turned off) and resume by themselves when they may
 * again, or once someone who may changes the automation.
 */
export function withAutomationStarter<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { startedBy: _ignored, ...rest } = body as Record<string, unknown>;
  const principal = currentAccountPrincipal();
  return (principal ? { ...rest, startedBy: principal.userId } : rest) as T;
}
