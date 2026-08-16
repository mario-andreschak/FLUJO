import type { FlujoChatMessage } from './chat';
import type { ModelMediaPart } from './model/media';

export const SUBFLOW_TASK_SCHEME = 'flujo://task/';

export type SubflowTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SubflowTaskHandle {
  version: 1;
  taskId: string;
  uri: string;
  status: SubflowTaskStatus;
  pollInterval: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface SubflowTaskRecord extends SubflowTaskHandle {
  originConversationId: string;
  originNodeId?: string;
  originLogicalRunId?: string;
  flowId: string;
  flowName?: string;
  childConversationId: string;
  input: { prompt: string } | { messages: FlujoChatMessage[] };
  outputText?: string;
  outputMedia?: ModelMediaPart[];
  outputResourceUris?: string[];
  error?: string;
  failureReason?: 'child-error' | 'cancelled' | 'process-restart' | 'timeout';
  expiresAt?: number;
  cancelRequestedAt?: number;
}

export interface SubflowTaskSettings {
  maxConcurrentDetachedJobs: number;
  retentionAgeDays: number;
  defaultPollIntervalMs: number;
  maxJobRuntimeMs: number;
}

export const DEFAULT_SUBFLOW_TASK_SETTINGS: SubflowTaskSettings = {
  maxConcurrentDetachedJobs: 4,
  retentionAgeDays: 7,
  defaultPollIntervalMs: 2_000,
  maxJobRuntimeMs: 30 * 60 * 1_000,
};
