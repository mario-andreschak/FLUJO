jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _setConversationLogDirForTests, allocateSeq, getConversationSequenceDiagnostics, prepareConversationSequence } from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runWithWorkspace } from '@/utils/workspace';
import type { SharedState } from '@/backend/execution/flow/types';

it('bounds real ephemeral/unknown bus owners across workspaces without forgetting any existing high-water mark', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-sequence-owners-'));
  const previous = _setConversationLogDirForTests(directory);
  const existing = { conversationId: 'active-original', status: 'running', ephemeral: true, messages: [], logicalRunId: 'stable-run' } as unknown as SharedState;
  FlowExecutor.conversationStates.set(existing.conversationId!, existing);
  try {
    const max = getConversationSequenceDiagnostics().maxKeys;
    expect(executionEventBus.emit(existing.conversationId!, { type: 'run:start', flowId: 'flow' }).seq).toBe(0);
    for (let index = 1; index < max; index++) {
      runWithWorkspace(index % 2 ? 'alpha' : 'beta', () => {
        expect(allocateSeq(`unknown-${index}`)).toBe(0);
        expect(allocateSeq(`unknown-${index}`)).toBe(1);
      });
    }
    expect(() => executionEventBus.emitterFor('refused-new')({ type: 'run:start', flowId: 'flow' }))
      .toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL', status: 429 }));
    expect(() => prepareConversationSequence('refused-new')).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }));
    expect(FlowExecutor.conversationStates.get(existing.conversationId!)).toBe(existing);
    expect(existing).toMatchObject({ status: 'running', logicalRunId: 'stable-run' });
    expect(executionEventBus.emit(existing.conversationId!, { type: 'run:done', status: 'completed' }).seq).toBe(1);
    expect(runWithWorkspace('alpha', () => allocateSeq('unknown-1'))).toBe(2);
    expect(runWithWorkspace('beta', () => allocateSeq('unknown-2'))).toBe(2);
    expect(getConversationSequenceDiagnostics().keys).toBe(max);
    expect(await fs.readdir(directory)).toEqual([]); // Admission never makes transient/ephemeral work durable.
  } finally {
    FlowExecutor.conversationStates.clear();
    _setConversationLogDirForTests(previous);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('refuses oversized identities before creating or evicting any replay channel', () => {
  const before = executionEventBus.getConversationReplayPressure();
  const keys = getConversationSequenceDiagnostics().keys;
  for (let index = 0; index < 3; index++) {
    expect(() => executionEventBus.emit(`${index}:${'x'.repeat(100_000)}`, { type: 'run:start', flowId: 'flow' }))
      .toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }));
  }
  expect(executionEventBus.getConversationReplayPressure()).toEqual(before);
  expect(getConversationSequenceDiagnostics().keys).toBe(keys);
});
