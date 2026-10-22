export interface BehaviorToolTarget {
  personaId: string;
  behaviorId: string;
  name: string;
  description: string;
}

export type BehaviorToolRegistry = Record<string, BehaviorToolTarget>;
