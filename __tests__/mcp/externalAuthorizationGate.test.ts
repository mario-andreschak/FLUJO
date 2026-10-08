jest.mock("@/backend/utils/resolveGlobalVars", () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));

jest.mock("@/backend/services/mcp/config", () => ({
  loadServerConfigs: jest.fn(async () => [
    {
      name: "gated-server",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: {},
      disabled: false,
    },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock("@/backend/services/mcp/tools", () => ({
  listServerTools: jest.fn(),
  callTool: jest.fn(async () => ({ success: true, data: "called" })),
}));

jest.mock("@/backend/services/mcp/connection", () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(() => ({})),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPService } from "@/backend/services/mcp";
import { callTool as dispatchTool } from "@/backend/services/mcp/tools";
import { registerExternalAuthorizationClient } from "@/backend/services/mcp/externalAuthorization";
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
} from "mcp-stdio-oauth/protocol";

const dispatchToolMock = dispatchTool as unknown as jest.Mock;

function connectedClient(state: string): Client {
  const client = {
    getServerCapabilities: () => ({
      extensions: {
        [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY,
      },
    }),
    registerCapabilities: jest.fn(),
    request: jest.fn(async () => ({
      authorizations: [
        {
          id: "google-workspace",
          label: "Google Workspace",
          state,
          blocksUnattendedUse: true,
        },
      ],
    })),
  } as unknown as Client;
  registerExternalAuthorizationClient(client, "gated-server");
  return client;
}

beforeEach(() => {
  global.__mcp_clients?.clear();
  global.__mcp_external_authorization_status?.clear();
  dispatchToolMock.mockClear();
});

describe("MCPService external authorization dispatch gate", () => {
  it("blocks before tool dispatch when unattended use is not ready", async () => {
    global.__mcp_clients!.set(
      "gated-server",
      connectedClient("authorization_required"),
    );
    const service = new MCPService();

    const result = await service.callTool("gated-server", "send_email", {});

    expect(result).toMatchObject({
      success: false,
      errorType: "stdio-oauth-required",
      requiresAuthentication: true,
    });
    expect(dispatchToolMock).not.toHaveBeenCalled();
  });

  it("dispatches normally after the requirement reports ready", async () => {
    global.__mcp_clients!.set("gated-server", connectedClient("ready"));
    const service = new MCPService();

    const result = await service.callTool("gated-server", "send_email", {});

    expect(result).toEqual({ success: true, data: "called" });
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
  });
});
