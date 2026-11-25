import { MASKED_API_KEY } from '@/shared/types/constants';
import type { Model } from '@/shared/types/model';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { SharedItemKind } from './kinds';

/**
 * The stored item of a kind, in the form the version check compares (#575).
 * Model keys are masked here like the model route masks them, so a version
 * never depends on secret material. Runs in the selected workspace.
 *
 * The services load on first use, so an item route does not pull in the other
 * kinds' services (they are large and only needed in multi-user mode).
 */
export async function loadSharedItem(kind: SharedItemKind, itemId: string): Promise<Record<string, unknown> | null> {
  switch (kind) {
    case 'flow': {
      const { flowService } = await import('@/backend/services/flow');
      const flow = await flowService.getFlow(itemId);
      return flow ? { ...flow } : null;
    }
    case 'model': {
      const { modelService } = await import('@/backend/services/model');
      const model: Model | null = await modelService.getModel(itemId);
      if (!model) return null;
      const masked = { ...model };
      if (masked.ApiKey && !masked.ApiKey.startsWith('${global:')) masked.ApiKey = MASKED_API_KEY;
      return masked;
    }
    case 'mcp-server': {
      const { mcpService } = await import('@/backend/services/mcp');
      const configs = await mcpService.loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error(configs.error || 'Could not read the MCP servers.');
      const config: MCPServerConfig | undefined = configs.find(candidate => candidate.name === itemId);
      return config ? { ...config } : null;
    }
  }
}
