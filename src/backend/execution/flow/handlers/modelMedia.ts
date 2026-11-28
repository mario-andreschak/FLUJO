// Media a model returned: pull generated images out of a reply and save media as run resources.
import { getCurrentWorkspace } from '@/utils/workspace';
import { writeRunResource, getRunResourceLocalPath } from '@/backend/services/runResources';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { extractAssistantMedia, parseDataUrl } from '@/backend/services/model/adapters/messageUtils';
import { commitFlowDurableMutation, rethrowFlowExecutionAuthorityError, type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/modelMedia');

export type GeneratedImagePart = {
  type: 'image_url';
  image_url: { url: string };
};

/**
 * OpenRouter image-capable Chat Completions return generated images beside
 * `content`, in the non-OpenAI `message.images` extension. Keep this boundary
 * tolerant because the OpenAI SDK types intentionally do not declare it.
 */
export function extractGeneratedImageParts(message: unknown): GeneratedImagePart[] {
  return extractAssistantMedia(message).flatMap((part): GeneratedImagePart[] => {
    if (part.type !== 'image') return [];
    const url = part.url ?? (
      part.data
        ? `data:${part.mimeType ?? 'image/png'};base64,${part.data}`
        : undefined
    );
    return url ? [{ type: 'image_url', image_url: { url } }] : [];
  });
}

function mediaResourceKind(part: ModelMediaPart): 'image' | 'audio' | 'blob' {
  if (part.type === 'image') return 'image';
  if (part.type === 'audio') return 'audio';
  return 'blob';
}

export async function persistModelMedia(
  parts: ModelMediaPart[],
  conversationId?: string,
  nodeId?: string,
  durableContext: FlowDurableMutationContext = {},
): Promise<ModelMediaPart[]> {
  const deduped = parts.filter((part, index, all) => {
    const key = `${part.type}|${part.url ?? ''}|${part.data ?? ''}|${part.mimeType ?? ''}`;
    return all.findIndex(candidate =>
      `${candidate.type}|${candidate.url ?? ''}|${candidate.data ?? ''}|${candidate.mimeType ?? ''}` === key
    ) === index;
  });
  if (!conversationId) return deduped;

  return Promise.all(deduped.map(async (part) => {
    const parsed = part.url ? parseDataUrl(part.url) : undefined;
    const data = part.data ?? parsed?.base64;
    const mimeType =
      part.mimeType ??
      parsed?.mimeType ??
      (part.type === 'image' ? 'image/png'
        : part.type === 'audio' ? 'audio/mpeg'
          : part.type === 'video' ? 'video/mp4'
            : 'application/octet-stream');
    if (!data) return { ...part, mimeType };

    try {
      return await commitFlowDurableMutation(durableContext, async () => {
        const written = await writeRunResource({
          conversationId,
          name: part.name,
          mimeType,
          kind: mediaResourceKind({ ...part, mimeType }),
          data: { base64: data },
          producedBy: { source: 'model-output', nodeId },
        });
        if ('skipped' in written) return { ...part, mimeType };
        const localPath = await getRunResourceLocalPath(written.uri);
        return {
          type: mediaTypeFromMime(mimeType),
          mimeType,
          ...(part.name ? { name: part.name } : {}),
          ...(part.transcript ? { transcript: part.transcript } : {}),
          resourceUri: written.uri,
          ...(localPath ? { localPath } : {}),
          url:
            `/v1/chat/conversations/${encodeURIComponent(conversationId)}` +
            `/resources/${encodeURIComponent(written.id)}/content` +
            `?workspace=${encodeURIComponent(getCurrentWorkspace())}`,
        };
      });
    } catch (error) {
      rethrowFlowExecutionAuthorityError(error);
      log.warn('Failed to persist direct model media; keeping it inline', {
        conversationId,
        nodeId,
        type: part.type,
        error,
      });
      return { ...part, mimeType };
    }
  }));
}
