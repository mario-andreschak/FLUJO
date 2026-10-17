import type { Flow } from '@/shared/types/flow';
import type { SharedState } from '@/backend/execution/flow/types';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runSubflowLanes, SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import {
  bindExecutionExtensionRun,
  createExecutionExtensionContext,
  installExecutionExtensionContext,
  prepareExecutionSubflowInput,
  registerExecutionExtension,
  runWithExecutionInput,
  type ExecutionExtensionAdapter,
} from '@/backend/execution/extensions';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import { runWithWorkspace } from '@/utils/workspace';

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: `flow-${id}` })) },
}));

const parentFlow: Flow = {
  id: 'native-subflow-parent', name: 'Native parent', edges: [], nodes: [{
    id: 'native-subflow-node', position: { x: 0, y: 0 },
    data: { label: 'Worker child', type: 'subflow', properties: { subflowId: 'native-subflow-child' } },
  }],
};

test('a Native root can prepare one authorized child lane from its real root context', async () => {
  await runWithWorkspace(`native-subflow-node-${process.pid}`, async () => {
  const rootScope = Object.freeze({});
  const childScope = Object.freeze({});
  const bound = new Map<object, { conversationId: string; runId: string }>();
  const controller = new AbortController();
  let childAdmissions = 0;
  const parentRef: { state?: SharedState } = {};
  const adapter: ExecutionExtensionAdapter = {
    isProtectedServer: () => true,
    assertServerConfig: () => {},
    async assertRun(scope, expected) {
      controller.signal.throwIfAborted();
      const current = bound.get(scope);
      if (!current || expected?.conversationId && expected.conversationId !== current.conversationId
        || expected?.runId && expected.runId !== current.runId) throw new Error('stale Native root');
    },
    async bindRun(scope, conversationId, runId) { bound.set(scope, { conversationId, runId }); },
    signal: () => controller.signal,
    async commit(_scope, task) { return task(); },
    protectedServer: () => 'native-worker-tools',
    authorizeHandoffs: () => {},
    async subflowCapacity(scope, nodeId) {
      await this.assertRun(scope, { conversationId: 'native-root-conversation', runId: 'native-root-logical' });
      return scope === rootScope && nodeId === 'native-subflow-node' ? 1 : undefined;
    },
    async prepareSubflow(scope, input) {
      await this.assertRun(scope);
      const parent = parentRef.state;
      const invocation = parent?.subflowInvocations?.[input.lane?.invocationId ?? ''];
      const lane = invocation?.lanes.find(item => item.id === input.lane?.laneId);
      if (scope !== rootScope || input.parentRunId !== 'native-root-conversation'
        || input.flowId !== 'native-subflow-child' || input.source !== 'subflow'
        || input.mode !== 'conversation' || !invocation || invocation.status !== 'running'
        || invocation.lanes.length !== 1 || !lane || lane.status !== 'running'
        || lane.attempt !== 1 || lane.conversationId !== input.conversationId) {
        throw new Error('unplanned Native child');
      }
      childAdmissions += 1;
      return childScope;
    },
    async nativeWorkerRoot(scope) {
      await this.assertRun(scope);
      return scope === rootScope ? { version: 1 } as never : undefined;
    },
    assertModelTool: async () => {},
    assertDispatch: async () => {},
    normalizeArguments: (_scope, _tool, args) => args,
    requestMeta: async () => ({}),
    validateResult: (_scope, _tool, result) => result,
  };
  const restore = registerExecutionExtension(adapter);
  const parent = {
    conversationId: 'native-root-conversation',
    logicalRunId: 'native-root-logical',
    flowId: parentFlow.id,
    flowSnapshot: parentFlow,
    source: 'api',
    status: 'running',
    runDepth: 0,
    messages: [{ role: 'user', content: 'Do the authorized child task' }],
    trackingInfo: { nodeExecutionTracker: [] },
  } as unknown as SharedState;
  parentRef.state = parent;
  const context = createExecutionExtensionContext(adapter, rootScope);
  FlowExecutor.conversationStates.set(parent.conversationId!, parent);
  try {
    await bindExecutionExtensionRun(context, parent.conversationId!, parent.logicalRunId!);
    installExecutionExtensionContext(parent, context);
    parent.handoffInput = { targetNodeId: 'native-subflow-node', prompt: '', tasks: ['Do the authorized child task'] };
    const prep = await new SubflowNode().prep(parent, {
      id: 'native-subflow-node', type: 'subflow',
      properties: { subflowId: 'native-subflow-child', saveConversation: true },
    } as never);

    expect(prep.lanes).toHaveLength(1);
    expect(prep.concurrencyLimit).toBe(1);
    expect(prep.persistConversation).toBe(true);
    expect(prep.invocationId).toBeDefined();
    expect(parent.handoffInput).toBeUndefined();
    expect(parent.subflowInvocations?.[prep.invocationId!]).toMatchObject({
      status: 'running', parentNodeId: 'native-subflow-node', concurrencyLimit: 1,
      lanes: [{ status: 'pending', attempt: 0, subflowId: 'native-subflow-child' }],
    });

    const childRun = jest.fn(async (input: FlowRunInput) => {
      expect(input.executionExtensionContext).toBeUndefined();
      const childInput = await prepareExecutionSubflowInput(input);
      expect(childInput?.executionExtensionContext).toBeDefined();
      expect(childInput?.executionExtensionContext).not.toBe(context);
      await bindExecutionExtensionRun(childInput!.executionExtensionContext!, input.conversationId!, 'native-child-logical');
      expect(input.lane).toMatchObject({
        invocationId: prep.invocationId,
        laneId: prep.lanes![0].laneId,
        parentNodeId: 'native-subflow-node',
      });
      return { status: 'completed', outputText: 'Authorized child complete' } as never;
    });
    const execution = await runWithExecutionInput({ executionExtensionContext: context,
      conversationId: parent.conversationId, runId: parent.logicalRunId }, () =>
      runSubflowLanes(prep, childRun as never, { nodeId: 'native-subflow-node', nodeType: 'subflow' },
        { prompt: 'Do the authorized child task' }));
    expect(childRun).toHaveBeenCalledTimes(1);
    expect(childAdmissions).toBe(1);
    expect(execution).toMatchObject({ success: true, lanes: [{ success: true, outputText: 'Authorized child complete' }] });
    expect(parent.subflowInvocations?.[prep.invocationId!]?.lanes[0]).toMatchObject({ status: 'completed', attempt: 1 });
    await expect(runWithExecutionInput({ executionExtensionContext: context,
      conversationId: parent.conversationId, runId: parent.logicalRunId }, () =>
      runSubflowLanes({ ...prep }, childRun as never,
        { nodeId: 'native-subflow-node', nodeType: 'subflow' }, { prompt: 'replay attempt' })))
      .rejects.toMatchObject({ code: 'execution_subflow_child_authority_required' });
    expect(childRun).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    FlowExecutor.conversationStates.delete(parent.conversationId!);
    restore();
  }
  });
});
