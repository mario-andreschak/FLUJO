// FLUJO has one tool-approval gate (#1284): runFlow pauses a run for a
// decision, or toolApprovalGate.ts asks live, and the chat /respond route, the
// approval inbox and the Human step apply the answer. Copies of this plumbing
// grew a second, silent path more than once: resume routes fell back to
// `requireApproval ?? true` (and a new Human step route copied it), and
// sub-flows ran tools unasked. Adding a decision point is a design change: add
// it to the list below in the same review that changes
// docs/architecture/tool-approval-single-gate-proposal.md.
const GATE = 'src/backend/execution/flow/toolApprovalGate.ts';
const DECISION_POINTS = {
  registerPendingApproval: [GATE],
  withdrawPendingApproval: [GATE],
  resolvePendingApproval: [
    'src/app/v1/chat/conversations/[conversationId]/respond/route.ts',
    'src/backend/services/model/adapters/codexAdapter.ts',
  ],
  clearPendingApprovals: [
    'src/app/v1/chat/conversations/[conversationId]/cancel/route.ts',
    'src/backend/execution/flow/cancellationCoordinator.ts',
  ],
  applyApprovalDecision: [
    'src/app/v1/chat/conversations/[conversationId]/respond/route.ts',
    'src/app/api/approvals/[id]/route.ts',
    'src/backend/services/humanTasks/continueHumanTask.ts',
  ],
};
const ANY_DECISION_POINT = new Set(Object.values(DECISION_POINTS).flat());
const GATE_MODULE = /(^|\/)(toolApprovalRegistry|resumeAfterApproval)$/;
const PAUSE_WRITERS = ['src/backend/execution/flow/runFlow.ts'];
const SETTING_NAMES = new Set(['requireApproval', 'requireToolApproval']);

function repoPath(filename) {
  const normalized = filename.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/src/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function settingName(node) {
  if (node.type === 'Identifier') return SETTING_NAMES.has(node.name) ? node.name : undefined;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return SETTING_NAMES.has(node.property.name) ? node.property.name : undefined;
  }
  if (node.type === 'ChainExpression') return settingName(node.expression);
  return undefined;
}

const isLiteral = (node, value) => node.type === 'Literal' && node.value === value;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep one tool-approval gate: one way to read the setting and fixed decision points' },
    schema: [],
    messages: {
      fallback:
        'Read {{name}} with requireApprovalOf() from @/backend/execution/flow/toolApprovalGate '
        + '(in UI code: `?? false`). A missing setting means approval is off; any other fallback '
        + 'turns approval on or off by surprise.',
      decisionPoint:
        '{{name}} is part of the one tool-approval gate and is only used by its fixed entry points. '
        + 'Ask through createLiveToolApproval/waitForLiveToolDecision, or let runFlow pause the run, '
        + 'instead of adding a second approval path.',
      pauseWriter:
        "Only runFlow pauses a run for approval. Return the calls to runFlow (or ask live through "
        + 'toolApprovalGate.ts) instead of setting this status here.',
    },
  },
  create(context) {
    const file = repoPath(context.filename ?? context.getFilename());
    return {
      LogicalExpression(node) {
        const name = settingName(node.left);
        if (!name) return;
        if ((node.operator === '??' && !isLiteral(node.right, false)) || (node.operator === '||' && isLiteral(node.right, true))) {
          context.report({ node, messageId: 'fallback', data: { name } });
        }
      },
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (!GATE_MODULE.test(source)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            // A namespace or default import reaches every decision point at once.
            if (!ANY_DECISION_POINT.has(file)) context.report({ node: specifier, messageId: 'decisionPoint', data: { name: source } });
            continue;
          }
          const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
          const allowed = DECISION_POINTS[name];
          if (allowed && !allowed.includes(file)) {
            context.report({ node: specifier, messageId: 'decisionPoint', data: { name } });
          }
        }
      },
      ImportExpression(node) {
        const source = node.source.type === 'Literal' ? String(node.source.value) : undefined;
        if (source && GATE_MODULE.test(source) && !ANY_DECISION_POINT.has(file)) {
          context.report({ node, messageId: 'decisionPoint', data: { name: source } });
        }
      },
      AssignmentExpression(node) {
        if (node.left.type !== 'MemberExpression' || node.left.computed) return;
        if (node.left.property.type !== 'Identifier' || node.left.property.name !== 'status') return;
        if (!isLiteral(node.right, 'awaiting_tool_approval')) return;
        if (!PAUSE_WRITERS.includes(file)) context.report({ node, messageId: 'pauseWriter' });
      },
    };
  },
};
