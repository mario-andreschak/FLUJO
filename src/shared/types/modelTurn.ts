import type OpenAI from 'openai';
import type { FlujoChatMessage } from './chat';
import type { VisualCompactionDiagnostic } from './visualArchive';

export type ModelDispatchOutcome = 'running' | 'completed' | 'error' | 'cancelled';

export interface ModelTurnNodeRef {
  nodeId: string;
  nodeName?: string;
}

/** Lightweight entry used by the Chat timeline and durable conversation log. */
export interface ModelTurnIndexEntry {
  id: string;
  conversationId: string;
  runId?: string;
  node: ModelTurnNodeRef;
  modelId: string;
  modelName: string;
  adapter: string;
  operation: string;
  timestamp: number;
  outcome: ModelDispatchOutcome;
  /** 1-based SDK-dispatch ordinal within the outer ModelHandler invocation. */
  attempt: number;
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  canonicalMessageCount: number;
  wireMessageCount: number;
  mediaCount: number;
  archiveVersion: 1;
}

export type ModelTurnMediaKind = 'image' | 'audio' | 'video' | 'file';

/** Binary payload extracted from a provider-native SDK parameter. */
export interface ModelTurnMediaDescriptor {
  id: string;
  parameterPath: string;
  kind: ModelTurnMediaKind;
  mimeType: string;
  byteLength: number;
  sha256: string;
  encoding: 'data-url' | 'base64' | 'file';
  filename?: string;
}

export interface ModelTurnProvenanceEntry {
  id?: string;
  role: string;
  status: 'system' | 'sent' | 'folded' | 'scoped-out' | 'handoff-stripped';
  reason?: string;
  preview?: string;
  toolCallNames?: string[];
}

/** JSON placeholder left where an archived binary string existed. */
export interface ArchivedMediaParameter {
  __flujoArchivedMedia: {
    id: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    encoding: 'data-url' | 'base64' | 'file';
  };
}

export interface ModelTurnSnapshot {
  version: 1;
  entry: ModelTurnIndexEntry;
  /** Lossless node-threaded conversation immediately before wire shaping. */
  canonicalMessages: FlujoChatMessage[];
  /** Final hydrated, provider-neutral messages supplied to the adapter. */
  genericWire: OpenAI.ChatCompletionMessageParam[];
  /** Exact sanitized object handed to the selected SDK/CLI operation. */
  sdkRequest: unknown;
  media: ModelTurnMediaDescriptor[];
  provenance?: ModelTurnProvenanceEntry[];
  counts?: {
    threaded: number;
    sent: number;
    folded: number;
    scopedOut: number;
    handoffStripped: number;
  };
  visualCompaction?: VisualCompactionDiagnostic;
}

export interface ModelTurnTimelineResponse {
  conversationId: string;
  turns: ModelTurnIndexEntry[];
}
