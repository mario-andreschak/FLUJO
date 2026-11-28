/**
 * Where a Connected App (MCP server) is still used, and what the person chose
 * for each place before it is deleted (#1389). Deleting a used app moves every
 * place first and deletes the app last, so nothing is left pointing at an app
 * that is gone.
 */
import type { DeletePlan } from '@/shared/types/deletePlan';

/** How a switched-on automation uses the app. */
export type McpServerAutomationRole =
  /** The automation calls one of the app's tools on a schedule. */
  | 'polls'
  /** The automation waits for an event the app reports. */
  | 'listens';

export type McpServerUsePlace =
  | {
      kind: 'flow';
      flowId: string;
      flowName: string;
      /** How many steps in the flow use the app. */
      steps: number;
      /** Set when the flow is a Persona's own copy. */
      personaName?: string;
    }
  | { kind: 'persona-app'; personaId: string; personaName: string }
  | {
      kind: 'automation';
      executionId: string;
      automationName: string;
      role: McpServerAutomationRole;
      /** Runs a Persona; changing it needs the same local access as the Persona pages. */
      personaControlled: boolean;
    };

export interface McpServerUse {
  /** Stable name of this place. A delete plan answers each place by this key. */
  key: string;
  place: McpServerUsePlace;
  /** Every place may let the app go; kept for the shared plan check. */
  canRemove: true;
}

export interface McpServerUsage {
  serverName: string;
  uses: McpServerUse[];
}

export type McpServerDeletePlan = DeletePlan;

export const MCP_SERVER_IN_USE_CODE = 'MCP_SERVER_IN_USE';

/** 409 answer to a delete while places still use the app, or when they changed since the dialog opened. */
export interface McpServerInUseResponse {
  error: string;
  code: typeof MCP_SERVER_IN_USE_CODE;
  usage: McpServerUsage;
  /** The places changed since the plan was made; the person should look again. */
  changed?: boolean;
}

/** What a delete with a plan changed besides removing the app. */
export interface McpServerDeleteSummary {
  flows: string[];
  personas: string[];
  automations: string[];
  turnedOffAutomations: string[];
}
