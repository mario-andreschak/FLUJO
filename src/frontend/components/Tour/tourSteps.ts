/**
 * Declarative definition of the first-run guided tour (#4).
 *
 * The tour is a coach-mark walkthrough: it highlights a target element on each
 * page, explains the step, and navigates between pages as the user clicks Next.
 * It guides the full first-run path (model -> MCP server -> flow -> chat) but
 * does not perform the actions for the user, which keeps it robust against UI
 * drift. Targets are matched by a stable `[data-tour="..."]` attribute.
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
    id: 'welcome',
    path: '/',
    placement: 'center',
    title: 'Welcome to FLUJO 👋',
    body:
      "This quick tour walks you through going from zero to a running AI flow.\n\n" +
      "You'll add a model, connect a tool server, build a flow, and run it in chat. " +
      'It takes about a minute — you can skip any time.',
  },
  {
    id: 'add-model',
    path: '/models',
    target: '[data-tour="add-model"]',
    placement: 'bottom',
    title: '1. Add a model',
    body:
      'FLUJO needs at least one AI model to think with. Click "Add Model" to configure one.\n\n' +
      'Tip: an OpenRouter API key gives you access to several free models — paste the key, ' +
      'name the model, pick a free one, and add a custom instruction.',
  },
  {
    id: 'add-mcp-server',
    path: '/mcp',
    target: '[data-tour="add-mcp-server"]',
    placement: 'bottom',
    title: '2. Connect a tool server (MCP)',
    body:
      'MCP servers give your model real tools — file access, image generation, web search, and more.\n\n' +
      'Click "Add Server" and install the "Everything" reference server to try the full range of ' +
      'capabilities while you learn.',
  },
  {
    id: 'new-flow',
    path: '/flows',
    target: '[data-tour="new-flow"]',
    placement: 'bottom',
    title: '3. Build a flow',
    body:
      'A flow wires everything together. Click "New Flow" to open the builder.\n\n' +
      'Connect Start → Process → Finish, attach your model to the Process node, and bind the ' +
      'Everything MCP server so the model can use its tools.',
  },
  {
    id: 'chat-input',
    path: '/chat',
    target: '[data-tour="chat-input"]',
    placement: 'top',
    title: '4. Run it in chat',
    body:
      'Pick your flow from the selector, then send a message here.\n\n' +
      'Try asking it to generate an image with the MCP server and tell you a joke — you\'ll see ' +
      'the flow execute live, step by step.',
  },
  {
    id: 'docs',
    path: '/chat',
    target: '[data-tour="nav-docs"]',
    placement: 'bottom',
    title: 'Need the API?',
    body:
      'FLUJO exposes an OpenAI-compatible API and a full REST surface. The Docs page lists every ' +
      'endpoint with its method, parameters, and response shape.\n\n' +
      "You can re-run this tour any time from Settings → Onboarding.",
  },
  {
    id: 'finish',
    path: '/chat',
    placement: 'center',
    title: "You're all set 🎉",
    body:
      "That's the whole loop: models, tools, flows, and chat.\n\n" +
      'Explore at your own pace — and remember the Docs page and Settings are there when you need them.',
  },
];
