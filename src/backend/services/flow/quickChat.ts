/**
 * Quick-Chats (issue #61) — backend service.
 *
 * Gathers the current model/server/tool context (the same context flow
 * generation and compilation use) and hands it to the pure
 * {@link synthesizeQuickChatFlow} synthesizer, which builds an ephemeral flow
 * from validated SELECTIONS (never a caller-supplied graph). The resulting flow
 * is run WITHOUT being saved to the flows store — it travels with the
 * conversation state as a `flowSnapshot`.
 */
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { gatherGenerationContext } from './generationContext';
import {
  QuickChatSelection,
  synthesizeQuickChatFlow,
} from '@/utils/shared/quickChat';

const log = createLogger('backend/services/flow/quickChat');

export interface BuildQuickChatSuccess {
  success: true;
  flow: Flow;
}

export interface BuildQuickChatFailure {
  success: false;
  error: string;
  statusCode: number;
}

export type BuildQuickChatResult = BuildQuickChatSuccess | BuildQuickChatFailure;

/**
 * Synthesize (but do not run) a quick-chat flow from selections. Resolves the
 * model and servers against the live configuration; rejects unknown ids and
 * intersects requested tools with what each server exposes.
 */
export async function buildQuickChatFlow(
  selection: QuickChatSelection
): Promise<BuildQuickChatResult> {
  const context = await gatherGenerationContext();
  const result = synthesizeQuickChatFlow(selection, {
    models: context.compile.models ?? [],
    servers: context.compile.servers ?? [],
    serverTools: context.compile.serverTools,
  });

  if (!result.flow) {
    log.info(`Quick-chat synthesis rejected: ${result.error}`);
    return { success: false, error: result.error ?? 'Could not build quick chat', statusCode: 400 };
  }

  log.info(
    `Synthesized quick-chat flow ${result.flow.id} ` +
      `(${result.flow.nodes.length} nodes, ${result.flow.edges.length} edges)`
  );
  return { success: true, flow: result.flow };
}
