import type { TranslationKey } from '@/frontend/i18n';

/**
 * Declarative definition of the first-run guided tour (#4).
 *
 * The tour is a coach-mark walkthrough: it highlights a target element on each
 * page, explains the step, and navigates between pages as the user clicks Next.
 * It starts on the dashboard, takes a paced pass through AI Setup and its
 * connection wizard, then follows FLUJO's real dependency chain: create an
 * agent in simple mode -> talk to it. Targets use stable `data-tour` attributes.
 */

export interface TourStep {
  /** Stable id, also used as the `data-tour` value on the target element. */
  id: string;
  /** Route this step lives on. The overlay navigates here before showing it. */
  path: string;
  /**
   * Optional URL, including query parameters, used to prepare the step. The
   * pathname still comes from `path` so targets inside route-driven dialogs
   * can be measured after they open.
   */
  route?: string;
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
    id: 'manage-ai-setup',
    path: '/',
    target: '[data-tour="manage-ai-setup"]',
    placement: 'top',
    title: 'tour.manageAi.title',
    body: 'tour.manageAi.body',
  },
  {
    id: 'nav-models',
    path: '/',
    target: '[data-tour="nav-models"]',
    placement: 'bottom',
    title: 'tour.aiNav.title',
    body: 'tour.aiNav.body',
  },
  {
    id: 'models-overview',
    path: '/models',
    target: '[data-tour="models-overview"]',
    placement: 'center',
    title: 'tour.aiOverview.title',
    body: 'tour.aiOverview.body',
  },
  {
    id: 'add-model',
    path: '/models',
    target: '[data-tour="add-model"]',
    placement: 'bottom',
    title: 'tour.connectAi.title',
    body: 'tour.connectAi.body',
  },
  {
    id: 'ai-setup-wizard',
    path: '/models',
    route: '/models?add=1',
    target: '[data-tour="ai-setup-wizard"]',
    placement: 'right',
    title: 'tour.aiWizard.title',
    body: 'tour.aiWizard.body',
  },
  {
    id: 'dashboard-create-flow',
    path: '/',
    target: '[data-tour="dashboard-create-flow"]',
    placement: 'top',
    title: 'tour.backDashboard.title',
    body: 'tour.backDashboard.body',
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
