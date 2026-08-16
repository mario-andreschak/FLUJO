import type { Flow } from '@/shared/types/flow/flow';
import type {
  PlannedExecutionStatus,
  RunRecordStatus,
} from '@/shared/types/plannedExecution';
import type { WaveTriggerKind } from './waves';

/**
 * Read-only Automation Playground data model.
 *
 * Unlike the legacy Waves response, this shape keeps each Flow and Planned
 * Execution exactly once. Per-root Wave membership may overlap. Connected
 * components are computed at the Planned Execution level; their Flow
 * projections may overlap when several roots run the same Flow.
 */

export interface AutomationMapPackage {
  name: string;
  version?: string;
  installedAt?: string;
  flowIds: string[];
  executionIds: string[];
}

export interface AutomationMapFlow {
  /** Complete persisted Flow definition, including its nodes and edges. */
  flow: Flow;
  /** User/package organization metadata kept separate from package identity. */
  folder?: string;
  /** Installed-package ledger owners, sorted and de-duplicated. */
  packageNames: string[];
  /** Planned Executions currently bound to this Flow. */
  executionIds: string[];
  /** Per-root Waves in which this Flow participates, including via subflows. */
  waveIds: string[];
  /** Planned-Execution components that project onto this Flow. */
  componentIds: string[];
}

export interface AutomationMapLastRunSummary {
  runId: string;
  firedAt: string;
  finishedAt?: string;
  status: RunRecordStatus;
  triggerSummary: string;
}

export interface AutomationMapScheduleSummary {
  cron?: string;
  timezone?: string;
  nextRun: string | null;
}

/**
 * Minimal, non-secret trigger description needed by the read-only map.
 * Webhook tokens, MCP arguments/evaluation rules, watched paths/URLs, and
 * execution policies deliberately stay server-side.
 */
export type AutomationMapTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'webhook' }
  | { type: 'file-watch' }
  | { type: 'mcp-poll'; serverName: string; toolName: string; cron?: string; timezone?: string }
  | { type: 'url-watch'; cron: string; timezone?: string }
  | {
      type: 'flow-event';
      source: { flowId?: string; flowName?: string; executionId?: string; topic?: string };
      on?: Array<'completed' | 'error'>;
    };

export interface AutomationMapExecution {
  executionId: string;
  name: string;
  flowId: string;
  enabled: boolean;
  folder?: string;
  packageNames: string[];
  /** Sanitized trigger presentation; never contains credentials or payload arguments. */
  trigger: AutomationMapTrigger;
  triggerKind: WaveTriggerKind;
  timezone?: string;
  schedule?: AutomationMapScheduleSummary;
  status: PlannedExecutionStatus;
  lastRun: AutomationMapLastRunSummary | null;
  isRoot: boolean;
  /** Exact persisted Trigger node linked by properties.executionId, when present. */
  triggerNodeId?: string;
  waveIds: string[];
  componentId?: string;
}

export type AutomationMapEndpoint =
  | { kind: 'flow-node'; flowId: string; nodeId: string }
  | { kind: 'flow-boundary'; flowId: string; boundary: 'start' | 'completion' }
  | { kind: 'execution'; executionId: string };

export interface AutomationMapSubflowHop {
  flowId: string;
  nodeId: string;
  targetFlowId: string;
  mode: 'single' | 'parallel';
}

interface AutomationMapRelationBase {
  id: string;
  source: AutomationMapEndpoint;
  target: AutomationMapEndpoint;
  waveIds: string[];
  componentIds: string[];
}

export interface AutomationMapSignalRelation extends AutomationMapRelationBase {
  kind: 'signal';
  topic: string;
  /** Present when this link participates in a scheduled execution chain. */
  producerExecutionId?: string;
  consumerExecutionId: string;
  producerFlowId: string;
  consumerFlowId: string;
  /** False when the exact signal node is reached through one or more subflows. */
  direct: boolean;
  /** Exact static call path from the producer Flow to the emitting Flow. */
  subflowPath: AutomationMapSubflowHop[];
}

export interface AutomationMapCompletionRelation extends AutomationMapRelationBase {
  kind: 'completion';
  /** Absent for a flow-wide listener whose source Flow has no Planned Execution. */
  producerExecutionId?: string;
  consumerExecutionId: string;
  producerFlowId: string;
  consumerFlowId: string;
  on: Array<'completed' | 'error'>;
}

export interface AutomationMapSubflowRelation extends AutomationMapRelationBase {
  kind: 'subflow';
  parentFlowId: string;
  childFlowId: string;
  subflowNodeId: string;
  mode: 'single' | 'parallel';
}

export type AutomationMapRelation =
  | AutomationMapSignalRelation
  | AutomationMapCompletionRelation
  | AutomationMapSubflowRelation;

export interface AutomationMapWaveMembership {
  id: string;
  rootExecutionIds: string[];
  executionIds: string[];
  flowIds: string[];
  relationIds: string[];
  hasCycle: boolean;
}

export interface AutomationMapComponent {
  id: string;
  rootExecutionIds: string[];
  executionIds: string[];
  flowIds: string[];
  relationIds: string[];
  hasCycle: boolean;
}

export interface AutomationMapResponse {
  paused: boolean;
  generatedAt: string;
  packages: AutomationMapPackage[];
  flows: AutomationMapFlow[];
  executions: AutomationMapExecution[];
  relations: AutomationMapRelation[];
  waves: AutomationMapWaveMembership[];
  components: AutomationMapComponent[];
  orphanExecutionIds: string[];
}
