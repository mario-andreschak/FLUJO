import type { TutorialProgress } from '@/shared/types/storage/storage';

export type BigTutorialAction = 'next' | 'start' | 'send-example' | 'check-apps' | 'finish';

export interface BigTutorialStep {
  id: string;
  path: string;
  route?: (progress: TutorialProgress) => string;
  target?: string | ((progress: TutorialProgress) => string | undefined);
  waitFor?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  title: string | ((progress: TutorialProgress) => string);
  body: string | ((progress: TutorialProgress) => string);
  next?: string;
  back?: string;
  action?: BigTutorialAction;
  actionLabel?: string;
  advanceOnTargetClick?: boolean;
  onEnter?: 'filter-chat-agent' | 'open-chat-flow-picker' | 'prepare-app-picker' | 'open-app-marketplace';
  nested?: 'install-web-app' | 'enable-web-app';
}

const editorRoute = (progress: TutorialProgress) =>
  progress.flowId
    ? `/flows?flow=${encodeURIComponent(progress.flowId)}&mode=edit`
    : '/flows';

const conversationRoute = (progress: TutorialProgress) =>
  progress.conversationId
    ? `/chat?conversation=${encodeURIComponent(progress.conversationId)}`
    : '/chat';

const attrValue = (value?: string) => (value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const BIG_TUTORIAL_STEPS: BigTutorialStep[] = [
  {
    id: 'intro', path: '/', placement: 'center',
    title: 'Give a chat agent internet access',
    body: 'We’ll improve your Chat agent together. By the end, it will be able to look things up on the internet.',
    next: 'go-to-chat', action: 'start', actionLabel: 'Start tutorial',
  },
  {
    id: 'go-to-chat', path: '/', target: '[data-tour="nav-chat"]', placement: 'bottom',
    title: 'Let’s start in Chat',
    body: 'Go to Chat. I’ll use a fresh conversation for this explanation.',
    next: 'new-conversation', back: 'intro', advanceOnTargetClick: true,
  },
  {
    id: 'new-conversation', path: '/chat', target: '[data-tour="chat-new-conversation"]', placement: 'right',
    title: 'Start a new conversation',
    body: 'Choose New conversation so our little experiment stays separate from your other chats.',
    next: 'flow-picker-explain', back: 'go-to-chat', advanceOnTargetClick: true,
  },
  {
    id: 'flow-picker-explain', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-flow-picker"]', placement: 'bottom',
    title: 'This chooses the agent',
    body: 'Different agents can do different things. It all depends on what you set up for them.',
    next: 'open-flow-picker', back: 'new-conversation',
  },
  {
    id: 'open-flow-picker', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-flow-picker"]', placement: 'bottom',
    title: 'Choose the Chat agent',
    body: 'Open the agent picker.',
    next: 'choose-chat', back: 'flow-picker-explain', advanceOnTargetClick: true,
  },
  {
    id: 'choose-chat', path: '/chat', route: conversationRoute,
    target: progress => progress.flowId
      ? `[data-tutorial-flow-id="${attrValue(progress.flowId)}"]`
      : undefined,
    placement: 'right', title: 'Select Chat',
    body: 'There it is. Select the Chat agent for this conversation.',
    next: 'chat-overview', back: 'open-flow-picker', advanceOnTargetClick: true,
    onEnter: 'open-chat-flow-picker',
  },
  {
    id: 'chat-overview', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-flow-picker"]', placement: 'bottom',
    title: 'Ready',
    body: 'This conversation is now using your Chat agent. Let’s see what it can do before we change anything.',
    next: 'send-first-question', back: 'choose-chat',
  },
  {
    id: 'send-first-question', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-input"]', placement: 'top',
    title: 'Try a current-events question',
    body: 'I’ll ask: “Hey! What happened on the internet today?”',
    next: 'wait-for-first-answer', back: 'chat-overview', action: 'send-example', actionLabel: 'Send example',
  },
  {
    id: 'wait-for-first-answer', path: '/chat', route: conversationRoute, placement: 'center',
    waitFor: '[data-tutorial-chat-status="completed"], [data-tutorial-chat-status="error"]',
    title: 'Waiting for the answer…',
    body: 'The tutorial will continue as soon as the Chat agent finishes.',
    next: 'plain-chat', back: 'send-first-question',
  },
  {
    id: 'plain-chat', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-messages"]', placement: 'left',
    title: 'This is a simple chat',
    body: 'It can respond, but it cannot look anything up yet. That’s not a lot.',
    next: 'why-apps', back: 'send-first-question',
  },
  {
    id: 'why-apps', path: '/chat', route: conversationRoute, placement: 'center',
    title: 'Agents can use apps',
    body: 'You might want web search, news, or even a spreadsheet on your computer. We can give an agent access to the apps it needs.',
    next: 'builder-shortcut', back: 'plain-chat',
  },
  {
    id: 'builder-shortcut', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-open-agent"]', placement: 'bottom',
    title: 'A useful shortcut',
    body: 'This button jumps straight into the editor. We could use it, but let’s start from the Agents page so the whole path makes sense.',
    next: 'agents-navigation', back: 'why-apps',
  },
  {
    id: 'agents-navigation', path: '/chat', route: conversationRoute,
    target: '[data-tour="nav-flows"]', placement: 'bottom',
    title: 'Open your Agents page', body: 'Let’s go!',
    next: 'agents-overview', back: 'builder-shortcut', advanceOnTargetClick: true,
  },
  {
    id: 'agents-overview', path: '/flows', target: '[data-tour="agents-search"]', placement: 'bottom',
    title: 'These are your agents',
    body: 'This page keeps every agent you’ve created. Let’s find your Chat agent.',
    next: 'find-chat-agent', back: 'agents-navigation',
  },
  {
    id: 'find-chat-agent', path: '/flows', target: '[data-tour="agents-search"]', placement: 'bottom',
    title: 'Search for Chat', body: 'I’ve narrowed the list down to “Chat” for you.',
    next: 'edit-chat-agent', back: 'agents-overview', onEnter: 'filter-chat-agent',
  },
  {
    id: 'edit-chat-agent', path: '/flows',
    target: progress => progress.flowId
      ? `[data-tutorial-edit-flow-id="${attrValue(progress.flowId)}"]`
      : undefined,
    placement: 'top', title: 'Ah, there it is', body: 'Open the Chat agent for editing.',
    next: 'builder-overview', back: 'find-chat-agent', advanceOnTargetClick: true,
  },
  {
    id: 'builder-overview', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-builder"]', placement: 'center',
    title: 'This is the Flow Builder',
    body: 'An agent is a small sequence of steps. Your Chat agent is intentionally simple.',
    next: 'start-node', back: 'edit-chat-agent',
  },
  {
    id: 'start-node', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-start-node"]', placement: 'right', title: 'It starts here',
    body: 'The Start step is where each new request enters the agent.', next: 'process-node', back: 'builder-overview',
  },
  {
    id: 'process-node', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-process-node"]', placement: 'right', title: 'Then the AI answers',
    body: 'This single AI step is where the magic happens.', next: 'finish-node', back: 'start-node',
  },
  {
    id: 'finish-node', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-finish-node"]', placement: 'right', title: 'Then it finishes',
    body: 'The Finish step sends the result back to the conversation.', next: 'select-process', back: 'process-node',
  },
  {
    id: 'select-process', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-process-node"]', placement: 'right', title: 'Select the AI step',
    body: 'Click the AI step to see its simple settings on the right.',
    next: 'inspector', back: 'finish-node', advanceOnTargetClick: true,
  },
  {
    id: 'inspector', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-inspector"]', placement: 'left', title: 'The settings panel',
    body: 'This is where you tell the selected step what should happen.', next: 'task-prompt', back: 'select-process',
  },
  {
    id: 'task-prompt', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-task-prompt"]', placement: 'left', title: 'The task prompt',
    body: progress => {
      const prompt = progress.taskPrompt?.trim() || 'Reply helpfully to the user.';
      const shortPrompt = prompt.length > 180 ? `${prompt.slice(0, 177)}…` : prompt;
      return `Right now it says: “${shortPrompt}” You can rewrite this in everyday language.`;
    },
    next: 'full-settings', back: 'inspector',
  },
  {
    id: 'full-settings', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-full-settings"], [data-tour="flow-process-node"]', placement: 'left',
    title: 'More settings are available',
    body: 'Double-click the AI step, or choose Full settings here, whenever you need the complete set of options.',
    next: 'connected-apps', back: 'task-prompt',
  },
  {
    id: 'connected-apps', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-connected-apps"]', placement: 'left', title: 'Connect an app here',
    body: 'Down here, you can connect one of your installed apps to this AI step.',
    next: 'open-app-picker', back: 'full-settings',
  },
  {
    id: 'open-app-picker', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-add-app"]', placement: 'left', title: 'Add a web-search app',
    body: 'Choose the + button. I’ll check which installed app is the best fit.',
    next: 'suggest-app', back: 'connected-apps', advanceOnTargetClick: true,
  },
  {
    id: 'suggest-app', path: '/flows', route: editorRoute, placement: 'center',
    title: 'Let me check something real quick',
    body: 'I’ll look at the apps that are actually installed and ask the step helper for a useful web-search option.',
    back: 'open-app-picker', action: 'check-apps', actionLabel: 'Check installed apps',
  },
  {
    id: 'connect-app', path: '/flows', route: editorRoute,
    target: progress => progress.recommendedServerName
      ? `[data-tutorial-server-name="${attrValue(progress.recommendedServerName)}"]`
      : undefined,
    placement: 'left', title: progress => `Use ${progress.recommendedServerName ?? 'this app'}`,
    body: 'Great. Click the app to connect it to this AI step. Its available actions will be included automatically.',
    next: 'wait-for-app-connection', back: 'suggest-app', advanceOnTargetClick: true, onEnter: 'prepare-app-picker',
  },
  {
    id: 'wait-for-app-connection', path: '/flows', route: editorRoute, placement: 'center',
    waitFor: '[data-tutorial-app-connected="true"]', title: 'Connecting the app…',
    body: 'I’ll continue as soon as the app is connected to the AI step.',
    next: 'app-instructions', back: 'connect-app',
  },
  {
    id: 'app-instructions', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-task-prompt"]', placement: 'left', title: 'Optional: give special instructions',
    body: 'If you want, you can add when or how the agent should use this app. The simple prompt is enough for now.',
    next: 'save-agent', back: 'wait-for-app-connection',
  },
  {
    id: 'save-agent', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-save"]', placement: 'bottom', title: 'Save your improved agent',
    body: 'Save the change so Chat can use the connected app.',
    next: 'wait-for-save', back: 'app-instructions', advanceOnTargetClick: true,
  },
  {
    id: 'wait-for-save', path: '/flows', route: editorRoute, placement: 'center',
    waitFor: '[data-tutorial-save-status="saved"]', title: 'Saving…',
    body: 'I’ll continue when the updated agent is safely saved.', next: 'return-to-chat', back: 'save-agent',
  },
  {
    id: 'return-to-chat', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-input"]', placement: 'top', title: 'Let’s see it in action',
    body: 'We’re back in the same conversation. Let’s ask the same question again.',
    next: 'send-second-question', back: 'wait-for-save',
  },
  {
    id: 'send-second-question', path: '/chat', route: conversationRoute,
    target: '[data-tour="chat-input"]', placement: 'top', title: 'Try it again',
    body: 'This time, the agent can use the app you connected.',
    next: 'wait-for-second-answer', back: 'return-to-chat', action: 'send-example', actionLabel: 'Ask again',
  },
  {
    id: 'wait-for-second-answer', path: '/chat', route: conversationRoute, placement: 'center',
    waitFor: '[data-tutorial-chat-status="completed"], [data-tutorial-chat-status="error"]',
    title: 'Waiting for the improved answer…', body: 'The agent may take a little longer while it looks things up.',
    next: 'complete', back: 'send-second-question',
  },
  {
    id: 'complete', path: '/chat', route: conversationRoute, placement: 'center',
    title: 'Much better, isn’t it?',
    body: 'That’s how you edit an agent and connect an app to it. Keep flowing.',
    back: 'send-second-question', action: 'finish', actionLabel: 'Finish Stage 1',
  },

  // Nested prerequisite: install a suitable app. These steps intentionally
  // remain a normal tutorial path, but the overlay displays them one level in.
  {
    id: 'install-app-intro', path: '/mcp', target: '[data-tour="add-mcp-server"]', placement: 'bottom',
    title: 'Add a web-search app',
    body: 'I couldn’t find a working web-search app yet. Open the app setup and we’ll add one.',
    next: 'install-app-marketplace', advanceOnTargetClick: true, nested: 'install-web-app',
  },
  {
    id: 'install-app-marketplace', path: '/mcp', target: '[data-tour="mcp-marketplace-tab"]', placement: 'bottom',
    title: 'Open the Marketplace', body: 'The Marketplace lists apps you can add to FLUJO.',
    next: 'install-app-search', back: 'install-app-intro', advanceOnTargetClick: true,
    onEnter: 'open-app-marketplace', nested: 'install-web-app',
  },
  {
    id: 'install-app-search', path: '/mcp', target: '[data-tour="mcp-marketplace-search"]', placement: 'bottom',
    title: 'Search for web search',
    body: 'Search for “web search” and install a trustworthy option. Finish any setup it asks for, then let me check again.',
    back: 'install-app-marketplace', action: 'check-apps', actionLabel: 'I installed one — check again',
    onEnter: 'open-app-marketplace', nested: 'install-web-app',
  },

  // Nested prerequisite: a useful app exists but is currently switched off.
  {
    id: 'enable-app', path: '/mcp',
    target: progress => progress.recommendedServerName
      ? `[data-tutorial-server-toggle="${attrValue(progress.recommendedServerName)}"]`
      : undefined,
    placement: 'top', title: progress => `Turn on ${progress.recommendedServerName ?? 'the app'}`,
    body: 'The app is installed, but it is switched off. Turn it on so the agent can use it.',
    next: 'enable-app-check', advanceOnTargetClick: true, nested: 'enable-web-app',
  },
  {
    id: 'enable-app-check', path: '/mcp', placement: 'center',
    title: 'Give it a moment to connect',
    body: 'Once it is ready, I’ll check its available actions and take us back to the Chat agent.',
    back: 'enable-app', action: 'check-apps', actionLabel: 'Check the app', nested: 'enable-web-app',
  },
  {
    id: 'return-to-app-picker', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-process-node"]', placement: 'right', title: 'Back to the Chat agent',
    body: 'Select the AI step again, then we’ll connect the app we just prepared.',
    next: 'return-select-process', advanceOnTargetClick: true,
  },
  {
    id: 'return-select-process', path: '/flows', route: editorRoute,
    target: '[data-tour="flow-add-app"]', placement: 'left', title: 'Open the app picker',
    body: 'Choose + one more time.', next: 'connect-app', back: 'return-to-app-picker', advanceOnTargetClick: true,
  },
];

export const BIG_TUTORIAL_STEP_BY_ID = new Map(BIG_TUTORIAL_STEPS.map(step => [step.id, step]));

export function resolveBigTutorialText(
  value: string | ((progress: TutorialProgress) => string),
  progress: TutorialProgress,
): string {
  return typeof value === 'function' ? value(progress) : value;
}

export function resolveBigTutorialTarget(
  step: BigTutorialStep,
  progress: TutorialProgress,
): string | undefined {
  return typeof step.target === 'function' ? step.target(progress) : step.target;
}
