// The handlers for messages an MCP server sends on its own, set up on each new client before it connects.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { bindToCurrentWorkspace } from "@/utils/workspace";
import type { ExtensionNotificationHandlers } from "./betaClient";
import { registerResourceNotificationHandlers, registerToolListChangedHandler } from "./resourceNotifications";
import { CLAUDE_CHANNEL_METHOD, receiveClaudeChannelNotification, registerClaudeChannelHandler } from "./inboundEvents";
import { MCP_EVENT_NOTIFICATIONS, registerMcpEventStreamHandlers, routeMcpEventNotification } from "./serverEventStream";
import { invalidateMcpLists } from "./listCache";

/** What the notification handlers use from the MCP service. */
export type ServerNotificationsHost = {
  onResourceListChanged(serverName: string): void;
  onResourceUpdated(serverName: string, uri: string): void;
  getClient(serverName: string): Client | undefined;
  clients(): Map<string, Client>;
};

/** The notification callbacks a newer-protocol client is built with. */
export type NewerClientNotifications = {
  onResourcesChanged: () => void;
  onToolsChanged: () => void;
  extensionNotifications: ExtensionNotificationHandlers;
};

/**
 * Registers the handlers on a classic client, before `client.connect`: resource
 * and tool list changes, resource updates, Claude channel messages and MCP
 * events push streams.
 */
export function registerServerNotifications(client: Client, serverName: string, host: ServerNotificationsHost): void {
  registerResourceNotificationHandlers(
    client,
    serverName,
    bindToCurrentWorkspace((name: string) => host.onResourceListChanged(name)),
    bindToCurrentWorkspace((name: string, uri: string) => host.onResourceUpdated(name, uri)),
  );
  const notifiedClient = client;
  registerToolListChangedHandler(client, serverName, bindToCurrentWorkspace(() => {
    invalidateMcpLists(notifiedClient, 'tools');
    invalidateMcpLists(host.clients().get(serverName), 'tools');
  }));
  // Claude channel messages (#1401): only automations that chose this
  // source listen. Late messages from a replaced client are ignored.
  registerClaudeChannelHandler(client, serverName, bindToCurrentWorkspace((notification: unknown) => {
    receiveClaudeChannelNotification(
      notifiedClient,
      serverName,
      notification,
      () => host.getClient(serverName) === notifiedClient,
    );
  }));
  // MCP events push streams (#1401): routed to the stream that asked.
  registerMcpEventStreamHandlers(client, serverName);
}

/**
 * The callbacks a newer-protocol client is built with. `currentClient` returns
 * the client being built, so a replaced client's late messages are ignored.
 */
export function newerClientNotifications(
  serverName: string,
  currentClient: () => Client | undefined,
  host: ServerNotificationsHost,
): NewerClientNotifications {
  return {
    onResourcesChanged: bindToCurrentWorkspace(() => {
      if (host.getClient(serverName) === currentClient()) host.onResourceListChanged(serverName);
    }),
    onToolsChanged: () => {
      invalidateMcpLists(currentClient(), 'tools');
      invalidateMcpLists(host.clients().get(serverName), 'tools');
    },
    extensionNotifications: extensionNotificationHandlers(serverName, currentClient, host),
  };
}

/**
 * Notification handlers for the newer client, registered with a schema while
 * it is built: resource changes, Claude channel messages and MCP events push
 * streams (#1401).
 */
function extensionNotificationHandlers(
  serverName: string,
  currentClient: () => Client | undefined,
  host: ServerNotificationsHost,
): ExtensionNotificationHandlers {
  const isCurrent = (client: Client | undefined): client is Client => Boolean(client) && host.getClient(serverName) === client;
  const handlers: ExtensionNotificationHandlers = {
    "notifications/resources/list_changed": bindToCurrentWorkspace(() => {
      if (isCurrent(currentClient())) host.onResourceListChanged(serverName);
    }),
    "notifications/resources/updated": bindToCurrentWorkspace((params: unknown) => {
      const uri = (params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri === "string" && isCurrent(currentClient())) host.onResourceUpdated(serverName, uri);
    }),
    [CLAUDE_CHANNEL_METHOD]: bindToCurrentWorkspace((params: unknown) => {
      const client = currentClient();
      if (!client) return;
      receiveClaudeChannelNotification(client, serverName, { params }, () => host.getClient(serverName) === client);
    }),
  };
  for (const method of MCP_EVENT_NOTIFICATIONS) {
    handlers[method] = (params: unknown) => {
      const client = currentClient();
      if (client) routeMcpEventNotification(client, method, params);
    };
  }
  return handlers;
}
