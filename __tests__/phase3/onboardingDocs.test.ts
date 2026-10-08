import { TOUR_STEPS } from '@/frontend/components/Tour/tourSteps';
import { API_GROUPS } from '@/frontend/components/Docs/apiReference';

describe('onboarding tour steps (#4)', () => {
  it('has unique step ids', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every step has a non-empty title, body, and an absolute path', () => {
    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.path.startsWith('/')).toBe(true);
    }
  });

  it('every targeted step uses a [data-tour="..."] selector', () => {
    const targeted = TOUR_STEPS.filter((s) => s.target);
    expect(targeted.length).toBeGreaterThan(0);
    for (const step of targeted) {
      expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/);
    }
  });

  it('takes a paced path through AI setup before the simple builder and Talk', () => {
    expect(TOUR_STEPS.map(({ id, path, route, target }) => ({ id, path, route, target }))).toEqual([
      {
        id: 'manage-ai-setup',
        path: '/',
        route: undefined,
        target: '[data-tour="manage-ai-setup"]',
      },
      {
        id: 'nav-models',
        path: '/',
        route: undefined,
        target: '[data-tour="nav-models"]',
      },
      {
        id: 'models-overview',
        path: '/models',
        route: undefined,
        target: '[data-tour="models-overview"]',
      },
      {
        id: 'add-model',
        path: '/models',
        route: undefined,
        target: '[data-tour="add-model"]',
      },
      {
        id: 'ai-setup-wizard',
        path: '/models',
        route: '/models?add=1',
        target: '[data-tour="ai-setup-wizard"]',
      },
      {
        id: 'dashboard-create-flow',
        path: '/',
        route: undefined,
        target: '[data-tour="dashboard-create-flow"]',
      },
      {
        id: 'new-flow',
        path: '/flows',
        route: undefined,
        target: '[data-tour="new-flow"]',
      },
      {
        id: 'chat-input',
        path: '/chat',
        route: undefined,
        target: '[data-tour="chat-input"]',
      },
    ]);
    expect(TOUR_STEPS.map((step) => step.title)).toEqual([
      'tour.manageAi.title',
      'tour.aiNav.title',
      'tour.aiOverview.title',
      'tour.connectAi.title',
      'tour.aiWizard.title',
      'tour.backDashboard.title',
      'tour.createAgent.title',
      'tour.talk.title',
    ]);
  });
});

describe('API reference docs (#5)', () => {
  it('has unique group ids', () => {
    const ids = API_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate method+path entries within a group', () => {
    for (const group of API_GROUPS) {
      const keys = group.endpoints.map((e) => `${e.method} ${e.path}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('every endpoint has a path, summary, and required params are well-formed', () => {
    for (const group of API_GROUPS) {
      for (const e of group.endpoints) {
        expect(e.path.startsWith('/')).toBe(true);
        expect(e.summary.length).toBeGreaterThan(0);
        for (const p of e.params ?? []) {
          expect(p.name.length).toBeGreaterThan(0);
          expect(p.description.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('documents the OpenAI-compatible completions endpoint', () => {
    const all = API_GROUPS.flatMap((g) => g.endpoints);
    const completions = all.find((e) => e.path === '/v1/chat/completions');
    expect(completions).toBeDefined();
    expect(completions?.method).toBe('POST');
  });

  it('never advertises returning clear-text secrets to the browser', () => {
    // Guard: no param description should claim a key/password/token is returned.
    for (const group of API_GROUPS) {
      for (const e of group.endpoints) {
        const blob = `${e.summary} ${e.response ?? ''} ${(e.params ?? [])
          .map((p) => p.description)
          .join(' ')}`.toLowerCase();
        expect(blob).not.toMatch(/returns? .*\b(api key|password|token)\b/);
      }
    }
  });
});
