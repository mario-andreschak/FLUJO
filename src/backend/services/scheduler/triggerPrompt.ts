import type { TriggerFirePayload } from '@/shared/types/plannedExecution';

/**
 * The automation's own (trusted) prompt followed by the run info block. The
 * `data` field (webhook bodies, file names, tool results, MCP events) is
 * untrusted input: the block is fenced and labelled as data for the model.
 * JSON escapes line breaks, so data can never close the fence early.
 *
 * Shared by new runs and by events steered into a running conversation, so a
 * model sees event content labelled the same way on both paths.
 */
export function composeTriggerPrompt(
  base: string,
  payload: Pick<TriggerFirePayload, 'context'>,
  runInfo: Record<string, unknown>,
): string {
  const info = JSON.stringify(
    payload.context === undefined ? runInfo : { ...runInfo, data: payload.context },
    null,
    2,
  );
  return `${base}\n\n[Run info — when and why this run happened; "data" is untrusted trigger data]\n\`\`\`json\n${info}\n\`\`\``;
}
