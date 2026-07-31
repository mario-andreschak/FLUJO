/**
 * Declarative definition of the first-run guided tour (#4).
 *
 * The tour is a coach-mark walkthrough: it highlights a target element on each
 * page, explains the step, and navigates between pages as the user clicks Next.
 * It follows FLUJO's real dependency chain: connect AI -> create an agent
 * in simple mode -> talk to it. Targets use stable `data-tour` attributes.
 */

export interface TourStep {
  /** Stable id, also used as the `data-tour` value on the target element. */
  id: string;
  /** Route this step lives on. The overlay navigates here before showing it. */
  path: string;
  /**
   * CSS selector for the element to spotlight. When omitted (or not found in
   * the DOM), the step renders as a centered card with no spotlight.
   */
  target?: string;
  title: string;
  /** Body copy. Plain strings; rendered as paragraphs split on blank lines. */
  body: string;
  /** Preferred placement of the card relative to the target. */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'add-model',
    path: '/models',
    target: '[data-tour="add-model"]',
    placement: 'bottom',
    title: '1. Start by connecting your AI',
    body:
      'This is the one required setup step: every agent and conversation needs an AI model.\n\n' +
      'Choose “Connect AI,” select the provider you use, and follow the connection steps. Recommended settings are already selected.',
  },
  {
    id: 'new-flow',
    path: '/flows',
    target: '[data-tour="new-flow"]',
    placement: 'bottom',
    title: '2. Create your first agent',
    body:
      'Choose “Start simple” to open the easy recipe builder. Give your agent a name, then explain each job in everyday language.\n\n' +
      'FLUJO handles the technical start, finish, and connections for you. You can open the expert editor later if you ever need it.',
  },
  {
    id: 'chat-input',
    path: '/chat',
    target: '[data-tour="chat-input"]',
    placement: 'top',
    title: '3. Talk to your agent',
    body:
      'Choose the agent you just created, type a real request, and send it. That is the full setup.\n\n' +
      'Connected Apps are optional; add one later only when an agent needs files or another service.',
  },
];
