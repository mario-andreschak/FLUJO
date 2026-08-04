export type AskFlujoPageType =
  | 'generic'
  | 'models'
  | 'model'
  | 'flows'
  | 'flow'
  | 'chat';

export interface AskFlujoPageContext {
  /** Stable identity used to prevent applying an action after the user navigates away. */
  scopeId: string;
  pageType: AskFlujoPageType;
  route: string;
  title: string;
  identifiers?: Record<string, string | null | undefined>;
  /** Live, page-owned data. Secrets must be redacted before they enter this object. */
  data: unknown;
  capabilities?: {
    highlightTargets?: unknown[];
    editableTargets?: unknown[];
    notes?: string[];
  };
}

export type AskFlujoActionType = 'highlight' | 'set_value';

export interface AskFlujoActionTarget {
  kind: string;
  id?: string;
  field?: string;
  path?: string;
}

export interface AskFlujoUiAction {
  id: string;
  type: AskFlujoActionType;
  target: AskFlujoActionTarget;
  value?: unknown;
  label?: string;
  evidence?: string;
}

export interface AskFlujoActionResult {
  success: boolean;
  message: string;
}

export type AskFlujoActionHandler = (
  action: AskFlujoUiAction,
) => AskFlujoActionResult | Promise<AskFlujoActionResult>;

