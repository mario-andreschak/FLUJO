/**
 * Where a flow is still used, and what the person chose for each place before
 * the flow is deleted (#1389). Deleting a used flow moves every place first and
 * deletes the flow last, so nothing is left pointing at a missing flow.
 */
import { isUseChoice, parseDeletePlan, type DeletePlan, type UseChoice } from '@/shared/types/deletePlan';

/** How an automation uses the flow. */
export type FlowAutomationRole =
  /** The automation runs this flow when it fires. */
  | 'runs'
  /** The automation's AI condition asks this flow whether to fire. */
  | 'checks'
  /** The automation fires when this flow finishes. */
  | 'waits-for';

export type FlowUsePlace =
  | { kind: 'persona-core'; personaId: string; personaName: string }
  | {
      kind: 'persona-behavior';
      personaId: string;
      personaName: string;
      behaviorRef: string;
      behaviorName: string;
      slotKey?: string;
    }
  | {
      kind: 'automation';
      executionId: string;
      automationName: string;
      role: FlowAutomationRole;
      /** Runs a Persona; changing it needs the same local access as the Persona pages. */
      personaControlled: boolean;
    }
  | { kind: 'subflow'; flowId: string; flowName: string };

export interface FlowUse {
  /** Stable name of this place. A delete plan answers each place by this key. */
  key: string;
  place: FlowUsePlace;
  /**
   * The place may give the flow up without getting another one. False for a
   * part the Persona's Role needs: it always needs another flow.
   */
  canRemove: boolean;
  /** Giving the flow up pauses this Persona: it has no main flow left. */
  removePauses: boolean;
  /** A flow that fits here, such as the shared flow a Persona's own copy came from. */
  suggestedFlowId?: string;
}

/**
 * A Persona that runs its own copy of this flow. Only the note of where the
 * copy came from points here, so the delete lets go of that note and the
 * Persona keeps working. Shown for information; no choice is needed.
 */
export interface FlowCopySource {
  personaId: string;
  personaName: string;
}

export interface FlowUsage {
  flowId: string;
  flowName: string;
  /** Places that need a choice before the flow can go. */
  uses: FlowUse[];
  copySources: FlowCopySource[];
}

export type FlowUseChoice = UseChoice;
export type FlowDeletePlan = DeletePlan;

export const FLOW_IN_USE_CODE = 'FLOW_IN_USE';

/** 409 answer to a delete while places still use the flow, or when they changed since the dialog opened. */
export interface FlowInUseResponse {
  error: string;
  code: typeof FLOW_IN_USE_CODE;
  usage: FlowUsage;
  /** The places changed since the plan was made; the person should look again. */
  changed?: boolean;
}

/** What a delete with a plan changed besides removing the flow. */
export interface FlowDeleteSummary {
  personas: string[];
  pausedPersonas: string[];
  automations: string[];
  turnedOffAutomations: string[];
  flows: string[];
}

export const isFlowUseChoice = isUseChoice;
export const parseFlowDeletePlan = parseDeletePlan;
