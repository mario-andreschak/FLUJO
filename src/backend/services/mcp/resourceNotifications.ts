import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/resourceNotifications');

/**
 * Register v1-SDK notification handlers for MCP resource events on a v1 Client.
 *
 * - `notifications/resources/list_changed`: increments a per-server version counter
 *   so the frontend can detect that the listing has changed and auto-refresh.
 * - `notifications/resources/updated`: tracks per-URI update events for servers
 *   that support `resources/subscribe` (Phase 3).
 *
 * Call this on the v1 Client AFTER registering request handlers (roots/sampling/
 * elicitation) but BEFORE client.connect(transport). The v2 beta client is wired
 * separately via the `listChanged.resources` option in its constructor (betaClient.ts).
 */
export function registerResourceNotificationHandlers(
  client: Client,
  serverName: string,
  onListChanged: (serverName: string) => void,
  onResourceUpdated?: (serverName: string, uri: string) => void,
): void {
  try {
    client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      (_notification) => {
        log.debug(`resourceListChanged notification received for ${serverName}`);
        onListChanged(serverName);
      },
    );
  } catch (err) {
    // Should not happen with the v1 SDK, but be defensive.
    log.warn(`registerResourceNotificationHandlers: failed to register list_changed for ${serverName}`, err);
  }

  if (onResourceUpdated) {
    try {
      client.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        (notification) => {
          const uri = notification.params?.uri as string | undefined;
          if (uri) {
            log.debug(`resourceUpdated notification received for ${serverName} uri=${uri}`);
            onResourceUpdated(serverName, uri);
          }
        },
      );
    } catch (err) {
      log.warn(`registerResourceNotificationHandlers: failed to register resource_updated for ${serverName}`, err);
    }
  }
}
