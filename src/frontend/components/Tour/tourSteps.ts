import type { TranslationKey } from '@/frontend/i18n';

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
  title: TranslationKey;
  /** Body copy. Plain strings; rendered as paragraphs split on blank lines. */
  body: TranslationKey;
  /** Preferred placement of the card relative to the target. */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'add-model',
    path: '/models',
    target: '[data-tour="add-model"]',
    placement: 'bottom',
    title: 'tour.connectAi.title',
    body: 'tour.connectAi.body',
  },
  {
    id: 'new-flow',
    path: '/flows',
    target: '[data-tour="new-flow"]',
    placement: 'bottom',
    title: 'tour.createAgent.title',
    body: 'tour.createAgent.body',
  },
  {
    id: 'chat-input',
    path: '/chat',
    target: '[data-tour="chat-input"]',
    placement: 'top',
    title: 'tour.talk.title',
    body: 'tour.talk.body',
  },
];
