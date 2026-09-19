/** Latest individual model request, independent of accumulated run usage. */
export interface ModelContextUsage {
  promptTokens: number;
  completionTokens?: number;
  /** Latest request input + output, when both count toward a shared limit. */
  totalTokens?: number;
  /** Runtime-reported or configured context limit; provenance is recorded below. */
  contextWindow?: number;
  contextWindowSource?: 'runtime' | 'configured';
}

export interface ConversationContextInfo extends Partial<ModelContextUsage> {
  nodeId?: string;
  modelDisplayName?: string;
}
