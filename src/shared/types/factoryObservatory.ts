/** Read-only FACTORY snapshot shown by the Wave Observatory. */
export interface FactoryObservatorySnapshot {
  factoryId: string;
  observedAt: string;
  revision: number;
  mission: string;
  status: 'active' | 'paused';
  cells: Array<{ id: string; parentId: string | null; depth: number; role: string; status: string; purpose: string }>;
  tasks: Array<{ id: string; owner: string | null; status: string; projectId: string }>;
  unresolvedEffects: number;
}
